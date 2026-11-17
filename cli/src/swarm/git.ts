/**
 * Git worktrees for the swarm. The integration branch and each subtask live in their own worktree,
 * so the person's checkout is never touched. Git calls are synchronous, so they never interleave
 * even when many workers finish at the same time.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ejecutar } from "../lib/proc.ts";

export class GitError extends Error {}

function git(cwd: string, args: string[], allowFail = false) {
  const r = ejecutar("git", args, { cwd, timeoutMs: 120_000 });
  if (!allowFail && (r.error || r.codigo !== 0)) {
    throw new GitError(`git ${args.join(" ")} failed: ${(r.stderr || r.stdout || r.error?.message || "").trim()}`);
  }
  return r;
}

/** Identity for swarm commits when the repository has none configured. */
function identityArgs(cwd: string): string[] {
  const name = git(cwd, ["config", "user.name"], true).stdout.trim();
  const email = git(cwd, ["config", "user.email"], true).stdout.trim();
  return [...(name ? [] : ["-c", "user.name=orqen swarm"]), ...(email ? [] : ["-c", "user.email=swarm@orqen.local"])];
}

export class SwarmGit {
  readonly repo: string;
  readonly runId: string;
  readonly root: string;
  readonly integrationBranch: string;
  readonly integrationDir: string;
  readonly baseCommit: string;
  private readonly baseBranch: string;
  private readonly identity: string[];

  constructor(repo: string, runId: string, root: string) {
    this.repo = repo; this.runId = runId; this.root = root;
    if (git(repo, ["rev-parse", "--is-inside-work-tree"], true).stdout.trim() !== "true") throw new GitError(`${repo} is not a git repository`);
    const head = git(repo, ["rev-parse", "--verify", "HEAD"], true);
    if (head.codigo !== 0) throw new GitError("The repository has no commits yet: commit something before running the swarm");
    this.baseCommit = head.stdout.trim();
    this.baseBranch = git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim();
    this.integrationBranch = `orqen/swarm-${runId}`;
    this.integrationDir = join(root, "_integration");
    this.identity = identityArgs(repo);
  }

  /** True when the person's checkout has uncommitted changes (they are not part of the swarm's base). */
  dirty(): boolean {
    return git(this.repo, ["status", "--porcelain", "--untracked-files=no"]).stdout.trim() !== "";
  }

  start() {
    mkdirSync(this.root, { recursive: true });
    git(this.repo, ["worktree", "add", "-q", "-b", this.integrationBranch, this.integrationDir, this.baseCommit]);
  }

  taskBranch(id: string) { return `orqen/swarm-${this.runId}-tasks/${id}`; }

  /** Create (or reuse) the subtask worktree, positioned on the integration branch's latest commit. */
  taskWorktree(id: string): string {
    const dir = join(this.root, id);
    if (!existsSync(dir)) git(this.repo, ["worktree", "add", "-q", "-B", this.taskBranch(id), dir, this.integrationBranch]);
    else this.resetTask(dir);
    return dir;
  }

  /** Discard a failed attempt and move to the latest integration commit. Ignored files (node_modules) survive. */
  resetTask(dir: string) {
    git(dir, ["reset", "-q", "--hard", this.integrationBranch]);
    git(dir, ["clean", "-q", "-fd"]);
  }

  /** Files changed in a worktree (including new untracked files). */
  changes(dir: string): string[] {
    return git(dir, ["status", "--porcelain", "--untracked-files=all"]).stdout
      .split(/\r?\n/).filter(Boolean).map((l) => l.slice(3).replace(/^"|"$/g, ""));
  }

  /** Commit everything in the worktree. Returns false when there is nothing to commit. */
  commitAll(dir: string, message: string): boolean {
    git(dir, ["add", "-A"]);
    if (git(dir, ["diff", "--cached", "--quiet"], true).codigo === 0) return false;
    git(dir, [...this.identity, "commit", "-q", "--no-verify", "-m", message]);
    return true;
  }

