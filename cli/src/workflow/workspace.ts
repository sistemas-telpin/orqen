/** git, tests and PR: always run by the process, never by the agent. */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { bajarProcesos, levantarProcesos, variablesConPuertos } from "../lib/processes.ts";
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
export interface PrState { state: "OPEN" | "MERGED" | "CLOSED"; mergedAt?: string; mergedBy?: string }
/** Health of a PR before approving it: the CI checks on its head and whether it merges cleanly into the base branch. */
export interface PrChecks {
  ci: "passing" | "failing" | "pending" | "none";
  failing: string[]; pending: string[];
  /** true: conflicts with the base branch; undefined: GitHub has not computed it yet. */
  conflicts?: boolean;
}

/** Reads `gh pr view --json mergeable,statusCheckRollup` (check runs and commit statuses). */
/** What went wrong running gh, as a sentence that tells the person what to do. */
export function ghFailure(e: unknown): string {
  const err = e as NodeJS.ErrnoException & { stderr?: string | Buffer };
  if (err.code === "ENOENT")
    return "the GitHub CLI (gh) is not installed or is not in the PATH: install it from https://cli.github.com, open a new terminal and log in with `gh auth login`";
  const stderr = String(err.stderr ?? "").trim();
  if (/auth login|not logged in|authentication/i.test(stderr)) return `gh is not logged in: run \`gh auth login\` (${stderr.split("\n")[0]})`;
  return (stderr || err.message || "gh failed").split("\n")[0];
}

