/**
 * Initialize a repository with OpenSpec, the orqen kit, and an environment configuration.
 * Automatic detection and optional AI analysis propose a stack for the user to confirm.
 * The CLI writes the configuration (with the command that starts each part of the project) and the workflow templates.
 * No Docker in between.
 */
import { basename, resolve } from "node:path";
import { agentesInstalados, comandoRapido, explorarConAgente, explorarRapidoAislado, type ResultadoExploracion } from "../lib/agent.ts";
import { ARCHIVO_CONFIG, ARCHIVO_ENTORNO, entornosDesdeStack, escribirConfig, existeConfig, leerConfig, type Config } from "../lib/config.ts";
import { detectar } from "../lib/detect.ts";
import { checkSummary, missingSecrets, setupConnectorsStep } from "../lib/connectors-setup.ts";
import { checkDraft, parseDraft, type Draft } from "../lib/connectors-edit.ts";
import { providerEnv, providerFile, saveProviders } from "../lib/provider-credentials.ts";
import { aplicar, marketplace, planificar, type Cambio, type Decision, MARKETPLACE } from "../lib/kit.ts";
import {
  estadoOpenSpec, esRepoNode, inicializarOpenSpec, instalarOpenSpec,
  RANGO_OPENSPEC, ultimaVersionOpenSpec, VERSION_MINIMA, type Instalacion,
} from "../lib/openspec.ts";
import { chequearSistema, ramaBase, VERSION_CLI } from "../lib/system.ts";
import { resumenStack, type Stack } from "../lib/stack.ts";
import { ProcesoEntorno } from "../lib/processes.ts";
import { PROCESO_DB } from "../lib/tools.ts";
import { mostrarLogo } from "../ui/logo.ts";
import {
  azul, confirmar, diffColoreado, elegir, elegirVarios, gris, interactivo, magenta, p, pc, salirSiCancela, secreto, texto, textoValidado, tick,
} from "../ui/console.ts";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface OpcionesInit {
  dir?: string;
  yes?: boolean;
  sinIa?: boolean;
  /** Use the agent's tools for an in-depth repository analysis. */
  profundo?: boolean;
  sinAnimacion?: boolean;
  agente?: string;
  sinOpenspec?: boolean;
  herramientas?: string[];
  /** Called from `orqen bootstrap`: the logo was already shown. */
  sinLogo?: boolean;
  /** Skip the connectors step (keep the ones the repository already has). */
  sinConectores?: boolean;
  /** Commit what init wrote (without asking). Interactively init asks; with --yes it only commits with --commit. */
  commit?: boolean;
  /** Connectors draft as JSON ({"conectores": …, "env": …}, like `orqen connectors set`): a file path or "-" for stdin. */
  conectores?: string;
  /** Stack and environments already known (from a tool): skip detection, AI analysis and review. */
  predefinido?: { stack: Stack; entornos: Config["entornos"] };
}

const HERRAMIENTAS_OPENSPEC = [
  { value: "claude", label: "Claude Code" },
  { value: "codex", label: "Codex" },
  { value: "cursor", label: "Cursor" },
  { value: "github-copilot", label: "GitHub Copilot" },
  { value: "gemini", label: "Gemini CLI" },
  { value: "opencode", label: "OpenCode" },
  { value: "devin", label: "Windsurf / Devin" },
  { value: "kilocode", label: "Kilo Code" },
  { value: "roocode", label: "Roo Code" },
  { value: "cline", label: "Cline" },
];

