/**
 * Environment processes: each part of the project starts with its own command (`npm run dev`, `npm start`,
 * `mvn spring-boot:run`, `dotnet watch run`…). No Docker in between (a team that wants it can use a process such as
 * `docker compose up db`).
 *
 * Processes keep running in the background after the orqen command that started them exits (`orqen env up`,
 * `orqen take`), so they are recorded in orqen/state/processes.json with their PID and log
 * (orqen/state/logs/<name>.log). `orqen env down` / `orqen complete` stop them together with their process tree.
 *
 * A process is ready when its port or URL responds, or a text shows up in its log; without any of those signals,
 * when it is still alive after a few seconds.
 *
 * Ports per Worq: each Worq runs in its own worktree (each with its own orqen/state), and several can be up at once.
 * A process whose command, URL, web or the variables mention `${port}` (its own) or `${port.<name>}` gets a free port
 * of its own: the preferred one (`port`) when nobody uses it, otherwise the next free one. The choice is kept in
 * orqen/state/ports.json and passed as PORT and ORQEN_PORT_<NAME> too. A process without `${port}` keeps the fixed port.
 */
import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { connect, createServer } from "node:net";
import { join, resolve } from "node:path";
import { z } from "zod";

export const ProcesoEntorno = z.object({
  nombre: z.string().min(1),
  comando: z.string().min(1).describe("Command that starts it, e.g. npm run dev"),
  ruta: z.string().default(".").describe("Directory where it runs, relative to the repo root"),
  puerto: z.number().int().positive().nullish().describe("Ready when this port accepts connections"),
  url: z.string().nullish().describe("Ready when this URL responds (e.g. http://localhost:3000/health)"),
  listo_si: z.string().nullish().describe("Ready when this text (or regex) shows up in its output"),
  detener: z.string().nullish()
    .describe("Command that stops it cleanly before orqen kills it (e.g. node orqen/tools/db.mjs down to stop a Docker container)"),
  cuando: z.enum(["siempre", "e2e"]).default("siempre")
    .describe("siempre: started for development and tests. e2e: only for end-to-end / visual tests (e.g. the frontend)"),
  espera_seg: z.number().int().positive().default(120),
  web: z.string().nullish().describe("Page to open in the Worq's browser (e.g. http://localhost:${port}/app/)"),
});
export type ProcesoEntorno = z.infer<typeof ProcesoEntorno>;

interface Registro { pid: number; comando: string; log: string; desde: string; propio: boolean; detener?: string; cwd?: string }
type Registros = Record<string, Registro>;

const dirEstado = (repo: string) => join(repo, "orqen", "state");
const archivoRegistro = (repo: string) => join(dirEstado(repo), "processes.json");
const archivoPuertos = (repo: string) => join(dirEstado(repo), "ports.json");

/** `${port}` / `${port.<name>}` in the text. */
const RE_PUERTO = /\$\{port(?:\.([\w-]+))?\}/g;
const nombreVar = (n: string) => n.toUpperCase().replace(/[^A-Z0-9]+/g, "_");

/** Whether the process takes the port orqen gives it (its texts or the variables mention it). */
export function puertoDinamico(p: ProcesoEntorno, variables: Record<string, string> = {}): boolean {
  if (!p.puerto) return false;
  const propios = [p.comando, p.url, p.listo_si, p.web, p.detener].filter(Boolean).join("\n");
  const usa = (t: string, propio: boolean) => [...t.matchAll(RE_PUERTO)].some((m) => m[1] ? m[1] === p.nombre : propio);
  return usa(propios, true) || Object.values(variables).some((v) => usa(v, false));
}

function leerPuertos(repo: string): Record<string, number> {
  try { return JSON.parse(readFileSync(archivoPuertos(repo), "utf8")); } catch { return {}; }
}

/** Can this port be listened on now? */
export function puertoLibre(puerto: number): Promise<boolean> {
  return new Promise((ok) => {
    const s = createServer();
    s.once("error", () => ok(false));
    s.listen({ port: puerto, host: "127.0.0.1", exclusive: true }, () => s.close(() => ok(true)));
  });
}

/** The ports in use by this worktree: the assigned one of each dynamic process, the fixed one of the rest. */
export function puertosActuales(repo: string, procesos: ProcesoEntorno[], variables: Record<string, string> = {}): Record<string, number> {
  const guardados = leerPuertos(repo);
  const out: Record<string, number> = {};
  for (const p of procesos) if (p.puerto) out[p.nombre] = (puertoDinamico(p, variables) && guardados[p.nombre]) || p.puerto;
  return out;
}