export function parsePrChecks(j: { mergeable?: string; statusCheckRollup?: Array<Record<string, any>> }): PrChecks {
  const failing: string[] = [], pending: string[] = [];
  let total = 0;
  for (const c of j.statusCheckRollup ?? []) {
    total++;
    const name = c.name || c.context || c.workflowName || "check";
    if (c.__typename === "StatusContext" || (c.state && !c.status)) {
      const s = String(c.state ?? "").toUpperCase();
      if (s === "FAILURE" || s === "ERROR") failing.push(name); else if (s !== "SUCCESS") pending.push(name);
    } else if (String(c.status ?? "").toUpperCase() !== "COMPLETED") pending.push(name);
    else if (["FAILURE", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"].includes(String(c.conclusion ?? "").toUpperCase())) failing.push(name);
  }
  const m = String(j.mergeable ?? "").toUpperCase();
  return {
    ci: failing.length ? "failing" : pending.length ? "pending" : total ? "passing" : "none", failing, pending,
    conflicts: m === "CONFLICTING" ? true : m === "MERGEABLE" ? false : undefined,
  };
}

export interface Workspace {
  prepareBranch(key: string): string;
  currentBranch(): string;
  /** `path` limits the commit to that path; `branch` commits only if it is the active branch (avoids committing on another request's branch). */
  commit(key: string, message: string, opts?: { path?: string; branch?: string }): boolean;
  /** Install dependencies, start the processes (all, or only `cuando: siempre`), wait until ready, migrate and seed. */
  startEnvironment?(all: boolean): Promise<EnvironmentResult>;
  stopEnvironment?(): void;
  runTests(): { ok: boolean; output: string };
  push(branch: string): void;
  openPr(vars: Record<string, string>, command: string): string;
  /** Whether the branch exists on the remote; undefined when it cannot be known. The PR needs its base branch there. */
  remoteBranchExists?(branch: string): boolean | undefined;
  /** Reviews of the PR and its head commit; the senior's decision when CODE_REVIEW_GATE=github. */
  prReviews?(url: string): { head: string; reviews: PrReview[] };
  /** State of the PR (gh): whether a person already merged it, and who. */
  prState?(url: string): PrState;
  /** CI checks and conflicts of the PR (gh): the senior does not approve a red or conflicting PR. */
  prChecks?(url: string): PrChecks;
  /** Closes the PR without merging it, with a comment (gh). Used when a request is cancelled. */
  closePr?(url: string, comment: string): void;
  /** Posts the senior's review on the PR with their own GitHub session (gh). */
  reviewPr?(url: string, action: "approve" | "request-changes", body: string): void;
  /** The newest orqen/worqs/<KEY>/state.json snapshot of a worq (also orqen/work/ of earlier versions), from the working tree or from its branch (local or origin/). */
  snapshotOf?(key: string): { snapshot: unknown; source: string } | undefined;
}

/** Branch where a request is developed. */
export const branchFor = (key: string) => `orqen/${key.toLowerCase()}`;
const legacyBranchFor = (key: string) => `rec/${key.toLowerCase()}`;

export class GitWorkspace implements Workspace {
  constructor(private cfg: Config) {}
  private git = (...args: string[]) =>
    execFileSync("git", args, { cwd: this.cfg.repoPath, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

  currentBranch() { return this.git("rev-parse", "--abbrev-ref", "HEAD"); }

  prepareBranch(key: string) {
    const legacy = legacyBranchFor(key);   // requests started with an earlier version keep their branch
    const branch = this.git("branch", "--list", legacy) ? legacy : branchFor(key);
    if (this.currentBranch() === branch) return branch;
    const dirty = this.git("status", "--porcelain", "--untracked-files=no", ...this.excludeFactory());
    if (dirty) {
      // git() trims the output, so the first line loses its leading space: do not cut by position
      const files = dirty.split("\n").map((l) => l.replace(/^\s*\S{1,2}\s+/, "").trim()).filter(Boolean);
      throw new Error(`The repo has uncommitted changes (${files.slice(0, 4).join(", ")}${files.length > 4 ? `, … ${files.length - 4} more` : ""}); cannot switch to the request branch. ` +
        "Commit or stash them first. Right after `orqen init`, commit the files it wrote: git add -A && git commit -m \"Install orqen\" (or run `orqen init --commit`).");
    }
    try { this.git("fetch", "--all", "--prune"); } catch { /* no remote */ }
    if (this.git("branch", "--list", branch)) this.git("checkout", branch);
    else if (this.linkedWorktree()) {
      // the base branch is usually checked out in the main worktree, where git does not let us check it out again
      const base = this.git("branch", "-r", "--list", `origin/${this.cfg.baseBranch}`) ? `origin/${this.cfg.baseBranch}` : this.cfg.baseBranch;
      this.git("checkout", "-b", branch, base);
    } else {
      this.git("checkout", this.cfg.baseBranch);
      try { this.git("pull", "--ff-only"); } catch { /* no remote */ }
      this.git("checkout", "-b", branch);
    }
    return branch;
  }

  /** Whether the repo is a linked worktree (`git worktree add`; the desktop app gives each request its own). */
  private linkedWorktree(): boolean {
    try { return resolve(this.cfg.repoPath, this.git("rev-parse", "--git-dir")) !== resolve(this.cfg.repoPath, this.git("rev-parse", "--git-common-dir")); }
    catch { return false; }
  }

  /** Pathspec that excludes orqen/worqs/ (the process record must not prevent switching branches). */
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
    // conversation.json (`orqen ask` / `orqen conversation`) keeps the client's replies, which do not belong in the repository
    const scope = path ? ["--", path, `:(exclude,glob)${path}/conversation.json`, `:(exclude,glob)${path}/**/conversation.json`] : [];
    this.git("add", "-A", ...scope);
    if (!this.git("status", "--porcelain", ...scope)) return false;
    this.git("commit", "-m", `${key}: ${message}`, ...scope);
    return true;
  }

  private runCommand(cmd: string, timeoutMin = 30) {
    const e = this.cfg.environment;
    const p = spawnSync(cmd, {
      shell: true, cwd: this.cfg.repoPath, encoding: "utf8", timeout: timeoutMin * 60_000,
      env: { ...process.env, ...(e ? variablesConPuertos(this.cfg.repoPath, e.procesos, e.variables) : {}) }, maxBuffer: 64 * 1024 * 1024,
    });
    return { ok: p.status === 0, output: ((p.stdout ?? "") + (p.stderr ?? "")).slice(-15_000) };
  }

  async startEnvironment(all: boolean): Promise<EnvironmentResult> {
    const e = this.cfg.environment;
    if (!e) return { ok: true, detail: "No environment configuration in orqen/config.yaml. Run `orqen init`." };
    // English test type names, as in orqen/environment.yaml (unitarios/integracion are the internal names)
    const en: Record<string, string> = { unitarios: "unit", integracion: "integration" };
    const commands = Object.fromEntries(Object.entries(e.tests).filter(([, v]) => v).map(([k]) => [en[k] ?? k, `orqen env test ${en[k] ?? k}`]));
    const done: string[] = [];
    const fail = (step: string, output: string): EnvironmentResult => ({
      ok: false, variables: variablesConPuertos(this.cfg.repoPath, e.procesos, e.variables), commands, output: output.slice(-3000),
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
    return { ok: true, detail: done.length ? `Environment ready: ${done.join("; ")}.` : "No environment setup needed.", variables: variablesConPuertos(this.cfg.repoPath, e.procesos, e.variables), commands };
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

  /** Runs gh (execFile, no shell) and fails with a message that says what to do: not installed, not logged in... */
  private gh(args: string[]): string {
    try {
      return execFileSync("gh", args, { cwd: this.cfg.repoPath, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) { throw new Error(ghFailure(e)); }
  }

  /** Whether the branch exists on origin; undefined when it cannot be known (no remote, offline): that never blocks. */
  remoteBranchExists(branch: string): boolean | undefined {
    const r = spawnSync("git", ["ls-remote", "--exit-code", "--heads", "origin", branch], { cwd: this.cfg.repoPath, encoding: "utf8", windowsHide: true });
    if (r.status === 0) return true;
    return r.status === 2 ? false : undefined;   // 2: the remote answered and the branch is not there
  }

  prReviews(url: string) {
    // the url comes from the PR output stored by orqen, but it is never interpolated into a command line
    const out = this.gh(["pr", "view", url, "--json", "headRefOid,reviews"]);
    const j = JSON.parse(out) as { headRefOid: string; reviews?: Array<{ id: string; author?: { login?: string }; state: string; body?: string; commit?: { oid?: string } }> };
    return {
      head: j.headRefOid,
      reviews: (j.reviews ?? []).map((r) => ({ id: r.id, author: r.author?.login ?? "", state: r.state, commit: r.commit?.oid ?? "", body: r.body ?? "" })),
    };
  }

  snapshotOf(key: string) {
    if (!/^[\w.-]+$/.test(key)) return undefined;
    const file = join(this.cfg.factoryDir, key, "state.json");
    const rel = relative(this.cfg.repoPath, file).split(sep).join("/");
    if (rel.startsWith("..")) return undefined;   // the worqs folder is outside the repository: nothing to read from git
    // where the worq can be: the configured folder, orqen/worqs/ and (branches of earlier versions) orqen/work/
    const rels = [...new Set([rel, `orqen/worqs/${key}/state.json`, `orqen/work/${key}/state.json`])];
    const found: Array<{ snapshot: any; source: string }> = [];
    const add = (source: string, text: () => string) => {
      try { found.push({ snapshot: JSON.parse(text()), source }); } catch { /* not there, or not valid */ }
    };
    for (const p of rels) { const disk = join(this.cfg.repoPath, p); if (existsSync(disk)) add(p, () => readFileSync(disk, "utf8")); }
    for (const ref of [branchFor(key), legacyBranchFor(key)])
      for (const r of [ref, `origin/${ref}`])
        for (const p of rels) add(`${r}:${p}`, () => this.git("show", `${r}:${p}`));
    const time = (x: { snapshot: any }) => Date.parse(x.snapshot?.updated ?? "") || 0;
    return found.sort((a, b) => time(b) - time(a))[0];
  }

  prState(url: string): PrState {
    const out = this.gh(["pr", "view", url, "--json", "state,mergedAt,mergedBy"]);
    const j = JSON.parse(out) as { state: string; mergedAt?: string; mergedBy?: { login?: string } };
    return { state: j.state === "MERGED" ? "MERGED" : j.state === "CLOSED" ? "CLOSED" : "OPEN", mergedAt: j.mergedAt || undefined, mergedBy: j.mergedBy?.login || undefined };
  }

  prChecks(url: string): PrChecks {
    const out = this.gh(["pr", "view", url, "--json", "mergeable,statusCheckRollup"]);
    return parsePrChecks(JSON.parse(out));
  }

  closePr(url: string, comment: string) {
    // execFile (no shell): the comment is an argument, never part of a command line
    const r = spawnSync("gh", ["pr", "close", url, "--comment", comment], { cwd: this.cfg.repoPath, encoding: "utf8", windowsHide: true });
    if (r.error) throw new Error(`could not run gh (${r.error.message})`);
    if (r.status !== 0) throw new Error(`gh pr close failed: ${(r.stderr || r.stdout || "").trim() || `exit code ${r.status}`}`);
  }

  reviewPr(url: string, action: "approve" | "request-changes", body: string) {
    // execFile (no shell) and the body through stdin: nothing of it reaches a command line
    const r = spawnSync("gh", ["pr", "review", url, `--${action}`, "--body-file", "-"], {
      cwd: this.cfg.repoPath, encoding: "utf8", input: body, windowsHide: true,
    });
    if (r.error) throw new Error(`could not run gh (${r.error.message}): install the GitHub CLI and log in with \`gh auth login\``);
    if (r.status !== 0) {
      const out = (r.stderr || r.stdout || "").trim();
      if (/own pull request/i.test(out)) throw new Error(`GitHub does not let the PR's author review it (${out}). Another person has to approve it, or use CODE_REVIEW_GATE=ticket.`);
      throw new Error(`gh pr review failed: ${out || `exit code ${r.status}`}`);
    }
  }

  openPr(vars: Record<string, string>, command: string) {
    if (!command) return "";
    // values come from the tickets: they are sanitized so they cannot inject shell
    const cmd = command.replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? "").replace(/["'`$\\;|&<>]/g, ""));
    const p = spawnSync(cmd, { shell: true, cwd: this.cfg.repoPath, encoding: "utf8" });
    return (p.stdout || p.stderr || "").trim();
  }
}