export async function init(o: OpcionesInit) {
  const repo = resolve(o.dir ?? process.cwd());
  let yes = !!o.yes;
  if (!o.sinLogo) await mostrarLogo({
    animar: !o.sinAnimacion && !o.yes, esperarTecla: true,
    bienvenida: [
      "Initialization will:",
      "  • Detect the stack and propose environments with your AI agent",
      "  • Install and configure OpenSpec",
      "  • Connect where the requests and issues live (Jira, GitHub or Asana)",
      "  • Prepare the repository for agents to work independently",
    ],
  });
  p.intro(`${azul("orqen")} ${magenta("init")} ${gris(`v${VERSION_CLI} · ${repo}`)}`);
  if (!yes && !interactivo()) { p.log.warn("Non-interactive terminal. Using defaults as with --yes."); yes = true; }

  // 1. Check prerequisites.
  const chequeos = chequearSistema(repo);
  p.note(chequeos.map((c) => `${tick(c.ok, c.requerido)} ${c.nombre.padEnd(11)} ${gris(c.detalle)}`).join("\n"), "Environment");
  const faltan = chequeos.filter((c) => c.requerido && !c.ok);
  if (faltan.length) {
    p.cancel(faltan.map((c) => `${c.nombre}: ${c.ayuda ?? c.detalle}`).join("\n"));
    process.exitCode = 1;
    return;
  }
  for (const c of chequeos.filter((c) => !c.requerido && !c.ok)) p.log.warn(`${c.nombre}: ${c.ayuda}`);

  if (existeConfig(repo)) {
    p.log.warn(`This repository already has ${ARCHIVO_CONFIG}. Update the kit with ${pc.bold("orqen update")}.`);
    if (!(await confirmar("Initialize again and review conflicts in edited files?", false, yes))) {
      p.outro("No changes made.");
      return;
    }
  }

  // 2. Detect the stack and analyze it with AI when requested (unless it comes from a tool).
  const s = p.spinner();
  const pre = o.predefinido;
  if (!pre) s.start("Inspecting manifests, scripts, and dependencies…");
  const deteccion = pre ? { stack: pre.stack, evidencias: [] } : detectar(repo);
  if (!pre) s.stop(`Automatic detection: ${deteccion.stack.componentes.length} component(s), ${deteccion.stack.servicios.length} service(s)`);
  if (deteccion.evidencias.length) p.log.message(gris(deteccion.evidencias.slice(0, 15).map((e) => `· ${e}`).join("\n") + (deteccion.evidencias.length > 15 ? `\n· … ${deteccion.evidencias.length - 15} more` : "")));

  let stack: Stack = deteccion.stack;
  let comandoAgente: string | undefined = o.agente;
  const agentes = agentesInstalados();
  if (pre) comandoAgente ??= agentes[0]?.comando;
  else if (!o.sinIa) {
    if (!comandoAgente) {
      if (!agentes.length) p.log.warn("No installed AI agent was found (claude, codex, gemini). Using automatic detection.");
      else {
        const eleccion = await elegir(
          "Which agent should analyze the repository and propose environments?",
          [
            ...agentes.map((a) => ({ value: a.id, label: a.nombre, hint: a.comando })),
            { value: "__otro", label: "Custom command…" },
            { value: "__ninguno", label: "None (automatic detection only)" },
          ],
          agentes[0].id, yes,
        );
        if (eleccion === "__otro") comandoAgente = await texto("Headless command (prompt via stdin or the {prompt} placeholder)", "claude -p --permission-mode acceptEdits", yes);
        else if (eleccion !== "__ninguno") comandoAgente = agentes.find((a) => a.id === eleccion)!.comando;
      }
    }
  }

  // Quick analysis runs in the background while OpenSpec is configured.
  const inicioIa = Date.now();
  let enCurso: Promise<ResultadoExploracion> | undefined;
  if (comandoAgente && !o.profundo && !pre) {
    // Isolate analysis from the terminal so it cannot interfere with prompts.
    enCurso = explorarRapidoAislado(repo, comandoRapido(comandoAgente), deteccion).resultado;
    p.log.step(`${comandoAgente.split(" ")[0]} is analyzing the stack in the background.`);
  } else if (comandoAgente && !pre) {
    stack = (await explorarAFondo(repo, comandoAgente, deteccion)) ?? stack;
  }

  // 3. Configure OpenSpec and the base branch while analysis runs.
  const nombre = basename(repo).toLowerCase().replace(/[^a-z0-9-]+/g, "-") || "project";
  let openspecCfg: Config["openspec"] = { instalacion: esRepoNode(repo) ? "devDependency" : "global", herramientas: [] };
  if (!o.sinOpenspec) openspecCfg = await prepararOpenSpec(repo, agentes.map((a) => a.id), o.herramientas, yes);
  const rama = await texto("Base branch for request branches and pull requests", ramaBase(repo), yes);

  const previous = existeConfig(repo) ? leerConfig(repo) : undefined;

  // Connectors: what goes in config.yaml (project, filter…) and the provider accounts, shared by this user's repositories.
  const conectores = await prepararConectores(repo, previous?.conectores, o, yes);

  // 4. Review the proposal.
  if (enCurso) {
    s.start("Finishing stack analysis…");
    const reloj = setInterval(() => s.message(`Finishing stack analysis… ${Math.round((Date.now() - inicioIa) / 1000)}s`), 1000);
    const r = await enCurso;
    clearInterval(reloj);
    if (r.ok && r.stack) { stack = r.stack; s.stop(`Agent proposal ready (${Math.round((Date.now() - inicioIa) / 1000)}s)`); }
    else {
      s.error("The agent returned an invalid proposal. Using automatic detection.");
      if (r.errores.length) p.log.message(gris(r.errores.slice(0, 5).join("\n")));
    }
  }
  for (; !pre;) {
    const r = await revisarStack(stack, yes, !!comandoAgente);
    if (r !== "profundo") { stack = r; break; }
    stack = (await explorarAFondo(repo, comandoAgente!, deteccion)) ?? stack;
  }

  // 5. Write configuration and kit files.
  const config: Config = {
    version: 1,
    orqen: { cli: VERSION_CLI, kit: VERSION_CLI },
    proyecto: { nombre, rama_base: rama || "main" },
    agente: { comando: comandoAgente },
    openspec: openspecCfg,
    stack,
    ...(conectores?.conectores ?? previous?.conectores ? { conectores: conectores?.conectores ?? previous?.conectores } : {}),
    ...(previous?.general ? { general: previous.general } : {}),
    // how the flow works (shared): kept as is, or the defaults written out so the team sees what can be set
    flujo: previous?.flujo ?? { soporte: false, aprobadores: { analisis: [], qa: [], codigo: [], cliente: [], ejecucion: [] }, code_review: { gate: "github", revisores: [] }, rama_desarrollo: "desarrollo" },
    entornos: pre ? pre.entornos : entornosDesdeStack(stack),
  };
  const vars = { RESUMEN_STACK: resumenStack(stack), BASE_BRANCH: config.proyecto.rama_base, AGENT_CMD: comandoAgente ? `${comandoAgente}` : "claude -p --permission-mode acceptEdits" };
  // Review how each part of the project starts before writing anything.
  if (!pre) config.entornos = await revisarProcesos(config.entornos, yes);
  // Existing project-local scripts can be reused without consulting a stack catalog.
  if (!pre) reutilizarDb(repo, config);

  const plan = planificar(repo, vars);
  p.note(resumenPlan(plan, config), "Files to write");
  if (!(await confirmar("Write these files?", true, yes))) { p.outro("Canceled. The kit was not written."); return; }

  if (conectores) {
    saveProviders(conectores.conectores, conectores.env, providerEnv(repo));
    p.log.success(`Connectors saved ${gris(`(provider accounts for this user in ${providerFile()})`)}`);
  }
  escribirConfig(repo, config);
  const res = await aplicar(repo, plan, (c) => resolverConflicto(c, yes));
  const env = providerEnv(repo);
  const faltanEnv = config.conectores ? missingSecrets(config.conectores, env) : [];
  const lado = res.filter((r) => r.accion === "guardado-al-lado");
  p.log.success(`${ARCHIVO_CONFIG}, ${ARCHIVO_ENTORNO} and kit v${VERSION_CLI} installed`);
  for (const r of lado) p.log.warn(`${r.ruta}: the proposed version is in ${r.detalle} for you to merge`);

  const commiteado = await commitInstall(repo, o.commit, yes);
  const mk = marketplace(existsSync(join(repo, MARKETPLACE)) ? readFileSync(join(repo, MARKETPLACE), "utf8") : undefined).nombre;
  const pasos = [
    ...(!config.conectores ? [`Connect where the tickets live: ${pc.cyan("orqen connectors setup")} (Jira, GitHub or Asana).`] : []),
    ...(faltanEnv.length ? [`Complete the provider accounts with ${pc.cyan("orqen connectors setup")}: missing ${faltanEnv.join(", ")}. These accounts are shared across your repositories.`] : []),
    `Review ${pc.cyan(ARCHIVO_CONFIG)} and ${pc.cyan(ARCHIVO_ENTORNO)}, then try: ${pc.cyan("orqen env up")} · ${pc.cyan("orqen env test")} · ${pc.cyan("orqen env down")}`,
    `Open Claude Code in this folder (restart it if it was open) and accept ${pc.bold("Trust this folder")}: ` +
      `the commands appear as ${pc.cyan("/orqen:tutorial")} (start here if you are new), ${pc.cyan("/orqen:support")}, ${pc.cyan("/orqen:analyze")}, ${pc.cyan("/orqen:list")}, ${pc.cyan("/orqen:implement")}, ${pc.cyan("/orqen:pr")}, ${pc.cyan("/orqen:review")} (QA), ${pc.cyan("/orqen:approve")} ` +
      gris(`(type /orqen: to list them; check with /plugin → orqen@${mk})`),
    ...(!commiteado ? [`Commit the changes (orqen/, .claude/, .claude-plugin/, AGENTS.md, CLAUDE.md, openspec/) so the team gets the same commands: ${pc.cyan('git add -A && git commit -m "Install orqen"')}`] : []),
  ];
  if (o.sinLogo) return;   // `orqen bootstrap` shows its own next steps
  p.note(pasos.map((x, i) => `${pc.bold(`${i + 1}.`)} ${x}`).join("\n"), "Next steps");
  p.outro(`${magenta("//")} ${pc.bold("From request to production.")}`);
}

