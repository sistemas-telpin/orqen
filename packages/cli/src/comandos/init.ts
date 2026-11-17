/**
 * orqen init — inicializa ORQEN en un repo:
 *  1. logo + chequeos (Node, git, pnpm/npm, Docker)
 *  2. detección determinística del stack + análisis rápido con el agente de IA local, en segundo plano
 *  3. OpenSpec: detecta versión, instala (devDependency o global) y corre `openspec init`
 *  4. la persona confirma o ajusta el stack (o pide la exploración a fondo)
 *  5. escribe orqen.yaml, docker-compose.orqen.yml y el kit (AGENTS.md, etapas, plugin, reglas de OpenSpec)
 */
import { basename, resolve } from "node:path";
import { VERSION_KIT } from "orqen-kit";
import { agentesInstalados, comandoRapido, explorarConAgente, explorarRapido, type ResultadoExploracion } from "../lib/agente.ts";
import { ARCHIVO_COMPOSE, generarCompose } from "../lib/compose.ts";
import { ARCHIVO_CONFIG, entornosDesdeStack, escribirConfig, existeConfig, type Config } from "../lib/config.ts";
import { detectar } from "../lib/detectar.ts";
import { escribirEnv, jqlDeProyecto, leerEnv, proyectoDeJql, RUTA_ENV } from "../lib/env.ts";
import { aplicar, marketplace, planificar, type Cambio, type Decision, MARKETPLACE } from "../lib/kit.ts";
import {
  estadoOpenSpec, esRepoNode, inicializarOpenSpec, instalarOpenSpec,
  RANGO_OPENSPEC, ultimaVersionOpenSpec, VERSION_MINIMA, type Instalacion,
} from "../lib/openspec.ts";
import { chequearSistema, ramaBase, VERSION_CLI } from "../lib/sistema.ts";
import { CATALOGO, resumenStack, type Servicio, type Stack, TIPOS_SERVICIO } from "../lib/stack.ts";
import { mostrarLogo } from "../ui/logo.ts";
import {
  azul, confirmar, diffColoreado, elegir, elegirVarios, gris, interactivo, magenta, p, pc, salirSiCancela, secreto, texto, textoValidado, tick,
} from "../ui/consola.ts";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface OpcionesInit {
  dir?: string;
  yes?: boolean;
  sinIa?: boolean;
  /** Exploración agéntica completa en vez de la rápida. */
  profundo?: boolean;
  sinAnimacion?: boolean;
  agente?: string;
  sinOpenspec?: boolean;
  herramientas?: string[];
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
  await mostrarLogo({
    animar: !o.sinAnimacion && !o.yes, esperarTecla: true,
    bienvenida: [
      "Este init va a:",
      "  • Detectar el stack y proponer los entornos, con tu agente de IA",
      "  • Instalar y configurar OpenSpec",
      "  • Dejar el repo listo para que los agentes trabajen solos",
    ],
  });
  p.intro(`${azul("orqen")} ${magenta("init")} ${gris(`v${VERSION_CLI} · ${repo}`)}`);
  if (!yes && !interactivo()) { p.log.warn("La terminal no es interactiva: sigo con los valores por defecto (como --yes)."); yes = true; }

  // 1. Chequeos
  const chequeos = chequearSistema(repo);
  p.note(chequeos.map((c) => `${tick(c.ok, c.requerido)} ${c.nombre.padEnd(11)} ${gris(c.detalle)}`).join("\n"), "Entorno");
  const faltan = chequeos.filter((c) => c.requerido && !c.ok);
  if (faltan.length) {
    p.cancel(faltan.map((c) => `${c.nombre}: ${c.ayuda ?? c.detalle}`).join("\n"));
    process.exitCode = 1;
    return;
  }
  for (const c of chequeos.filter((c) => !c.requerido && !c.ok)) p.log.warn(`${c.nombre}: ${c.ayuda}`);

  if (existeConfig(repo)) {
    p.log.warn(`Este repo ya tiene ${ARCHIVO_CONFIG}. Para traer cambios del kit usá ${pc.bold("orqen update")}.`);
    if (!(await confirmar("¿Reinicializar igual? (vuelve a explorar el stack; los archivos que editaste te los consulto)", false, yes))) {
      p.outro("Sin cambios.");
      return;
    }
  }

  // 2. Detección + exploración con IA
  const s = p.spinner();
  s.start("Explorando el repo (manifiestos, Dockerfiles, compose, dependencias)…");
  const deteccion = detectar(repo);
  s.stop(`Detección automática: ${deteccion.stack.componentes.length} componente(s), ${deteccion.stack.servicios.length} servicio(s)`);
  if (deteccion.evidencias.length) p.log.message(gris(deteccion.evidencias.slice(0, 15).map((e) => `· ${e}`).join("\n") + (deteccion.evidencias.length > 15 ? `\n· … ${deteccion.evidencias.length - 15} más` : "")));

  let stack: Stack = deteccion.stack;
  let comandoAgente: string | undefined = o.agente;
  const agentes = agentesInstalados();
  if (!o.sinIa) {
    if (!comandoAgente) {
      if (!agentes.length) p.log.warn("No encontré un agente de IA instalado (claude, codex, gemini). Sigo solo con la detección automática.");
      else {
        const eleccion = await elegir(
          "¿Qué agente analiza el repo y propone el stack y los entornos?",
          [
            ...agentes.map((a) => ({ value: a.id, label: a.nombre, hint: a.comando })),
            { value: "__otro", label: "Otro comando…" },
            { value: "__ninguno", label: "Ninguno (solo detección automática)" },
          ],
          agentes[0].id, yes,
        );
        if (eleccion === "__otro") comandoAgente = await texto("Comando headless (el prompt va por stdin, o usá {prompt})", "claude -p --permission-mode acceptEdits", yes);
        else if (eleccion !== "__ninguno") comandoAgente = agentes.find((a) => a.id === eleccion)!.comando;
      }
    }
  }

  // La exploración rápida no toca el repo: corre en segundo plano mientras se resuelve OpenSpec.
  const inicioIa = Date.now();
  let enCurso: Promise<ResultadoExploracion> | undefined;
  if (comandoAgente && !o.profundo) {
    enCurso = explorarRapido(repo, comandoRapido(comandoAgente), deteccion)
      .catch((e): ResultadoExploracion => ({ ok: false, errores: [(e as Error).message], salida: "" }));
    p.log.step(`${comandoAgente.split(" ")[0]} está analizando el stack en segundo plano; mientras tanto, sigamos.`);
  } else if (comandoAgente) {
    stack = (await explorarAFondo(repo, comandoAgente, deteccion)) ?? stack;
  }

  // 3. OpenSpec y rama base (mientras el agente trabaja)
  const nombre = basename(repo).toLowerCase().replace(/[^a-z0-9-]+/g, "-") || "proyecto";
  let openspecCfg: Config["openspec"] = { instalacion: esRepoNode(repo) ? "devDependency" : "global", herramientas: [] };
  if (!o.sinOpenspec) openspecCfg = await prepararOpenSpec(repo, agentes.map((a) => a.id), o.herramientas, yes);
  const rama = await texto("Rama base del repo (para ramas y PRs)", ramaBase(repo), yes);

  // Datos del proceso para .orqen/.env (también mientras el agente trabaja)
  const datosEnv = await pedirEnv(repo, yes);

  // 4. Propuesta del agente + confirmar / ajustar
  if (enCurso) {
    s.start("Terminando el análisis del stack…");
    const reloj = setInterval(() => s.message(`Terminando el análisis del stack… ${Math.round((Date.now() - inicioIa) / 1000)}s`), 1000);
    const r = await enCurso;
    clearInterval(reloj);
    if (r.ok && r.stack) { stack = r.stack; s.stop(`Propuesta del agente lista (${Math.round((Date.now() - inicioIa) / 1000)}s)`); }
    else {
      s.error("El agente no devolvió una propuesta válida; sigo con la detección automática");
      if (r.errores.length) p.log.message(gris(r.errores.slice(0, 5).join("\n")));
    }
  }
  for (;;) {
    const r = await revisarStack(stack, yes, !!comandoAgente);
    if (r !== "profundo") { stack = r; break; }
    stack = (await explorarAFondo(repo, comandoAgente!, deteccion)) ?? stack;
  }

  // 5. Rama base + escritura
  const config: Config = {
    version: 1,
    orqen: { cli: VERSION_CLI, kit: VERSION_KIT },
    proyecto: { nombre, rama_base: rama || "main" },
    agente: { comando: comandoAgente },
    openspec: openspecCfg,
    stack,
    entornos: entornosDesdeStack(stack),
  };
  const vars = { RESUMEN_STACK: resumenStack(stack), RAMA_BASE: config.proyecto.rama_base, AGENTE_CMD: comandoAgente ? `${comandoAgente}` : "claude -p --permission-mode acceptEdits" };
  const compose = generarCompose(stack, `orqen-${nombre}`);

  const plan = planificar(repo, vars, { extra: { [ARCHIVO_COMPOSE]: compose } });
  p.note(resumenPlan(plan, config), "Se va a escribir");
  if (!(await confirmar("¿Escribo los archivos?", true, yes))) { p.outro("Cancelado: no se escribió nada del kit."); return; }

  escribirConfig(repo, config);
  const res = await aplicar(repo, plan, (c) => resolverConflicto(c, yes));
  if (datosEnv) {
    escribirEnv(repo, readFileSync(join(repo, ".orqen", ".env.example"), "utf8"), datosEnv);
    p.log.success(`${RUTA_ENV} generado ${gris("(no se commitea)")}`);
  }
  const env = leerEnv(repo) ?? {};
  const faltanEnv = ["JIRA_URL", "JIRA_USER", "JIRA_TOKEN"].filter((k) => !env[k] || /tu-empresa/.test(env[k]));
  const lado = res.filter((r) => r.accion === "guardado-al-lado");
  p.log.success(`${ARCHIVO_CONFIG}, ${ARCHIVO_COMPOSE} y el kit (v${VERSION_KIT}) instalados`);
  for (const r of lado) p.log.warn(`${r.ruta}: dejé la versión de orqen en ${r.detalle} para que la fusiones`);

  const mk = marketplace(existsSync(join(repo, MARKETPLACE)) ? readFileSync(join(repo, MARKETPLACE), "utf8") : undefined).nombre;
  const pasos = [
    ...(faltanEnv.length ? [`Completá ${pc.cyan(RUTA_ENV)}: falta ${faltanEnv.join(", ")}. No se commitea.`] : []),
    `Revisá ${pc.cyan(ARCHIVO_CONFIG)} y ${pc.cyan(ARCHIVO_COMPOSE)}, y probá: ${pc.cyan("orqen entorno levantar")} · ${pc.cyan("orqen entorno tests")}`,
    `En Claude Code: ${pc.cyan("/plugin marketplace add ./")} y ${pc.cyan(`/plugin install orqen@${mk}`)}`,
    `Commiteá los cambios (orqen.yaml, compose, AGENTS.md, .orqen/, openspec/).`,
  ];
  p.note(pasos.map((x, i) => `${pc.bold(`${i + 1}.`)} ${x}`).join("\n"), "Próximos pasos");
  p.outro(`${magenta("//")} ${pc.bold("Del requerimiento a producción.")}`);
}

