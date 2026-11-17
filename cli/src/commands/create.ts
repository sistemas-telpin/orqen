/**
 * orqen create project: bootstrap a new project from a tool of the catalog.
 *
 *  1. Ask the project name, the folder and the stack (tool).
 *  2. Check the stack requirements (node, mvn, docker…) and ask its parameters (ports, Java package…).
 *  3. Create the folder and the Git repo, generate the code (official generators + the tool's skeleton)
 *     and copy the tool scripts to orqen/tools/ (e.g. orqen/tools/db.mjs to run the database in Docker).
 *  4. Run `orqen init` with the stack and environments already known (no detection or AI needed).
 *  5. Offer the initial commit.
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ejecutar } from "../lib/proc.ts";
import { puertoAbierto } from "../lib/processes.ts";
import {
  cargarTool, chequearRequisitos, copiarCarpeta, instalarTools, listarTools, parametrosDe, render, TOOLS_DIR,
  validarParametro, variablesBase, type Tool, type Variables,
} from "../lib/tools.ts";
import { VERSION_CLI } from "../lib/system.ts";
import { mostrarLogo } from "../ui/logo.ts";
import { azul, confirmar, elegir, gris, interactivo, magenta, p, pc, textoValidado, tick } from "../ui/console.ts";
import { init } from "./init.ts";
import { spawn } from "node:child_process";

export interface OpcionesCreate {
  nombre?: string;
  stack?: string;
  dir?: string;
  yes?: boolean;
  sinAnimacion?: boolean;
  sinOpenspec?: boolean;
  herramientas?: string[];
  /** Skip running generators and installs (tests). */
  sinComandos?: boolean;
}

const vacio = (dir: string) => !existsSync(dir) || readdirSync(dir).length === 0;

/** Next free port from `desde`. */
async function puertoLibre(desde: number): Promise<number> {
  for (let n = desde; n < desde + 50; n++) if (!(await puertoAbierto(n, 300))) return n;
  return desde;
}

/** Run a shell command in the project, keeping the last output lines for errors. */
function correr(cmd: string, cwd: string): Promise<{ ok: boolean; cola: string }> {
  return new Promise((ok) => {
    let salida = "";
    const h = spawn(cmd, { cwd, shell: true, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CI: "1" } });
    h.stdout?.on("data", (d) => (salida = (salida + d).slice(-8000)));
    h.stderr?.on("data", (d) => (salida = (salida + d).slice(-8000)));
    h.on("error", (e) => ok({ ok: false, cola: e.message }));
    h.on("close", (c) => ok({ ok: c === 0, cola: salida.split(/\r?\n/).filter(Boolean).slice(-15).join("\n") }));
  });
}