const INSTALLED = ["orqen", ".claude", ".claude-plugin", "AGENTS.md", "CLAUDE.md", ".gitignore", "openspec"];

/**
 * Commits what init wrote (the team gets the same commands, and the first `orqen take` can switch branches). Only those
 * paths: nothing else the person had changed or staged. Asks when interactive; --yes only does it with --commit.
 */
async function commitInstall(repo: string, commit: boolean | undefined, yes: boolean): Promise<boolean> {
  if (!commit && (yes || !(await confirmar("Commit the files orqen just wrote (orqen/, .claude/, AGENTS.md…)?", true, false)))) return false;
  const paths = INSTALLED.filter((x) => existsSync(join(repo, x)));
  try {
    execFileSync("git", ["add", "--", ...paths], { cwd: repo, stdio: "pipe" });
    execFileSync("git", ["commit", "-q", "-m", "Install orqen", "--", ...paths], { cwd: repo, stdio: "pipe" });
    p.log.success("Committed: Install orqen");
    return true;
  } catch (e) {
    p.log.warn(`Could not commit (${((e as { stderr?: Buffer }).stderr?.toString() || (e as Error).message).trim().split("\n")[0]}): commit the files by hand.`);
    return false;
  }
}

/** Connectors step: from --connectors (JSON), interactively, or kept as they were (--yes, --no-connectors). */
async function prepararConectores(repo: string, prev: Config["conectores"], o: OpcionesInit, yes: boolean): Promise<Draft | undefined> {
  if (o.sinConectores) return undefined;
  const env = providerEnv(repo);
  if (o.conectores) {
    const draft = parseDraft(JSON.parse(readFileSync(o.conectores === "-" ? 0 : resolve(o.conectores), "utf8")));
    const s = p.spinner();
    s.start("Checking the connectors…");
    const result = await checkDraft(draft, env).catch((e) => [{ role: "requests" as const, configured: true, ok: false, detail: (e as Error).message }]);
    const ok = result.every((r) => !r.configured || r.ok);
    s.stop(ok ? "Connectors checked" : "Some connectors could not be checked; they are saved anyway");
    p.note(checkSummary(result), "Connectors");
    return draft;
  }
  if (yes) return undefined;
  return setupConnectorsStep(repo, prev, env);
}