/**
 * Pide los datos de .orqen/.env (Jira, SIS, aprobadores). Devuelve los valores a escribir, o undefined si
 * hay que dejar el .env como está (ya existe y la persona no lo quiere tocar).
 * Con --yes no pregunta: si no hay .env se genera con los valores de ejemplo.
 */
async function pedirEnv(repo: string, yes: boolean): Promise<Record<string, string> | undefined> {
  const actual = leerEnv(repo);
  if (yes) return actual ? undefined : {};
  if (actual && !(await confirmar(`Ya hay un ${RUTA_ENV}. ¿Querés revisar sus datos?`, false, false))) return undefined;
  const previo = (k: string) => (actual?.[k] && !/tu-empresa/.test(actual[k]) ? actual[k] : "");
  if (!(await confirmar(`¿Configuramos ahora la conexión con Jira? ${gris(`(se guarda en ${RUTA_ENV}, que no se commitea)`)}`, true, false))) return actual ? undefined : {};

  const v: Record<string, string> = {};
  v.JIRA_URL = (await textoValidado("URL de Jira", previo("JIRA_URL"),
    (x) => (/^https?:\/\/[^\s/]+\.[^\s]+$/.test(x) ? undefined : "Tiene que ser una URL, ej. https://tu-empresa.atlassian.net"),
    "https://tu-empresa.atlassian.net")).replace(/\/+$/, "");
  v.JIRA_DEPLOYMENT = await elegir("¿Jira Cloud o Server / Data Center?", [
    { value: "cloud", label: "Cloud", hint: "*.atlassian.net" },
    { value: "server", label: "Server / Data Center" },
  ], (previo("JIRA_DEPLOYMENT") as "cloud" | "server") || (/atlassian\.net/.test(v.JIRA_URL) ? "cloud" : "server"), false);
  v.JIRA_USER = await textoValidado("Usuario de Jira con el que orqen comenta y crea issues (email del bot)", previo("JIRA_USER"),
    (x) => (x ? undefined : "Hace falta un usuario"), "bot@tu-empresa.com");
  const token = await secreto(`Token de API de ese usuario ${gris(previo("JIRA_TOKEN") ? "(Enter = dejar el que ya está)" : "(Enter = lo cargo después)")}`);
  if (token) v.JIRA_TOKEN = token;
  const rec = await texto("Proyecto de Jira donde llegan los REC (key)", proyectoDeJql(actual?.REC_JQL) ?? "REC", false);
  v.REC_JQL = jqlDeProyecto((rec || "REC").toUpperCase());
  v.SIS_PROYECTO = ((await texto("Proyecto de Jira donde se crean los SIS (key)", previo("SIS_PROYECTO") || "SIS", false)) || "SIS").toUpperCase();

  if (await confirmar(`¿Definimos quiénes aprueban cada etapa? ${gris("(si no, cualquiera puede aprobar)")}`, false, false)) {
    const pedir = (k: string, quien: string) => texto(`${quien} ${gris("(usuarios de Jira separados por coma; vacío = cualquiera)")}`, previo(k), false);
    v.APROBADORES_CODIGO = await pedir("APROBADORES_CODIGO", "Revisión de código (seniors)");
    v.APROBADORES_CLIENTE = await pedir("APROBADORES_CLIENTE", "Conformidad (cliente)");
    v.APROBADORES_ANALISIS = await pedir("APROBADORES_ANALISIS", "Analistas (destraban REC bloqueados)");
    v.APROBADORES_EJECUCION = await pedir("APROBADORES_EJECUCION", "Ejecución operativa (DBA / infra)");
  }
  // Conserva lo que ya estaba en el .env y no se preguntó
  return { ...actual, ...v };
}

