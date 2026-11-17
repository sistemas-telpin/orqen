/** git, tests and PR: always run by the process, never by the agent. */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { parse as parseYaml } from "yaml";
import type { Config } from "./config.ts";

/** Environment setup result included in the agent context. */
export interface EnvironmentResult {
  ok: boolean;
  /** What completed or why setup failed. */
  detail: string;
  /** Connection variables also passed to tests. */
  variables?: Record<string, string>;
  /** Test commands available during development. */
  commands?: Record<string, string>;
  output?: string;
}

export interface Workspace {
  prepareBranch(key: string): string;
  /** `path` limits the commit to that path; `branch` commits only if it is the active branch (avoids committing on another REC's branch). */
  commit(key: string, message: string, opts?: { path?: string; branch?: string }): boolean;
  startEnvironment?(apps: boolean): EnvironmentResult;
  stopEnvironment?(): void;
  runTests(): { ok: boolean; output: string };
  push(branch: string): void;
  openPr(vars: Record<string, string>, command?: string): string;
}

export class GitWorkspace implements Workspace {
  constructor(private cfg: Config) {}
  private git = (...args: string[]) =>
    execFileSync("git", args, { cwd: this.cfg.repoPath, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

  prepareBranch(key: string) {
    const branch = `rec/${key.toLowerCase()}`;
    if (this.git("rev-parse", "--abbrev-ref", "HEAD") === branch) return branch;
    if (this.git("status", "--porcelain", "--untracked-files=no", ...this.excludeFactory()))
      throw new Error("The repo has uncommitted changes; cannot switch branches");
    try { this.git("fetch", "--all", "--prune"); } catch { /* no remote */ }
    if (this.git("branch", "--list", branch)) this.git("checkout", branch);
    else {
      this.git("checkout", this.cfg.baseBranch);
      try { this.git("pull", "--ff-only"); } catch { /* no remote */ }
      this.git("checkout", "-b", branch);
    }
    return branch;
  }

  /** Pathspec that excludes orqen/work/ (the process record must not prevent switching branches). */
  private excludeFactory(): string[] {
    const r = relative(this.cfg.repoPath, this.cfg.factoryDir).replaceAll("\\", "/");
    return r && !r.startsWith("..") ? ["--", ".", `:(exclude)${r}`] : [];
  }

  private relativePath(path: string) {
    const r = relative(this.cfg.repoPath, path).replaceAll("\\", "/");
    return r.startsWith("..") ? undefined : r;
  }

  commit(key: string, message: string, opts: { path?: string; branch?: string } = {}) {
    if (opts.branch && this.git("rev-parse", "--abbrev-ref", "HEAD") !== opts.branch) return false;
    const path = opts.path ? this.relativePath(opts.path) : undefined;
    if (opts.path && path === undefined) return false;
    const scope = path ? ["--", path] : [];
    this.git("add", "-A", ...scope);
    if (!this.git("status", "--porcelain", ...scope)) return false;
    this.git("commit", "-m", `${key}: ${message}`, ...scope);
    return true;
  }

  private runCommand(cmd: string, timeoutMin = 30) {
    const e = this.cfg.environment;
    const p = spawnSync(cmd, {
      shell: true, cwd: this.cfg.repoPath, encoding: "utf8", timeout: timeoutMin * 60_000,
      env: { ...process.env, ...e?.variables }, maxBuffer: 64 * 1024 * 1024,
    });
    return { ok: p.status === 0, output: ((p.stdout ?? "") + (p.stderr ?? "")).slice(-15_000) };
  }

  private compose(args: string, apps = false) {
    return `docker compose -f "${this.cfg.environment!.compose}"${apps ? " --profile apps" : ""} ${args}`;
  }

  /** Check for Compose services, including the apps profile when requested. */
  private hasComposeServices(apps: boolean): boolean {
    const e = this.cfg.environment;
    if (!e) return false;
    const ruta = join(this.cfg.repoPath, e.compose);
    if (!existsSync(ruta)) return false;
    try {
      const svcs = Object.values<any>(parseYaml(readFileSync(ruta, "utf8"))?.services ?? {});
      return svcs.some((s) => apps || !(s?.profiles ?? []).includes("apps"));
    } catch { return false; }
  }

  startEnvironment(apps: boolean): EnvironmentResult {
    const e = this.cfg.environment;
    if (!e) return { ok: true, detail: "No environment configuration in orqen/config.yaml. Run `orqen init`." };
    const commands = Object.fromEntries(Object.entries(e.tests).filter(([, v]) => v).map(([k]) => [k, `orqen env test ${k}`]));
    const hecho: string[] = [];
    const fallar = (paso: string, output: string): EnvironmentResult => ({
      ok: false, variables: e.variables, commands, output: output.slice(-3000),
      detail: `Failed: "${paso}". ${hecho.length ? `Completed: ${hecho.join(", ")}. ` : ""}Review orqen/config.yaml and ${e.compose}. If you cannot resolve the issue, block the request.`,
    });
    for (const cmd of e.preparar) { const r = this.runCommand(cmd); if (!r.ok) return fallar(cmd, r.output); }
    if (e.preparar.length) hecho.push("dependencies installed");
    if (this.hasComposeServices(apps)) {
      const r = this.runCommand(this.compose("up -d --wait --remove-orphans", apps), 15);
      if (!r.ok) return fallar("docker compose up", r.output);
      hecho.push(apps ? "services and apps started" : "services started");
    }
    for (const cmd of [...e.migrar, ...e.seed]) { const r = this.runCommand(cmd); if (!r.ok) return fallar(cmd, r.output); }
    if (e.migrar.length) hecho.push("migrations applied");
    if (e.seed.length) hecho.push("test data loaded");
    return { ok: true, detail: hecho.length ? `Environment ready: ${hecho.join(", ")}.` : "No environment setup needed.", variables: e.variables, commands };
  }

  stopEnvironment() {
    if (!this.cfg.environment || !this.hasComposeServices(true)) return;
    this.runCommand(this.compose("down -v --remove-orphans", true), 5);
  }

  runTests() {
    const tests = Object.entries(this.cfg.environment?.tests ?? {}).filter(([, v]) => v) as [string, string][];
    if (!tests.length) return this.runCommand(this.cfg.testCommand);
    // Run all configured test types using the environment variables.
    let ok = true, output = "";
    for (const [tipo, cmd] of tests) {
      const r = this.runCommand(cmd);
      ok &&= r.ok;
      output += `\n===== tests ${tipo}: ${cmd} → ${r.ok ? "OK" : "FAILED"} =====\n${r.output.slice(-Math.floor(15_000 / tests.length))}\n`;
    }
    return { ok, output: output.trim() };
  }

  push(branch: string) { this.git("push", "-u", "origin", branch); }

  openPr(vars: Record<string, string>, command = this.cfg.prCommand) {
    if (!command) return "";
    // values come from Jira: they are sanitized so they cannot inject shell
    const cmd = command.replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? "").replace(/["'`$\\;|&<>]/g, ""));
    const p = spawnSync(cmd, { shell: true, cwd: this.cfg.repoPath, encoding: "utf8" });
    return (p.stdout || p.stderr || "").trim();
  }
}