/** Replaces `${port}` (own) and `${port.<name>}`; an unknown name is left as it is. */
export function conPuertos(texto: string, puertos: Record<string, number>, propio?: string): string {
  return texto.replace(RE_PUERTO, (m, n?: string) => {
    const k = n ?? propio;
    return k && puertos[k] ? String(puertos[k]) : m;
  });
}

/** The variables with the ports of this worktree, plus ORQEN_PORT_<NAME>. */
export function variablesConPuertos(repo: string, procesos: ProcesoEntorno[], variables: Record<string, string>): Record<string, string> {
  const puertos = puertosActuales(repo, procesos, variables);
  const out: Record<string, string> = {};
  for (const [n, v] of Object.entries(puertos)) out[`ORQEN_PORT_${nombreVar(n)}`] = String(v);
  for (const [k, v] of Object.entries(variables)) out[k] = conPuertos(v, puertos);
  return out;
}

/** The process with its ports resolved (command, URL, ready text, web, stop). */
export function resolverProceso(p: ProcesoEntorno, puertos: Record<string, number>): ProcesoEntorno {
  const r = (t?: string | null) => (t ? conPuertos(t, puertos, p.nombre) : t);
  return { ...p, comando: r(p.comando)!, url: r(p.url), listo_si: r(p.listo_si), web: r(p.web), detener: r(p.detener), puerto: puertos[p.nombre] ?? p.puerto };
}

/**
 * Picks the port of each dynamic process about to start: the one it already had (when that is still free or it is
 * still running), else the preferred one, else the next free one. Other worktrees' choices are respected because
 * their ports are taken (in use) by then.
 */
async function asignarPuertos(repo: string, procesos: ProcesoEntorno[], variables: Record<string, string>, registro: Registros): Promise<Record<string, number>> {
  const guardados = leerPuertos(repo);
  const puertos = puertosActuales(repo, procesos, variables);
  const tomados = new Set<number>();
  for (const p of procesos) {
    if (!puertoDinamico(p, variables)) continue;
    const propio = registro[p.nombre] && vivo(registro[p.nombre].pid) ? guardados[p.nombre] : undefined;
    if (propio) { puertos[p.nombre] = propio; tomados.add(propio); continue; }
    const candidatos = [guardados[p.nombre], p.puerto!].filter((x): x is number => !!x);
    let elegido: number | undefined;
    for (const c of candidatos) if (!tomados.has(c) && await puertoLibre(c)) { elegido = c; break; }
    for (let c = p.puerto! + 1; !elegido && c < p.puerto! + 500 && c < 65536; c++) if (!tomados.has(c) && await puertoLibre(c)) elegido = c;
    if (!elegido) throw new Error(`No free port for ${p.nombre} near ${p.puerto}.`);
    puertos[p.nombre] = elegido;
    tomados.add(elegido);
  }
  mkdirSync(dirEstado(repo), { recursive: true });
  const dinamicos = Object.fromEntries(procesos.filter((p) => puertoDinamico(p, variables)).map((p) => [p.nombre, puertos[p.nombre]]));
  writeFileSync(archivoPuertos(repo), JSON.stringify({ ...guardados, ...dinamicos }, null, 2));
  return puertos;
}

function leerRegistro(repo: string): Registros {
  try { return JSON.parse(readFileSync(archivoRegistro(repo), "utf8")); } catch { return {}; }
}
function guardarRegistro(repo: string, r: Registros) {
  mkdirSync(dirEstado(repo), { recursive: true });
  writeFileSync(archivoRegistro(repo), JSON.stringify(r, null, 2));
}

export function vivo(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}

/** Is something listening on that localhost port? (tries IPv4 and IPv6). */
export function puertoAbierto(puerto: number, timeoutMs = 700): Promise<boolean> {
  const probar = (host: string) => new Promise<boolean>((ok) => {
    const s = connect({ host, port: puerto });
    const fin = (v: boolean) => { s.destroy(); ok(v); };
    s.setTimeout(timeoutMs, () => fin(false));
    s.once("connect", () => fin(true));
    s.once("error", () => fin(false));
  });
  return probar("127.0.0.1").then((v) => v || probar("::1"));
}

async function urlResponde(url: string): Promise<boolean> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(2000), redirect: "manual" });
    return r.status < 500;
  } catch { return false; }
}

