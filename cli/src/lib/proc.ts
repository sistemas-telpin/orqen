/**
 * Portable child process execution for Windows, Linux, and macOS.
 * cross-spawn resolves Windows command shims and escapes arguments.
 */
import spawn from "cross-spawn";
import { spawn as spawnNode, type SpawnOptions } from "node:child_process";

export interface Resultado { codigo: number; stdout: string; stderr: string; error?: Error }

export interface OpcionesEjecutar {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  entrada?: string;
  timeoutMs?: number;
  /** Send output directly to the terminal. */
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

/** Run asynchronously so the spinner can update while the agent runs. */
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

/** Run a configured command in cmd.exe on Windows or sh elsewhere. */
export function ejecutarLinea(linea: string, o: OpcionesEjecutar = {}): Promise<number> {
  return new Promise((resolve) => {
    const opts: SpawnOptions = { cwd: o.cwd, env: o.env ?? process.env, shell: true, stdio: "inherit", windowsHide: true };
    const hijo = spawnNode(linea, opts);
    hijo.on("error", () => resolve(127));
    hijo.on("close", (c) => resolve(c ?? 1));
  });
}

/** Return the first line of --version output or null when the command is unavailable. */
export function version(cmd: string, args = ["--version"], cwd?: string): string | null {
  const r = ejecutar(cmd, args, { cwd, timeoutMs: 20_000 });
  if (r.error || r.codigo !== 0) return null;
  return (r.stdout || r.stderr).trim().split(/\r?\n/)[0] ?? "";
}

/** Parse an argument vector while respecting single and double quotes. */
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
