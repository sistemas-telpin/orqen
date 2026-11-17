/** git, tests and PR: always run by the process, never by the agent. */
import { execFileSync, spawnSync } from "node:child_process";
import { relative } from "node:path";
import type { Config } from "./config.ts";

export interface Workspace {
  prepareBranch(key: string): string;
  /** `path` limits the commit to that path; `branch` commits only if it is the active branch (avoids committing on another REC's branch). */
  commit(key: string, message: string, opts?: { path?: string; branch?: string }): boolean;
  runTests(): { ok: boolean; output: string };
  push(branch: string): void;
  openPr(vars: Record<string, string>): string;
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

  runTests() {
    const p = spawnSync(this.cfg.testCommand, { shell: true, cwd: this.cfg.repoPath, encoding: "utf8", timeout: 30 * 60_000 });
    return { ok: p.status === 0, output: ((p.stdout ?? "") + (p.stderr ?? "")).slice(-15_000) };
  }

  push(branch: string) { this.git("push", "-u", "origin", branch); }

  openPr(vars: Record<string, string>) {
    if (!this.cfg.prCommand) return "";
    // values come from Jira: they are sanitized so they cannot inject shell
    const cmd = this.cfg.prCommand.replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? "").replace(/["'`$\\;|&<>]/g, ""));
    const p = spawnSync(cmd, { shell: true, cwd: this.cfg.repoPath, encoding: "utf8" });
    return (p.stdout || p.stderr || "").trim();
  }
}