function cola(archivo: string, lineas = 40): string {
  try { return readFileSync(archivo, "utf8").split(/\r?\n/).slice(-lineas).join("\n"); } catch { return ""; }
}

function coincide(texto: string, patron: string): boolean {
  try { return new RegExp(patron, "i").test(texto); } catch { return texto.includes(patron); }
}

/** Starts a detached process that outlives orqen, without windows on Windows. Returns its PID. */
function arrancar(cmd: string, cwd: string, env: NodeJS.ProcessEnv, log: string): number {
  if (process.platform === "win32") {
    // Start-Process: an independent process with its own hidden console (its children open no windows)
    // and output redirected to the log. Returns the PID of cmd.exe, the root of the tree.
    const q = (s: string) => `'${s.replace(/'/g, "''")}'`;
    const ps = `$p = Start-Process -FilePath 'cmd.exe' -ArgumentList '/d','/s','/c',${q(`"${cmd} > "${log}" 2>&1"`)} ` +
      `-WorkingDirectory ${q(cwd)} -WindowStyle Hidden -PassThru; $p.Id`;
    const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { env, encoding: "utf8", windowsHide: true });
    const pid = Number((r.stdout ?? "").trim().split(/\s+/).pop());
    if (!pid) throw new Error(`Could not start "${cmd}": ${(r.stderr || r.stdout || "").trim()}`);
    return pid;
  }
  const fd = openSync(log, "a");
  try {
    const hijo = spawn("sh", ["-c", cmd], { cwd, env, detached: true, stdio: ["ignore", fd, fd] });
    hijo.unref();
    if (!hijo.pid) throw new Error(`Could not start "${cmd}"`);
    return hijo.pid;
  } finally { closeSync(fd); }
}

/** Stops the process and everything it started. */
export function matar(pid: number) {
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    return;
  }
  for (const sig of ["SIGTERM", "SIGKILL"] as const) {
    try { process.kill(-pid, sig); } catch { try { process.kill(pid, sig); } catch { /* already gone */ } }
    if (sig === "SIGTERM") { const hasta = Date.now() + 2500; while (vivo(pid) && Date.now() < hasta) spawnSync("sleep", ["0.1"]); }
    if (!vivo(pid)) return;
  }
}

export interface ResultadoProcesos { ok: boolean; detalle: string; levantados: string[]; salida?: string }

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Starts the processes (`todos` includes the `cuando: e2e` ones) and waits until they are ready.
 * A process that is already running (its port/URL responds, or the record says it is alive) is not started twice.
 */