export async function crearProyecto(o: OpcionesCreate) {
  let yes = !!o.yes;
  await mostrarLogo({
    animar: !o.sinAnimacion && !o.yes, esperarTecla: true,
    bienvenida: [
      "Create project will:",
      "  • Ask the name and the stack, and generate the code with the official generators",
      "  • Add the tools that start its environments (database in Docker, servers…)",
      "  • Leave the repository ready for agents (orqen init, OpenSpec, Jira)",
    ],
  });
  p.intro(`${azul("orqen")} ${magenta("create project")} ${gris(`v${VERSION_CLI}`)}`);
  if (!yes && !interactivo()) { p.log.warn("Non-interactive terminal. Using defaults as with --yes."); yes = true; }

  // 1. Name, folder and stack.
  const tools = listarTools();
  if (!tools.length) { p.cancel(`No tools found in ${TOOLS_DIR}.`); process.exitCode = 1; return; }
  const nombre = o.nombre ?? (yes ? "" : await textoValidado("Project name", "", (v) => (/^[\p{L}\p{N}][\p{L}\p{N} _.-]*$/u.test(v) ? undefined : "Use letters, numbers, spaces, dots, dashes or underscores"), "Plataforma de Pagos"));
  if (!nombre) { p.cancel("A project name is required (orqen create project <name>)."); process.exitCode = 1; return; }
  const base = variablesBase(nombre);
  const dir = resolve(o.dir ?? (yes ? base.PROYECTO_ID : await textoValidado("Folder", base.PROYECTO_ID, (v) => (v ? undefined : "Required"))));
  if (!vacio(dir)) { p.cancel(`${dir} already exists and is not empty. Choose another folder (--dir).`); process.exitCode = 1; return; }

  let stackId = o.stack;
  if (stackId && !tools.some((t) => t.id === stackId)) {
    p.cancel(`Unknown stack "${stackId}". Available: ${tools.map((t) => t.id).join(", ")}`); process.exitCode = 1; return;
  }
  stackId ??= await elegir("Stack", tools.map((t) => ({ value: t.id, label: t.nombre, hint: t.descripcion })), tools[0].id, yes);

  // 2. Parameters (ports are checked against what is already running) and requirements.
  const vars: Variables = { ...base };
  for (const prm of parametrosDe(stackId, base)) {
    let def = prm.defecto;
    if (prm.tipo === "puerto") {
      const libre = await puertoLibre(Number(def));
      if (String(libre) !== def) p.log.info(`Port ${def} is in use: proposing ${libre} for "${prm.pregunta}".`);
      def = String(libre);
    }
    vars[prm.id] = yes ? def : await textoValidado(prm.pregunta, def, (v) => validarParametro(prm.tipo, v));
  }
  if (vars.PAQUETE) vars.PAQUETE_RUTA = vars.PAQUETE.replaceAll(".", "/");

  let tool: Tool;
  try { tool = cargarTool(stackId, vars); }
  catch (e) { p.cancel((e as Error).message); process.exitCode = 1; return; }

  const req = chequearRequisitos(tool);
  p.note(req.map((r) => `${tick(r.ok, r.comando !== "docker")} ${r.comando.padEnd(8)} ${gris(r.detalle)}`).join("\n"), "Requirements");
  // To create the code you need the commands its generators run; Docker is only needed to run the database.
  const paraCrear = new Set(tool.scaffold.flatMap((s) => ("correr" in s ? [s.correr.split(/\s+/)[0]] : [])));
  const bloquean = req.filter((r) => !r.ok && (paraCrear.has(r.comando) || r.comando === "node"));
  if (bloquean.length && !o.sinComandos) {
    p.cancel(bloquean.map((r) => `${r.comando}: ${r.ayuda ?? r.detalle}`).join("\n")); process.exitCode = 1; return;
  }
  for (const r of req.filter((r) => !r.ok && !bloquean.includes(r))) p.log.warn(`${r.comando}: ${r.ayuda ?? r.detalle}. The project is created anyway; you need it to run it.`);

  p.note([
    `${pc.bold(vars.PROYECTO)}  ${gris(dir)}`,
    `${tool.nombre} ${gris(`(${tool.id})`)}`,
    ...tool.parametros.map((x) => `${x.pregunta}: ${pc.cyan(vars[x.id])}`),
    "",
    gris("How it will start:"),
    ...tool.entornos.procesos.map((x) => `  ${x.nombre}: ${x.comando}${x.ruta !== "." ? gris(` (in ${x.ruta})`) : ""}${x.cuando === "e2e" ? gris("  [e2e only]") : ""}`),
  ].join("\n"), "New project");
  if (!(await confirmar("Create it?", true, yes))) { p.outro("Canceled. Nothing was created."); return; }

  // 3. Folder, Git and code.
  mkdirSync(dir, { recursive: true });
  ejecutar("git", ["init", "-q", "-b", "main"], { cwd: dir });
  const s = p.spinner();
  for (const paso of tool.scaffold) {
    if ("copiar" in paso) {
      const n = copiarCarpeta(join(TOOLS_DIR, stackId, paso.copiar), dir, vars).length;
      p.log.success(`Project skeleton (${n} files)`);
    } else if ("archivo" in paso) {
      const ruta = join(dir, render(paso.archivo, vars));
      mkdirSync(join(ruta, ".."), { recursive: true });
      writeFileSync(ruta, paso.contenido);
    } else if (!o.sinComandos) {
      const inicio = Date.now(), etiqueta = paso.descripcion ?? paso.correr;
      // Without a terminal (CI, tests) a spinner floods the output with frames: plain log lines instead.
      const tty = interactivo();
      if (tty) s.start(`${etiqueta}…`); else p.log.step(`${etiqueta}…`);
      const reloj = tty ? setInterval(() => s.message(`${etiqueta}… ${Math.round((Date.now() - inicio) / 1000)}s`), 1000) : undefined;
      const r = await correr(paso.correr, paso.en ? join(dir, paso.en) : dir);
      clearInterval(reloj);
      if (!r.ok) {
        if (tty) s.error(`Failed: ${paso.correr}`); else p.log.error(`Failed: ${paso.correr}`);
        p.log.message(gris(r.cola));
        p.cancel(`The project folder was left at ${dir} so you can check what happened. Delete it to start over.`);
        process.exitCode = 1;
        return;
      }
      const fin = `${etiqueta} ${gris(`(${Math.round((Date.now() - inicio) / 1000)}s)`)}`;
      if (tty) s.stop(fin); else p.log.success(fin);
    }
  }
  const scripts = instalarTools(dir, tool, vars);
  p.log.success(`Environment tools: ${scripts.join(", ")}`);

  // 4. orqen init with the known stack and environments.
  p.log.step("Preparing the repository for agents (orqen init)…");
  await init({
    dir, yes, sinAnimacion: true, sinLogo: true, sinOpenspec: o.sinOpenspec, herramientas: o.herramientas,
    predefinido: { stack: tool.stack, entornos: tool.entornos },
  });
  if (process.exitCode) return;

  // 5. Initial commit.
  if (await confirmar("Make the initial commit?", true, yes)) {
    ejecutar("git", ["add", "-A"], { cwd: dir });
    const c = ejecutar("git", ["commit", "-q", "-m", `Create ${vars.PROYECTO} with orqen (${tool.id})`], { cwd: dir });
    if (c.codigo === 0) p.log.success("Initial commit created on main");
    else p.log.warn(`Could not commit (${(c.stderr || c.stdout).trim().split("\n")[0]}). Configure git user.name and user.email and commit by hand.`);
  }

  p.note([
    `${pc.bold("1.")} ${pc.cyan(`cd ${dir}`)}`,
    `${pc.bold("2.")} ${pc.cyan("orqen env up")} ${gris("starts the database and the backend and runs the migrations (--all: also the frontend)")}`,
    `${pc.bold("3.")} ${pc.cyan("orqen env test")} ${gris("· orqen env down when you are done")}`,
    `${pc.bold("4.")} ${gris("Push it to your Git remote and start working on requests: /orqen:analyze REC-1234 (new to orqen? run /orqen:tutorial in Claude Code)")}`,
  ].join("\n"), "Next steps");
  p.outro(`${magenta("//")} ${pc.bold(`${vars.PROYECTO} is ready.`)}`);
}

/** `orqen create <what>`: today only `project`. */
export async function crear(que: string | undefined, o: OpcionesCreate) {
  if (!que || ["project", "proyecto", "proyect"].includes(que)) return crearProyecto(o);
  if (que === "list" || que === "stacks") {
    for (const t of listarTools()) console.log(`${pc.bold(t.id.padEnd(24))} ${t.nombre}\n${" ".repeat(25)}${gris(t.descripcion)}`);
    return;
  }
  console.error(`Unknown: orqen create ${que}. Use: orqen create project [name] [--stack <id>] [--dir <folder>]  ·  orqen create stacks`);
  process.exitCode = 1;
}