/** Let the agent inspect the repository directly. */
async function explorarAFondo(repo: string, comando: string, deteccion: { stack: Stack; evidencias: string[] }): Promise<Stack | undefined> {
  const s = p.spinner();
  const inicio = Date.now();
  s.start("The agent is exploring the repository (this can take a few minutes)…");
  const reloj = setInterval(() => s.message(`The agent is exploring the repository… ${Math.round((Date.now() - inicio) / 1000)}s`), 1000);
  const r = await explorarConAgente(repo, comando, deteccion, {
    alReintentar: (e) => s.message(`The proposal failed validation (${e.length} error(s). Retrying…`),
  });
  clearInterval(reloj);
  if (r.ok && r.stack) { s.stop(`Repository analysis complete (${Math.round((Date.now() - inicio) / 1000)}s)`); return r.stack; }
  s.error("The agent returned an invalid proposal. Keeping the previous one.");
  if (r.errores.length) p.log.message(gris(r.errores.slice(0, 8).join("\n")));
  return undefined;
}

async function revisarStack(stack: Stack, yes: boolean, hayAgente: boolean): Promise<Stack | "profundo"> {
  p.note(resumenStack(stack), "Proposed stack");
  const accion = await elegir("How would you like to proceed?", [
    { value: "ok", label: "Accept the proposal" },
    { value: "ajustar", label: "Edit components and test commands" },
    ...(hayAgente ? [{ value: "profundo", label: "Let the agent explore the repository in depth", hint: "More detail, takes a few minutes" }] : []),
  ], "ok", yes);
  if (accion === "ok") return stack;
  if (accion === "profundo") return "profundo";

  const comps = await elegirVarios("Components to include",
    stack.componentes.map((c) => ({ value: c.nombre, label: `${c.nombre} ${gris(`(${c.ruta})`)}`, hint: [c.tipo, c.framework ?? c.lenguaje].join(" · ") })),
    stack.componentes.map((c) => c.nombre), false);
  const tests = { ...stack.tests };
  for (const k of ["unitarios", "integracion", "e2e", "visual"] as const) {
    tests[k] = (await texto(`Test command for ${({ unitarios: "unit", integracion: "integration" } as Record<string, string>)[k] ?? k} tests (leave blank to skip)`, tests[k] ?? "", false)) || undefined;
  }
  const migraciones = (await texto("Migration command (leave blank to skip)", stack.migraciones ?? "", false)) || undefined;
  const seed = (await texto("Seed command for test data (leave blank to skip)", stack.seed ?? "", false)) || undefined;
  const r: Stack = {
    ...stack,
    componentes: stack.componentes.filter((c) => comps.includes(c.nombre)),
    tests, migraciones, seed,
  };
  p.note(resumenStack(r), "Final stack");
  return r;
}