export async function levantarProcesos(
  repo: string, procesos: ProcesoEntorno[], variables: Record<string, string>,
  o: { todos?: boolean; solo?: string[]; alAvanzar?: (msg: string) => void } = {},
): Promise<ResultadoProcesos> {
  const registro = leerRegistro(repo);
  const levantados: string[] = [];
  mkdirSync(join(dirEstado(repo), "logs"), { recursive: true });
  const desconocidos = (o.solo ?? []).filter((n) => !procesos.some((p) => p.nombre === n));
  if (desconocidos.length) return { ok: false, detalle: `Unknown process: ${desconocidos.join(", ")}. Options: ${procesos.map((p) => p.nombre).join(", ")}`, levantados };
  const elegidos = procesos.filter((x) => o.solo?.length ? o.solo.includes(x.nombre) : (o.todos || x.cuando === "siempre"));
  let puertos: Record<string, number>;
  try { puertos = await asignarPuertos(repo, elegidos, variables, registro); }
  catch (e) { return { ok: false, detalle: (e as Error).message, levantados }; }
  puertos = { ...puertosActuales(repo, procesos, variables), ...puertos };
  const env: NodeJS.ProcessEnv = { ...process.env, ...variablesConPuertos(repo, procesos, variables) };

  for (const original of elegidos) {
    const p = resolverProceso(original, puertos);
    const dinamico = puertoDinamico(original, variables);
    const previo = registro[p.nombre];
    // a dynamic port was picked free: something answering there is not this worktree's (only its record counts)
    const yaResponde = !dinamico && ((p.puerto && await puertoAbierto(p.puerto)) || (p.url && await urlResponde(p.url)));
    if (yaResponde || (previo && vivo(previo.pid))) {
      levantados.push(`${p.nombre} (already running)`);
      continue;
    }
    const log = join(dirEstado(repo), "logs", `${p.nombre}.log`);
    writeFileSync(log, `# ${new Date().toISOString()}  ${p.comando}  (en ${p.ruta})\n`);
    o.alAvanzar?.(`Starting ${p.nombre}: ${p.comando}`);
    let pid: number;
    try { pid = arrancar(p.comando, resolve(repo, p.ruta), p.puerto ? { ...env, PORT: String(p.puerto) } : env, log); }
    catch (e) { return { ok: false, detalle: `Could not start ${p.nombre}: ${(e as Error).message}`, levantados }; }
    registro[p.nombre] = { pid, comando: p.comando, log, desde: new Date().toISOString(), propio: true, detener: p.detener ?? undefined, cwd: resolve(repo, p.ruta) };
    guardarRegistro(repo, registro);

    const hasta = Date.now() + p.espera_seg * 1000;
    const sinSenal = !p.puerto && !p.url && !p.listo_si;
    const minimo = Date.now() + 4000;   // no signal: ready if still alive after a few seconds
    for (;;) {
      if (!vivo(pid)) {
        delete registro[p.nombre]; guardarRegistro(repo, registro);
        return { ok: false, detalle: `${p.nombre} exited before it was ready ("${p.comando}"). See its log: ${log}`, levantados, salida: cola(log) };
      }
      const listo = sinSenal ? Date.now() >= minimo
        : (p.puerto ? await puertoAbierto(p.puerto) : true) && (p.url ? await urlResponde(p.url) : true)
          && (p.listo_si ? coincide(cola(log, 200), p.listo_si) : true);
      if (listo) { levantados.push(`${p.nombre}${p.puerto ? ` (:${p.puerto})` : ""}${p.web ? ` ${p.web}` : ""}`); break; }
      if (Date.now() > hasta) {
        return { ok: false, detalle: `${p.nombre} was not ready after ${p.espera_seg}s (${p.puerto ? `port ${p.puerto}` : p.url ?? p.listo_si ?? "process"}). Log: ${log}`, levantados, salida: cola(log) };
      }
      await dormir(400);
    }
  }
  return { ok: true, detalle: levantados.length ? `Processes ready: ${levantados.join(", ")}.` : "No processes to start.", levantados };
}

/** Stops the processes orqen started (processes that were already running are left alone). */
export function bajarProcesos(repo: string, solo?: string[]): string[] {
  const registro = leerRegistro(repo);
  const bajados: string[] = [];
  for (const [nombre, r] of Object.entries(registro)) {
    if (solo?.length && !solo.includes(nombre)) continue;
    if (r.propio && vivo(r.pid)) {
      // Clean stop first (e.g. `docker stop`): killing the process tree alone would leave a container running.
      if (r.detener) spawnSync(r.detener, { shell: true, cwd: r.cwd ?? repo, stdio: "ignore", windowsHide: true, timeout: 120_000 });
      matar(r.pid);
      bajados.push(nombre);
    }
    delete registro[nombre];
  }
  if (existsSync(archivoRegistro(repo))) guardarRegistro(repo, registro);
  return bajados;
}

export async function estadoProcesos(repo: string, procesos: ProcesoEntorno[], variables: Record<string, string> = {}) {
  const registro = leerRegistro(repo);
  const puertos = puertosActuales(repo, procesos, variables);
  return Promise.all(procesos.map(async (original) => {
    const p = resolverProceso(original, puertos);
    const r = registro[p.nombre];
    const propio = !!r && vivo(r.pid);
    // a dynamic port only counts as "running" when this worktree started it (another Worq may use the same number)
    const corriendo = propio || (!puertoDinamico(original, variables) && p.puerto ? await puertoAbierto(p.puerto) : false);
    // the page to open: `web`, else the origin of the URL, else localhost:<port>
    const origen = (u: string) => { try { return new URL(u).origin + "/"; } catch { return null; } };
    const web = p.web ?? (p.url ? origen(p.url) : null) ?? (p.puerto ? `http://localhost:${p.puerto}/` : null);
    return {
      nombre: p.nombre, comando: p.comando, corriendo: !!corriendo, propio, pid: r?.pid, puerto: p.puerto, preferido: original.puerto,
      log: r?.log ?? (existsSync(join(dirEstado(repo), "logs", `${p.nombre}.log`)) ? join(dirEstado(repo), "logs", `${p.nombre}.log`) : undefined),
      cuando: p.cuando, url: p.url, web,
    };
  }));
}
