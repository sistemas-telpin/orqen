/** git, tests y PR: siempre los ejecuta el proceso, nunca el agente. */
import { execFileSync, spawnSync } from "node:child_process";
import { relative } from "node:path";
import type { Config } from "./config.ts";

export interface Workspace {
  prepararRama(key: string): string;
  /** `ruta` limita el commit a ese path; `rama` lo hace solo si es la rama activa (evita commitear en la rama de otro REC). */
  commit(key: string, mensaje: string, opts?: { ruta?: string; rama?: string }): boolean;
  correrTests(): { ok: boolean; salida: string };
  push(rama: string): void;
  abrirPr(vars: Record<string, string>): string;
}

export class GitWorkspace implements Workspace {
  constructor(private cfg: Config) {}
  private git = (...args: string[]) =>
    execFileSync("git", args, { cwd: this.cfg.repoPath, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

  prepararRama(key: string) {
    const rama = `rec/${key.toLowerCase()}`;
    if (this.git("rev-parse", "--abbrev-ref", "HEAD") === rama) return rama;
    if (this.git("status", "--porcelain", "--untracked-files=no", ...this.sinFactory()))
      throw new Error("El repo tiene cambios sin commitear; no puedo cambiar de rama");
    try { this.git("fetch", "--all", "--prune"); } catch { /* sin remoto */ }
    if (this.git("branch", "--list", rama)) this.git("checkout", rama);
    else {
      this.git("checkout", this.cfg.ramaBase);
      try { this.git("pull", "--ff-only"); } catch { /* sin remoto */ }
      this.git("checkout", "-b", rama);
    }
    return rama;
  }

  /** Pathspec que excluye factory/ (el registro del proceso no debe impedir cambiar de rama). */
  private sinFactory(): string[] {
    const r = relative(this.cfg.repoPath, this.cfg.factoryDir).replaceAll("\\", "/");
    return r && !r.startsWith("..") ? ["--", ".", `:(exclude)${r}`] : [];
  }

  private rutaRelativa(ruta: string) {
    const r = relative(this.cfg.repoPath, ruta).replaceAll("\\", "/");
    return r.startsWith("..") ? undefined : r;
  }

  commit(key: string, mensaje: string, opts: { ruta?: string; rama?: string } = {}) {
    if (opts.rama && this.git("rev-parse", "--abbrev-ref", "HEAD") !== opts.rama) return false;
    const ruta = opts.ruta ? this.rutaRelativa(opts.ruta) : undefined;
    if (opts.ruta && ruta === undefined) return false;
    const alcance = ruta ? ["--", ruta] : [];
    this.git("add", "-A", ...alcance);
    if (!this.git("status", "--porcelain", ...alcance)) return false;
    this.git("commit", "-m", `${key}: ${mensaje}`, ...alcance);
    return true;
  }

  correrTests() {
    const p = spawnSync(this.cfg.comandoTests, { shell: true, cwd: this.cfg.repoPath, encoding: "utf8", timeout: 30 * 60_000 });
    return { ok: p.status === 0, salida: ((p.stdout ?? "") + (p.stderr ?? "")).slice(-15_000) };
  }

  push(rama: string) { this.git("push", "-u", "origin", rama); }

  abrirPr(vars: Record<string, string>) {
    if (!this.cfg.comandoPr) return "";
    // los valores vienen de Jira: se limpian para que no puedan inyectar shell
    const cmd = this.cfg.comandoPr.replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? "").replace(/["'`$\\;|&<>]/g, ""));
    const p = spawnSync(cmd, { shell: true, cwd: this.cfg.repoPath, encoding: "utf8" });
    return (p.stdout || p.stderr || "").trim();
  }
}
