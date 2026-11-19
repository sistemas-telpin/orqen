/** Linked worktrees (the desktop app gives each request its own): shared state and .env, branch without checking out the base. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { loadConfig, mainWorktree } from "../src/workflow/config.ts";
import { GitWorkspace } from "../src/workflow/workspace.ts";
import { testConnectors } from "./fakes.ts";

const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function repoWithWorktree() {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), "orqen-wt-")));   // native: expands Windows short names (ENZO-S~1)
  const main = join(base, "main");
  mkdirSync(main);
  git(main, "init", "-q", "-b", "main");
  git(main, "config", "user.email", "t@t"); git(main, "config", "user.name", "t");
  writeFileSync(join(main, "a.txt"), "a\n");
  git(main, "add", "."); git(main, "commit", "-qm", "init");
  const wt = join(base, "wt-req-1");
  git(main, "worktree", "add", "-q", "--detach", wt);
  return { main, wt };
}

test("mainWorktree finds the main working tree from a linked worktree, and returns the repo itself otherwise", () => {
  const { main, wt } = repoWithWorktree();
  assert.equal(mainWorktree(wt), main);
  assert.equal(mainWorktree(main), main);
});

test("a worktree uses the main worktree's state dir and orqen/.env", () => {
  const { main, wt } = repoWithWorktree();
  mkdirSync(join(main, "orqen"), { recursive: true });
  writeFileSync(join(main, "orqen", ".env"), "ORQEN_WT_TEST=from-main\n");
  delete process.env.ORQEN_STATE_DIR; delete process.env.REC_STATE_DIR;
  const cwd = process.cwd();
  try {
    process.chdir(wt);
    const cfg = loadConfig();
    assert.equal(resolve(cfg.repoPath), wt);   // git prints C:/… on Windows
    assert.equal(cfg.stateDir, join(main, "cli", ".state"));   // no orqen/config.yaml in this repo: the legacy state dir, still the main one
    assert.equal(process.env.ORQEN_WT_TEST, "from-main");
  } finally {
    process.chdir(cwd);
    delete process.env.ORQEN_WT_TEST;
  }
});

test("prepareBranch in a linked worktree creates the request branch from the base without checking the base out", () => {
  const { main, wt } = repoWithWorktree();
  const cfg = loadConfig({ repoPath: wt, baseBranch: "main", factoryDir: join(wt, "orqen", "work"), connectors: testConnectors(), approvers: { code: [], client: [] } });
  const branch = new GitWorkspace(cfg).prepareBranch("REQ-1");
  assert.equal(branch, "orqen/req-1");
  assert.equal(git(wt, "branch", "--show-current"), "orqen/req-1");
  assert.equal(git(main, "branch", "--show-current"), "main");
});
