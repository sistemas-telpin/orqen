/** The workflow handles Git operations, tests, and pull requests. */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { parse as parseYaml } from "yaml";
import type { Config } from "./config.ts";

/** Environment setup result included in the agent context. */
export interface EstadoEntorno {
  ok: boolean;
  /** What completed or why setup failed. */
  detalle: string;
  /** Connection variables also passed to tests. */
  variables?: Record<string, string>;
  /** Test commands available during development. */
  comandos?: Record<string, string>;
  salida?: string;
}

export interface Workspace {
  /** Install dependencies, start services and optional apps, wait for health checks, migrate, and seed. */
  levantarEntorno?(apps: boolean): EstadoEntorno;
  bajarEntorno?(): void;
  prepararRama(key: string): string;
  /** Use ruta to scope the commit and rama to require the matching branch. */
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
      throw new Error("Cannot switch branches while the repository has uncommitted changes");
    try { this.git("fetch", "--all", "--prune"); } catch { /* A remote is optional. */ }
    if (this.git("branch", "--list", rama)) this.git("checkout", rama);
    else {
      this.git("checkout", this.cfg.ramaBase);
      try { this.git("pull", "--ff-only"); } catch { /* A remote is optional. */ }
      this.git("checkout", "-b", rama);
    }
    return rama;
  }

  /** Exclude the work record when checking whether the branch can change. */
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

  private linea(cmd: string, timeoutMin = 30) {
    const e = this.cfg.entorno;
    const p = spawnSync(cmd, {
      shell: true, cwd: this.cfg.repoPath, encoding: "utf8", timeout: timeoutMin * 60_000,
      env: { ...process.env, ...e?.variables }, maxBuffer: 64 * 1024 * 1024,
    });
    return { ok: p.status === 0, salida: ((p.stdout ?? "") + (p.stderr ?? "")).slice(-15_000) };
  }

  private compose(args: string, apps = false) {
    return `docker compose -f "${this.cfg.entorno!.compose}"${apps ? " --profile apps" : ""} ${args}`;
  }

  /** Check for Compose services, including the apps profile when requested. */
  private serviciosCompose(apps: boolean): boolean {
    const e = this.cfg.entorno;
    if (!e) return false;
    const ruta = join(this.cfg.repoPath, e.compose);
    if (!existsSync(ruta)) return false;
    try {
      const svcs = Object.values<any>(parseYaml(readFileSync(ruta, "utf8"))?.services ?? {});
      return svcs.some((s) => apps || !(s?.profiles ?? []).includes("apps"));
    } catch { return false; }
  }

  levantarEntorno(apps: boolean): EstadoEntorno {
    const e = this.cfg.entorno;
    if (!e) return { ok: true, detalle: "No environment configuration in orqen/config.yaml. Run `orqen init`." };
    const comandos = Object.fromEntries(Object.entries(e.tests).filter(([, v]) => v).map(([k]) => [k, `orqen env test ${k}`]));
    const hecho: string[] = [];
    const fallar = (paso: string, salida: string): EstadoEntorno => ({
      ok: false, variables: e.variables, comandos, salida: salida.slice(-3000),
      detalle: `Failed: "${paso}". ${hecho.length ? `Completed: ${hecho.join(", ")}. ` : ""}Review orqen/config.yaml and ${e.compose}. If you cannot resolve the issue, block the request.`,
    });
    for (const cmd of e.preparar) { const r = this.linea(cmd); if (!r.ok) return fallar(cmd, r.salida); }
    if (e.preparar.length) hecho.push("dependencies installed");
    if (this.serviciosCompose(apps)) {
      const r = this.linea(this.compose("up -d --wait --remove-orphans", apps), 15);
      if (!r.ok) return fallar("docker compose up", r.salida);
      hecho.push(apps ? "services and apps started" : "services started");
    }
    for (const cmd of [...e.migrar, ...e.seed]) { const r = this.linea(cmd); if (!r.ok) return fallar(cmd, r.salida); }
    if (e.migrar.length) hecho.push("migrations applied");
    if (e.seed.length) hecho.push("test data loaded");
    return { ok: true, detalle: hecho.length ? `Environment ready: ${hecho.join(", ")}.` : "No environment setup needed.", variables: e.variables, comandos };
  }

  bajarEntorno() {
    if (!this.cfg.entorno || !this.serviciosCompose(true)) return;
    this.linea(this.compose("down -v --remove-orphans", true), 5);
  }

  correrTests() {
    const tests = Object.entries(this.cfg.entorno?.tests ?? {}).filter(([, v]) => v) as [string, string][];
    if (!tests.length) return this.linea(this.cfg.comandoTests);
    // Run all configured test types using the environment variables.
    let ok = true, salida = "";
    for (const [tipo, cmd] of tests) {
      const r = this.linea(cmd);
      ok &&= r.ok;
      salida += `\n===== tests ${tipo}: ${cmd} → ${r.ok ? "OK" : "FAILED"} =====\n${r.salida.slice(-Math.floor(15_000 / tests.length))}\n`;
    }
    return { ok, salida: salida.trim() };
  }

  push(rama: string) { this.git("push", "-u", "origin", rama); }

  abrirPr(vars: Record<string, string>) {
    if (!this.cfg.comandoPr) return "";
    // Strip shell metacharacters from values supplied by Jira.
    const cmd = this.cfg.comandoPr.replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? "").replace(/["'`$\\;|&<>]/g, ""));
    const p = spawnSync(cmd, { shell: true, cwd: this.cfg.repoPath, encoding: "utf8" });
    return (p.stdout || p.stderr || "").trim();
  }
}