/** Exploración a fondo: el agente recorre el repo con sus herramientas (minutos). */
async function explorarAFondo(repo: string, comando: string, deteccion: { stack: Stack; evidencias: string[] }): Promise<Stack | undefined> {
  const s = p.spinner();
  const inicio = Date.now();
  s.start("El agente está explorando el repo a fondo (puede tardar unos minutos)…");
  const reloj = setInterval(() => s.message(`El agente está explorando el repo a fondo… ${Math.round((Date.now() - inicio) / 1000)}s`), 1000);
  const r = await explorarConAgente(repo, comando, deteccion, {
    alReintentar: (e) => s.message(`La propuesta no validó (${e.length} error/es); reintentando…`),
  });
  clearInterval(reloj);
  if (r.ok && r.stack) { s.stop(`Exploración a fondo lista (${Math.round((Date.now() - inicio) / 1000)}s)`); return r.stack; }
  s.error("El agente no devolvió una propuesta válida; me quedo con la anterior");
  if (r.errores.length) p.log.message(gris(r.errores.slice(0, 8).join("\n")));
  return undefined;
}

async function revisarStack(stack: Stack, yes: boolean, hayAgente: boolean): Promise<Stack | "profundo"> {
  p.note(resumenStack(stack), "Stack propuesto");
  const accion = await elegir("¿Cómo seguimos?", [
    { value: "ok", label: "Está bien así" },
    { value: "ajustar", label: "Quiero ajustar servicios y comandos" },
    ...(hayAgente ? [{ value: "profundo", label: "Que el agente explore el repo a fondo", hint: "más preciso, tarda unos minutos" }] : []),
  ], "ok", yes);
  if (accion === "ok") return stack;
  if (accion === "profundo") return "profundo";

  const comps = await elegirVarios("Componentes a incluir",
    stack.componentes.map((c) => ({ value: c.nombre, label: `${c.nombre} ${gris(`(${c.ruta})`)}`, hint: [c.tipo, c.framework ?? c.lenguaje].join(" · ") })),
    stack.componentes.map((c) => c.nombre), false);
  const servs = await elegirVarios("Servicios a levantar con Docker",
    stack.servicios.map((x) => ({ value: x.nombre, label: `${x.nombre} ${gris(`(${x.tipo})`)}`, hint: x.motivo ?? undefined })),
    stack.servicios.map((x) => x.nombre), false);
  const disponibles = TIPOS_SERVICIO.filter((t) => t !== "otro" && !stack.servicios.some((x) => x.tipo === t));
  const extra = await elegirVarios("¿Agregar otros servicios?",
    disponibles.map((t) => ({ value: t, label: t, hint: CATALOGO[t as Exclude<Servicio["tipo"], "otro">].imagen })), [], false);

  const nuevos: Servicio[] = extra.map((t) => ({ nombre: t, tipo: t as Servicio["tipo"], variables: {}, motivo: "agregado a mano" }));
  const tests = { ...stack.tests };
  for (const k of ["unitarios", "integracion", "e2e", "visual"] as const) {
    tests[k] = (await texto(`Comando de tests ${k} (vacío = no hay)`, tests[k] ?? "", false)) || undefined;
  }
  const migraciones = (await texto("Comando de migraciones (vacío = no hay)", stack.migraciones ?? "", false)) || undefined;
  const seed = (await texto("Comando de seed / datos de prueba (vacío = no hay)", stack.seed ?? "", false)) || undefined;
  const r: Stack = {
    ...stack,
    componentes: stack.componentes.filter((c) => comps.includes(c.nombre)),
    servicios: [...stack.servicios.filter((x) => servs.includes(x.nombre)), ...nuevos],
    tests, migraciones, seed,
  };
  p.note(resumenStack(r), "Stack final");
  return r;
}