/** Show how each part of the project starts and let the person fix the command, directory, port, and when it runs. */
async function revisarProcesos(e: Config["entornos"], yes: boolean): Promise<Config["entornos"]> {
  const linea = (x: ProcesoEntorno) => `${x.nombre}: ${x.comando}${x.ruta !== "." ? gris(` (in ${x.ruta})`) : ""}${x.puerto ? gris(` → :${x.puerto}`) : ""}${x.cuando === "e2e" ? gris("  [e2e only]") : ""}`;
  p.note(e.procesos.length
    ? e.procesos.map(linea).join("\n") + "\n\n" + gris("orqen starts them when needed (orqen take / orqen env up) and stops them afterwards.")
    : gris("Could not find how to start the project (no dev/start script). You can add it under processes in orqen/environment.yaml."),
  "How the project starts");
  if (yes || !e.procesos.length) return e;
  if (!(await confirmar("Do you want to change any command?", false, false))) return e;
  const procesos: ProcesoEntorno[] = [];
  for (const x of e.procesos) {
    const comando = await texto(`${x.nombre}: command ${gris("(leave blank to skip it)")}`, x.comando, false);
    if (!comando) continue;
    const ruta = (await texto(`${x.nombre}: directory where it runs`, x.ruta, false)) || ".";
    const puertoTxt = await texto(`${x.nombre}: port it opens ${gris("(blank = no port; waits a few seconds)")}`, x.puerto ? String(x.puerto) : "", false);
    const cuando = await elegir(`${x.nombre}: when should it run?`, [
      { value: "siempre", label: "Always", hint: "for development and tests" },
      { value: "e2e", label: "Only for e2e / visual tests" },
    ], x.cuando, false);
    procesos.push({ ...x, comando, ruta, puerto: Number(puertoTxt) || undefined, cuando });
  }
  return { ...e, procesos };
}

