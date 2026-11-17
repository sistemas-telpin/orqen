/**
 * Ejecución de procesos portable (Windows / Linux / macOS).
 * cross-spawn resuelve los shims .cmd de Windows (pnpm, npx, claude, codex...) y escapa argumentos.
 */
import spawn from "cross-spawn";
import { spawn as spawnNode, type SpawnOptions } from "node:child_process";

export interface Resultado { codigo: number; stdout: string; stderr: string; error?: Error }

export interface OpcionesEjecutar {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  entrada?: string;
  timeoutMs?: number;
  /** Muestra la salida en la terminal en vez de capturarla. */
  heredar?: boolean;
}

export function ejecutar(cmd: string, args: string[], o: OpcionesEjecutar = {}): Resultado {
  const r = spawn.sync(cmd, args, {
    cwd: o.cwd,
    env: o.env ?? process.env,
    input: o.entrada,
    timeout: o.timeoutMs,
    encoding: "utf8",
    stdio: o.heredar ? (o.entrada !== undefined ? ["pipe", "inherit", "inherit"] : "inherit") : "pipe",
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    codigo: r.status ?? (r.error ? 127 : 1),
    stdout: (r.stdout as unknown as string) ?? "",
    stderr: (r.stderr as unknown as string) ?? "",
    error: r.error ?? undefined,
  };
}

/** Versión asíncrona (para no congelar el spinner mientras corre el agente). */
export function ejecutarAsync(cmd: string, args: string[], o: OpcionesEjecutar = {}): Promise<Resultado> {
  return new Promise((resolve) => {
    let stdout = "", stderr = "", terminado = false;
    const hijo = spawn(cmd, args, {
      cwd: o.cwd, env: o.env ?? process.env, windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const timer = o.timeoutMs ? setTimeout(() => { if (!terminado) { stderr += "\n[timeout]"; hijo.kill(); } }, o.timeoutMs) : undefined;
    hijo.stdout?.on("data", (d) => (stdout += d));
    hijo.stderr?.on("data", (d) => (stderr += d));
    hijo.on("error", (error) => { terminado = true; clearTimeout(timer); resolve({ codigo: 127, stdout, stderr, error }); });
    hijo.on("close", (codigo) => { terminado = true; clearTimeout(timer); resolve({ codigo: codigo ?? 1, stdout, stderr }); });
    if (o.entrada !== undefined) hijo.stdin?.end(o.entrada); else hijo.stdin?.end();
  });
}

/** Corre una línea de comando del usuario (orqen/config.yaml) con la shell del sistema: cmd.exe en Windows, sh en el resto. */
export function ejecutarLinea(linea: string, o: OpcionesEjecutar = {}): Promise<number> {
  return new Promise((resolve) => {
    const opts: SpawnOptions = { cwd: o.cwd, env: o.env ?? process.env, shell: true, stdio: "inherit", windowsHide: true };
    const hijo = spawnNode(linea, opts);
    hijo.on("error", () => resolve(127));
    hijo.on("close", (c) => resolve(c ?? 1));
  });
}

/** ¿Existe el comando? Devuelve la primera línea de `--version` o null. */
export function version(cmd: string, args = ["--version"], cwd?: string): string | null {
  const r = ejecutar(cmd, args, { cwd, timeoutMs: 20_000 });
  if (r.error || r.codigo !== 0) return null;
  return (r.stdout || r.stderr).trim().split(/\r?\n/)[0] ?? "";
}

/** Separa "claude -p --permission-mode acceptEdits" en argv respetando comillas simples y dobles. */
export function partirComando(linea: string): string[] {
  const out: string[] = [];
  let actual = "", comilla: string | null = null, hay = false;
  for (const c of linea.trim()) {
    if (comilla) {
      if (c === comilla) comilla = null; else actual += c;
    } else if (c === '"' || c === "'") { comilla = c; hay = true; }
    else if (/\s/.test(c)) { if (actual || hay) out.push(actual); actual = ""; hay = false; }
    else actual += c;
  }
  if (actual || hay) out.push(actual);
  return out;
}

export const esWindows = process.platform === "win32";