async function prepararOpenSpec(repo: string, agentes: string[], herramientasPedidas: string[] | undefined, yes: boolean): Promise<Config["openspec"]> {
  const s = p.spinner();
  s.start("Revisando OpenSpec…");
  const est = estadoOpenSpec(repo);
  const ultima = ultimaVersionOpenSpec(repo);
  s.stop(est.version
    ? `OpenSpec ${est.version} (${est.instalacion === "global" ? "global" : "devDependency"})${est.compatible ? "" : pc.red(` — no compatible, orqen requiere ${RANGO_OPENSPEC}`)}${ultima && est.compatible && ultima !== est.version ? gris(` · hay ${ultima}: \`orqen update\``) : ""}`
    : "OpenSpec no está instalado");

  let instalacion: Instalacion = est.instalacion ?? (esRepoNode(repo) ? "devDependency" : "global");
  let versionFinal = est.version ?? undefined;
  if (!est.version || !est.compatible) {
    const objetivo = ultima ?? VERSION_MINIMA;
    if (!esRepoNode(repo)) p.log.info("El repo no tiene package.json: OpenSpec se instala global.");
    const ok = await confirmar(`¿Instalo OpenSpec ${objetivo} como ${instalacion === "devDependency" ? "devDependency del repo" : "paquete global"}?`, true, yes);
    if (!ok) { p.log.warn("Sin OpenSpec los carriles liviano/completo no van a funcionar."); return { instalacion, version: est.version ?? undefined, herramientas: [] }; }
    if (instalacion === "global" && esRepoNode(repo)) instalacion = "devDependency";
    s.start(`Instalando OpenSpec ${objetivo}…`);
    try { const cmd = instalarOpenSpec(repo, instalacion, objetivo); s.stop(`OpenSpec ${objetivo} instalado (${gris(cmd)})`); versionFinal = objetivo; }
    catch (e) { s.error((e as Error).message); return { instalacion, version: est.version ?? undefined, herramientas: [] }; }
  }

  const sugeridas = herramientasPedidas ?? (agentes.length ? agentes.filter((a) => HERRAMIENTAS_OPENSPEC.some((h) => h.value === a)) : ["claude"]);
  const herramientas = await elegirVarios("¿Para qué herramientas instalo los skills y comandos de OpenSpec?", HERRAMIENTAS_OPENSPEC, sugeridas.length ? sugeridas : ["claude"], yes);
  if (!est.inicializado) {
    s.start("Corriendo openspec init…");
    try { inicializarOpenSpec(repo, instalacion, herramientas); s.stop("OpenSpec inicializado (openspec/)"); }
    catch (e) { s.error((e as Error).message); }
  } else p.log.info("openspec/ ya existe: no corro `openspec init` (las reglas de orqen se fusionan igual).");
  return { instalacion, version: versionFinal, herramientas };
}

function resumenPlan(plan: Cambio[], config: Config): string {
  const icono: Record<string, string> = { crear: pc.green("+"), actualizar: pc.yellow("~"), igual: gris("="), conflicto: pc.red("!") };
  const filas = [
    `${pc.green("+")} ${ARCHIVO_CONFIG}`,
    ...plan.filter((c) => c.accion !== "igual" && !c.ruta.startsWith(".orqen/etapas/") && !c.ruta.startsWith(".orqen/plugin/"))
      .map((c) => `${icono[c.accion]} ${c.ruta}${c.accion === "conflicto" ? pc.red("  (lo editaste: te pregunto)") : ""}`),
  ];
  const etapas = plan.filter((c) => c.ruta.startsWith(".orqen/etapas/") && c.accion !== "igual").length;
  const plugin = plan.filter((c) => c.ruta.startsWith(".orqen/plugin/") && c.accion !== "igual").length;
  if (etapas) filas.push(`${pc.green("+")} .orqen/etapas/ ${gris(`(${etapas} guías de etapa)`)}`);
  if (plugin) filas.push(`${pc.green("+")} .orqen/plugin/ ${gris(`(${plugin} archivos del plugin de Claude Code)`)}`);
  filas.push("", gris(`Entornos: ${config.stack.servicios.length} servicio(s) · tests: ${Object.entries(config.entornos.tests).filter(([, v]) => v).map(([k]) => k).join(", ") || "ninguno"}`));
  return filas.join("\n");
}

export async function resolverConflicto(c: Cambio, yes: boolean): Promise<Decision> {
  if (yes) return "nuevo";
  const actual = c.modo === "bloque" ? c.parteActual ?? "" : c.actual ?? "";
  const nuevo = c.modo === "bloque" ? c.parteNueva ?? "" : c.nuevo;
  p.note(diffColoreado(c.ruta, actual, nuevo), `${c.ruta}${c.modo === "bloque" ? " (bloque de orqen)" : ""} — lo modificaste`);
  return salirSiCancela<Decision | symbol>(await p.select<Decision>({
    message: `¿Qué hago con ${c.ruta}?`,
    options: [
      { value: "nuevo", label: "Dejar la versión de orqen al lado (.orqen-nuevo) y fusiono yo", hint: "recomendado" },
      { value: "sobrescribir", label: "Sobrescribir con la versión de orqen" },
      { value: "mantener", label: "Mantener la mía" },
    ],
    initialValue: "nuevo",
  }));
}