  /** Merge a subtask branch into the integration branch. On conflict the merge is aborted. */
  merge(id: string, message: string): { ok: true } | { ok: false; conflicts: string[]; detail: string } {
    const r = git(this.integrationDir, [...this.identity, "merge", "--no-ff", "--no-edit", "-m", message, this.taskBranch(id)], true);
    if (r.codigo === 0) return { ok: true };
    const conflicts = git(this.integrationDir, ["diff", "--name-only", "--diff-filter=U"], true).stdout.split(/\r?\n/).filter(Boolean);
    git(this.integrationDir, ["merge", "--abort"], true);
    return { ok: false, conflicts, detail: (r.stdout + r.stderr).trim() };
  }

  commitIntegration(message: string): boolean { return this.commitAll(this.integrationDir, message); }

  /** Commits on the integration branch since the base. */
  log(): string[] {
    return git(this.repo, ["log", "--oneline", "--first-parent", `${this.baseCommit}..${this.integrationBranch}`]).stdout.split(/\r?\n/).filter(Boolean);
  }

  /** Refuse detached HEADs, pending edits and changes to the starting checkout. */
  checkApply(): void {
    if (this.baseBranch === "HEAD") throw new GitError("Cannot apply a swarm result to a detached HEAD");
    const current = git(this.repo, ["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim();
    const head = git(this.repo, ["rev-parse", "HEAD"]).stdout.trim();
    if (current !== this.baseBranch || head !== this.baseCommit) throw new GitError("The checkout changed while the swarm ran; review the integration branch before applying it.");
    if (this.dirty()) throw new GitError("The checkout has uncommitted changes; commit or move aside pending changes before applying a swarm result.");
  }

  /** Bring a verified result into the original checkout without overwriting intervening work. */
  apply(branch: string): void {
    this.checkApply();
    git(this.repo, ["merge", "--ff-only", "--", branch]);
  }

  /** Remove worktrees and subtask branches. The integration branch stays (it is the result). */
  cleanup(o: { keepIntegrationWorktree?: boolean } = {}) {
    const list = git(this.repo, ["worktree", "list", "--porcelain"], true).stdout;
    const dirs = list.split(/\r?\n/).filter((l) => l.startsWith("worktree ")).map((l) => l.slice(9).trim());
    // Git expands Windows short paths (MATEO-~1); compare canonical paths on both sides.
    const norm = (p: string) => (existsSync(p) ? realpathSync.native(p) : p).replace(/\\/g, "/").toLowerCase();
    for (const d of dirs) {
      if (!norm(d).startsWith(norm(this.root) + "/")) continue;
      if (o.keepIntegrationWorktree && norm(d) === norm(this.integrationDir)) continue;
      git(this.repo, ["worktree", "remove", "--force", d], true);
    }
    const branches = git(this.repo, ["for-each-ref", "--format=%(refname:short)", `refs/heads/orqen/swarm-${this.runId}-tasks/`], true).stdout.split(/\r?\n/).filter(Boolean);
    for (const b of branches) git(this.repo, ["branch", "-q", "-D", b], true);
    git(this.repo, ["worktree", "prune"], true);
    if (!o.keepIntegrationWorktree) { try { rmSync(this.root, { recursive: true, force: true }); } catch { /* Windows may hold files briefly. */ } }
  }
}

export interface LineResult { code: number; output: string; timedOut: boolean }

/** Run a shell command line (sh or cmd.exe) and capture its output. */
export function runLine(line: string, cwd: string, timeoutMs = 20 * 60_000): Promise<LineResult> {
  return new Promise((resolve) => {
    let output = "", timedOut = false, done = false;
    const child = spawn(line, { cwd, shell: true, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CI: process.env.CI ?? "1" } });
    const timer = setTimeout(() => {
      if (done) return;
      timedOut = true;
      if (process.platform === "win32" && child.pid) ejecutar("taskkill", ["/pid", String(child.pid), "/T", "/F"]);
      else child.kill("SIGKILL");
    }, timeoutMs);
    const add = (d: Buffer) => { output += d; if (output.length > 2_000_000) output = output.slice(-1_000_000); };
    child.stdout?.on("data", add);
    child.stderr?.on("data", add);
    child.on("error", (e) => { done = true; clearTimeout(timer); resolve({ code: 127, output: output + e.message, timedOut }); });
    child.on("close", (code) => { done = true; clearTimeout(timer); resolve({ code: code ?? 1, output, timedOut }); });
  });
}
