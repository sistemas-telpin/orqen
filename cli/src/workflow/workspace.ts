/** git, tests and PR: always run by the process, never by the agent. */
import { execFileSync, spawnSync } from "node:child_process";
import { relative } from "node:path";
import { bajarProcesos, levantarProcesos } from "../lib/processes.ts";
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

/** A review left on the PR (GitHub). `commit` is the commit it was submitted on. */
export interface PrReview { id: string; author: string; state: string; commit: string; body: string }

export interface Workspace {
  prepareBranch(key: string): string;
  currentBranch(): string;
  /** `path` limits the commit to that path; `branch` commits only if it is the active branch (avoids committing on another REC's branch). */
  commit(key: string, message: string, opts?: { path?: string; branch?: string }): boolean;
  /** Install dependencies, start the processes (all, or only `cuando: siempre`), wait until ready, migrate and seed. */
  startEnvironment?(all: boolean): Promise<EnvironmentResult>;
  stopEnvironment?(): void;
  runTests(): { ok: boolean; output: string };
  push(branch: string): void;
  openPr(vars: Record<string, string>, command: string): string;
  /** Reviews of the PR and its head commit; the senior's decision when CODE_REVIEW_GATE=github. */
  prReviews?(url: string): { head: string; reviews: PrReview[] };
}

export class GitWorkspace implements Workspace {
  constructor(private cfg: Config) {}
  private git = (...args: string[]) =>
    execFileSync("git", args, { cwd: this.cfg.repoPath, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

  currentBranch() { return this.git("rev-parse", "--abbrev-ref", "HEAD"); }

  prepareBranch(key: string) {
    const branch = `rec/${key.toLowerCase()}`;
    if (this.currentBranch() === branch) return branch;
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
    if (opts.branch && this.currentBranch() !== opts.branch) return false;
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

  async startEnvironment(all: boolean): Promise<EnvironmentResult> {
    const e = this.cfg.environment;
    if (!e) return { ok: true, detail: "No environment configuration in orqen/config.yaml. Run `orqen init`." };
    const commands = Object.fromEntries(Object.entries(e.tests).filter(([, v]) => v).map(([k]) => [k, `orqen env test ${k}`]));
    const done: string[] = [];
    const fail = (step: string, output: string): EnvironmentResult => ({
      ok: false, variables: e.variables, commands, output: output.slice(-3000),
      detail: `Failed: "${step}". ${done.length ? `Completed: ${done.join("; ")}. ` : ""}Review entornos in orqen/config.yaml. If you cannot resolve it, ask the person (or block the request when nobody can answer).`,
    });
    for (const cmd of e.preparar) { const r = this.runCommand(cmd); if (!r.ok) return fail(cmd, r.output); }
    if (e.preparar.length) done.push("dependencies installed");
    if (e.procesos.length) {
      const r = await levantarProcesos(this.cfg.repoPath, e.procesos, e.variables, { todos: all });
      if (!r.ok) return fail(r.detalle, r.salida ?? "");
      if (r.levantados.length) done.push(`processes: ${r.levantados.join(", ")}`);
    }
    for (const cmd of [...e.migrar, ...e.seed]) { const r = this.runCommand(cmd); if (!r.ok) return fail(cmd, r.output); }
    if (e.migrar.length) done.push("migrations applied");
    if (e.seed.length) done.push("test data loaded");
    return { ok: true, detail: done.length ? `Environment ready: ${done.join("; ")}.` : "No environment setup needed.", variables: e.variables, commands };
  }

  stopEnvironment() {
    bajarProcesos(this.cfg.repoPath);
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

  prReviews(url: string) {
    // execFile (no shell): the url comes from the PR output stored by orqen, but it is never interpolated into a command line
    const out = execFileSync("gh", ["pr", "view", url, "--json", "headRefOid,reviews"], {
      cwd: this.cfg.repoPath, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    });
    const j = JSON.parse(out) as { headRefOid: string; reviews?: Array<{ id: string; author?: { login?: string }; state: string; body?: string; commit?: { oid?: string } }> };
    return {
      head: j.headRefOid,
      reviews: (j.reviews ?? []).map((r) => ({ id: r.id, author: r.author?.login ?? "", state: r.state, commit: r.commit?.oid ?? "", body: r.body ?? "" })),
    };
  }

  openPr(vars: Record<string, string>, command: string) {
    if (!command) return "";
    // values come from Jira: they are sanitized so they cannot inject shell
    const cmd = command.replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? "").replace(/["'`$\\;|&<>]/g, ""));
    const p = spawnSync(cmd, { shell: true, cwd: this.cfg.repoPath, encoding: "utf8" });
    return (p.stdout || p.stderr || "").trim();
  }
}
