import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { SwarmGit } from "../src/swarm/git.ts";
import { repoTemporal } from "./helpers.ts";

const CLI = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const TSX = fileURLToPath(new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url));
const git = (repo: string, ...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
function setup() {
  const repo = repoTemporal({
    "README.md": "# Example\n",
    ".gitignore": "orqen/state/\n",
    "check.mjs": 'import { readFileSync } from "node:fs"; if (readFileSync("result.txt", "utf8") !== "done") process.exit(1);\n',
  });
  git(repo, "config", "user.name", "orqen-test");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "add", "."); git(repo, "commit", "-qm", "Initial");
  git(repo, "checkout", "-qb", "rec/rec-32");
  return repo;
}
function run(repo: string, apply: boolean, success = true) {
  const tools = repoTemporal({}, false);
  const worker = join(tools, "worker.mjs"), plan = join(tools, "plan.json");
  writeFileSync(worker, `import { readFileSync, writeFileSync } from "node:fs"; readFileSync(0, "utf8"); writeFileSync("result.txt", ${JSON.stringify(success ? "done" : "wrong")});`);
  writeFileSync(plan, JSON.stringify({ summary: "Implement SIS-32", subtasks: [{ id: "result", title: "Result", description: "Write result.txt", files: ["result.txt"], test: "node check.mjs" }] }));
  return spawnSync(process.execPath, [TSX, CLI, "swarm", "--dir", repo, "--plan", plan, "--small", `node "${worker}"`, "--large", `node "${worker}"`, "--small-attempts", "1", "--large-attempts", "1", "--no-setup", "--yes", "--json", ...(apply ? ["--apply"] : [])], { encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
}

test("--apply integrates a verified result into the starting request branch", () => {
  const repo = setup();
  const result = run(repo, true);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.applied, true);
  assert.equal(git(repo, "branch", "--show-current"), "rec/rec-32");
  assert.equal(readFileSync(join(repo, "result.txt"), "utf8"), "done");
  assert.equal(git(repo, "rev-parse", "HEAD"), git(repo, "rev-parse", report.branch));
  assert.equal(git(repo, "worktree", "list", "--porcelain").split(/\r?\n/).filter((line) => line.startsWith("worktree ")).length, 1);
});

test("a failed swarm never applies its partial result", () => {
  const repo = setup(), base = git(repo, "rev-parse", "HEAD");
  const result = run(repo, true, false);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, false);
  assert.equal(report.applied, false);
  assert.equal(git(repo, "rev-parse", "HEAD"), base);
  assert.equal(existsSync(join(repo, "result.txt")), false);
});

test("standalone swarm keeps its existing behavior unless --apply is requested", () => {
  const repo = setup(), base = git(repo, "rev-parse", "HEAD");
  const result = run(repo, false);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(JSON.parse(result.stdout).applied, false);
  assert.equal(git(repo, "rev-parse", "HEAD"), base);
  assert.equal(existsSync(join(repo, "result.txt")), false);
});

test("--apply refuses pending tracked edits before workers run", () => {
  const repo = setup();
  writeFileSync(join(repo, "README.md"), "Personal edits\n");
  const result = run(repo, true);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /pending changes/);
  assert.equal(readFileSync(join(repo, "README.md"), "utf8"), "Personal edits\n");
  assert.equal(git(repo, "branch", "--list", "orqen/swarm-*"), "");
});

test("apply refuses branch or commit changes made during execution", () => {
  const repo = setup();
  const runner = new SwarmGit(repo, "guard", join(repoTemporal({}, false), "worktrees"));
  git(repo, "checkout", "-qb", "other");
  assert.throws(() => runner.apply("other"), /checkout changed/);
  git(repo, "checkout", "-q", "rec/rec-32");
  git(repo, "commit", "--allow-empty", "-qm", "Intervening commit");
  assert.throws(() => runner.apply("other"), /checkout changed/);
});

test("apply preserves edits made while workers were running", () => {
  const repo = setup();
  const runner = new SwarmGit(repo, "guard", join(repoTemporal({}, false), "worktrees"));
  writeFileSync(join(repo, "README.md"), "Personal work\n");
  assert.throws(() => runner.apply("rec/rec-32"), /uncommitted changes/);
  assert.equal(readFileSync(join(repo, "README.md"), "utf8"), "Personal work\n");
});