async function prepararOpenSpec(repo: string, agentes: string[], herramientasPedidas: string[] | undefined, yes: boolean): Promise<Config["openspec"]> {
  const s = p.spinner();
  s.start("Checking OpenSpec…");
  const est = estadoOpenSpec(repo);
  const ultima = ultimaVersionOpenSpec(repo);
  s.stop(est.version
    ? `OpenSpec ${est.version} (${est.instalacion === "global" ? "global" : "devDependency"})${est.compatible ? "" : pc.red(` — incompatible, orqen requires ${RANGO_OPENSPEC}`)}${ultima && est.compatible && ultima !== est.version ? gris(` · available version ${ultima}: \`orqen update\``) : ""}`
    : "OpenSpec is not installed");

  let instalacion: Instalacion = est.instalacion ?? (esRepoNode(repo) ? "devDependency" : "global");
  let versionFinal = est.version ?? undefined;
  if (!est.version || !est.compatible) {
    const objetivo = ultima ?? VERSION_MINIMA;
    if (!esRepoNode(repo)) p.log.info("No package.json found. OpenSpec will be installed globally.");
    const ok = await confirmar(`Install OpenSpec ${objetivo} as ${instalacion === "devDependency" ? "a repository dev dependency" : "a global package"}?`, true, yes);
    if (!ok) { p.log.warn("The lightweight and full lanes require OpenSpec."); return { instalacion, version: est.version ?? undefined, herramientas: [] }; }
    if (instalacion === "global" && esRepoNode(repo)) instalacion = "devDependency";
    s.start(`Installing OpenSpec ${objetivo}…`);
    try { const cmd = instalarOpenSpec(repo, instalacion, objetivo); s.stop(`OpenSpec ${objetivo} installed (${gris(cmd)})`); versionFinal = objetivo; }
    catch (e) { s.error((e as Error).message); return { instalacion, version: est.version ?? undefined, herramientas: [] }; }
  }

  const sugeridas = herramientasPedidas ?? (agentes.length ? agentes.filter((a) => HERRAMIENTAS_OPENSPEC.some((h) => h.value === a)) : ["claude"]);
  const herramientas = await elegirVarios("Which tools should receive OpenSpec skills and commands?", HERRAMIENTAS_OPENSPEC, sugeridas.length ? sugeridas : ["claude"], yes);
  if (!est.inicializado) {
    s.start("Running openspec init…");
    try { inicializarOpenSpec(repo, instalacion, herramientas); s.stop("OpenSpec initialized (openspec/)"); }
    catch (e) { s.error((e as Error).message); }
  } else p.log.info("openspec/ already exists. Skipping `openspec init` and merging orqen's rules.");
  return { instalacion, version: versionFinal, herramientas };
}

function resumenPlan(plan: Cambio[], config: Config): string {
  const icono: Record<string, string> = { crear: pc.green("+"), actualizar: pc.yellow("~"), igual: gris("="), conflicto: pc.red("!") };
  const filas = [
    `${pc.green("+")} ${ARCHIVO_CONFIG} ${gris("(the flow: project, connectors, workflow)")}`,
    `${pc.green("+")} ${ARCHIVO_ENTORNO} ${gris("(stack, how each part starts, tests)")}`,
    ...plan.filter((c) => c.accion !== "igual" && !c.ruta.startsWith("orqen/stages/") && !c.ruta.startsWith("orqen/plugin/"))
      .map((c) => `${icono[c.accion]} ${c.ruta}${c.accion === "conflicto" ? pc.red("  (local edits require review)") : ""}`),
  ];
  const etapas = plan.filter((c) => c.ruta.startsWith("orqen/stages/") && c.accion !== "igual").length;
  const plugin = plan.filter((c) => c.ruta.startsWith("orqen/plugin/") && c.accion !== "igual").length;
  if (etapas) filas.push(`${pc.green("+")} orqen/stages/ ${gris(`(${etapas} stage guides)`)}`);
  if (plugin) filas.push(`${pc.green("+")} orqen/plugin/ ${gris(`(${plugin} Claude Code plugin files)`)}`);
  filas.push("", gris(`Processes: ${config.entornos.procesos.map((x) => x.nombre).join(", ") || "none"} · tests: ${Object.entries(config.entornos.tests).filter(([, v]) => v).map(([k]) => k).join(", ") || "none"}`));
  return filas.join("\n");
}

export async function resolverConflicto(c: Cambio, yes: boolean): Promise<Decision> {
  if (yes) return "nuevo";
  const actual = c.modo === "bloque" ? c.parteActual ?? "" : c.actual ?? "";
  const nuevo = c.modo === "bloque" ? c.parteNueva ?? "" : c.nuevo;
  p.note(diffColoreado(c.ruta, actual, nuevo), `${c.ruta}${c.modo === "bloque" ? " (orqen block)" : ""} — locally edited`);
  return salirSiCancela<Decision | symbol>(await p.select<Decision>({
    message: `How should orqen update ${c.ruta}?`,
    options: [
      { value: "nuevo", label: "Write the proposed version alongside the original (.orqen-new)", hint: "recommended" },
      { value: "sobrescribir", label: "Replace with the proposed version" },
      { value: "mantener", label: "Keep the existing version" },
    ],
    initialValue: "nuevo",
  }));
}

/** Reuse database scripts already installed in the project; init never reads the external catalog. */
function reutilizarDb(repo: string, config: Config): void {
  const procesos = config.entornos.procesos;
  if (procesos.some((x) => x.nombre === "db" || /orqen\/tools\/db\.mjs/.test(x.comando))) return;
  if (existsSync(join(repo, "orqen", "tools", "db.json")) && existsSync(join(repo, "orqen", "tools", "db.mjs"))) {
    config.entornos.procesos = [ProcesoEntorno.parse(PROCESO_DB), ...procesos];
  }
}
