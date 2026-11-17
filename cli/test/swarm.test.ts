/** Swarm orchestrator with fake planner and worker agents on real git worktrees. */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Plan, planTask, topologicalOrder, validatePlan } from "../src/swarm/plan.ts";
import { runSwarm, type Tier } from "../src/swarm/run.ts";
import { repoTemporal } from "./helpers.ts";

const WORKER = `
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
const [tier, behaviorPath] = process.argv.slice(2);
const b = JSON.parse(readFileSync(behaviorPath, "utf8"));
const prompt = readFileSync(0, "utf8");
if (prompt.includes("ORQEN swarm integrator")) { if (b.fixFinal) writeFileSync("FINAL", "ok"); process.exit(0); }
const id = prompt.match(/Your subtask: ([a-z0-9-]+)/)[1];
appendFileSync(b.trace, "start " + id + " " + tier + "\\n");
await new Promise((r) => setTimeout(r, b.sleep ?? 0));
const bad = (b.failOn?.[tier] ?? []).includes(id);
mkdirSync("out", { recursive: true });
writeFileSync("out/" + id + ".txt", bad ? "wrong" : "ok-" + id);
appendFileSync(b.trace, "end " + id + " " + tier + "\\n");
`;

/** node check.mjs <id> [deps...]: passes when out/<id>.txt is right and every dependency file exists. */
const CHECK = `
import { existsSync, readFileSync } from "node:fs";
const [id, ...deps] = process.argv.slice(2);
const ok = existsSync("out/" + id + ".txt") && readFileSync("out/" + id + ".txt", "utf8") === "ok-" + id && deps.every((d) => existsSync("out/" + d + ".txt"));
if (!ok) { console.error("check " + id + " failed"); process.exit(1); }
`;

function setup(behavior: Record<string, unknown> = {}) {
  const repo = repoTemporal({ "check.mjs": CHECK, "check-final.mjs": `import { existsSync } from "node:fs"; process.exit(existsSync("FINAL") ? 0 : 1);\n`, "README.md": "# demo\n" });
  execFileSync("git", ["add", "-A"], { cwd: repo });
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init"], { cwd: repo });
  const tools = mkdtempSync(join(tmpdir(), "orqen-swarm-tools-"));
  const worker = join(tools, "worker.mjs"), behaviorPath = join(tools, "behavior.json"), trace = join(tools, "trace.txt");
  writeFileSync(worker, WORKER);
  writeFileSync(trace, "");
  writeFileSync(behaviorPath, JSON.stringify({ trace, ...behavior }));
  const tiers: Tier[] = [
    { name: "small", command: `node "${worker}" small "${behaviorPath}"`, attempts: 2 },
    { name: "large", command: `node "${worker}" large "${behaviorPath}"`, attempts: 2 },
  ];
  return { repo, tiers, trace, tools, worktreeRoot: join(tools, "wt"), stateDir: join(tools, "state") };
}

const sub = (id: string, dependsOn: string[] = [], extra: object = {}) => ({
  id, title: `write ${id}`, description: `write out/${id}.txt`, files: [`out/${id}.txt`], dependsOn,
  acceptance: [], test: `node check.mjs ${id} ${dependsOn.join(" ")}`.trim(), difficulty: "simple" as const, ...extra,
});

const gitOut = (repo: string, ...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });

test("validatePlan rejects cycles, unknown dependencies, and parallel subtasks sharing files", () => {
  const plan = (subtasks: object[]) => Plan.parse({ summary: "s", subtasks });
  assert.match(validatePlan(plan([sub("a", ["b"]), sub("b", ["a"])])).join(), /cycle/);
  assert.match(validatePlan(plan([sub("a", ["zzz"])])).join(), /unknown subtask "zzz"/);
  const shared = plan([sub("a"), { ...sub("b"), files: ["out/a.txt"] }]);
  assert.match(validatePlan(shared).join(), /a and b can run in parallel but both touch out\/a.txt/);
  assert.deepEqual(validatePlan(plan([sub("a"), { ...sub("b", ["a"]), files: ["out/a.txt"] }])), []);
  assert.deepEqual(topologicalOrder(plan([sub("c", ["a", "b"]), sub("b", ["a"]), sub("a")])).map((s) => s.id), ["a", "b", "c"]);
});

test("planTask retries a rejected plan with the validation errors", async () => {
  const { repo, tools } = setup();
  const planner = join(tools, "planner.mjs");
  writeFileSync(planner, `
import { readFileSync } from "node:fs";
const prompt = readFileSync(0, "utf8");
const files = prompt.includes("was rejected") ? ["b.txt"] : ["a.txt"];
console.log(JSON.stringify({ summary: "two files", subtasks: [
  { id: "a", title: "a", description: "a", files: ["a.txt"] },
  { id: "b", title: "b", description: "b", files } ] }));
`);
  let retries = 0;
  const r = await planTask(repo, "write two files", `node "${planner}"`, { onRetry: () => retries++ });
  assert.ok(r.ok, r.errors.join("; "));
  assert.equal(retries, 1);
  assert.deepEqual(r.plan!.subtasks.map((s) => s.difficulty), ["simple", "simple"]);
});

test("runs independent subtasks in parallel, then dependents on top of the merged code", async () => {
  const { repo, tiers, trace, worktreeRoot, stateDir } = setup({ sleep: 400 });
  const plan = Plan.parse({ summary: "abc", subtasks: [sub("a"), sub("b"), sub("c", ["a", "b"])], finalTest: "node check.mjs c a b" });
  const report = await runSwarm({ repo, task: "write a, b and c", plan, tiers, parallel: 4, worktreeRoot, stateDir });

  assert.ok(report.ok, JSON.stringify(report.tasks, null, 2));
  assert.deepEqual(report.tasks.map((t) => [t.id, t.status, t.solvedBy]), [["a", "merged", "small"], ["b", "merged", "small"], ["c", "merged", "small"]]);
  const lines = readFileSync(trace, "utf8").trim().split("\n");
  assert.deepEqual(lines.slice(0, 2).map((l) => l.split(" ")[0]), ["start", "start"], `a and b start together: ${lines}`);
  assert.match(lines.at(-2)!, /^start c/, "c starts after a and b finish");
  // The person's checkout is untouched; the result is on the integration branch.
  assert.ok(!existsSync(join(repo, "out")));
  assert.equal(gitOut(repo, "show", `${report.branch}:out/c.txt`), "ok-c");
  assert.equal(report.commits.length, 3);
  assert.equal(report.finalTest?.passed, true);
  // Worktrees and subtask branches are cleaned up.
  assert.equal(gitOut(repo, "worktree", "list").trim().split("\n").length, 1);
  assert.equal(gitOut(repo, "branch", "--list", "orqen/swarm-*").trim().split("\n").length, 1);
  assert.ok(existsSync(join(stateDir, "report.json")));
});

test("escalates to the large model after two failed attempts with the small one", async () => {
  const { repo, tiers, worktreeRoot, stateDir } = setup({ failOn: { small: ["hard"] } });
  const plan = Plan.parse({ summary: "hard", subtasks: [sub("easy"), sub("hard")] });
  const events: string[] = [];
  const report = await runSwarm({ repo, task: "t", plan, tiers, worktreeRoot, stateDir, onEvent: (e) => events.push(e.type) });

  assert.ok(report.ok);
  const hard = report.tasks.find((t) => t.id === "hard")!;
  assert.equal(hard.solvedBy, "large");
  assert.deepEqual(hard.attempts.map((a) => `${a.tier}:${a.outcome}`), ["small:test-failed", "small:test-failed", "large:passed"]);
  assert.ok(events.includes("task-escalated"));
  assert.ok(readFileSync(hard.attempts[2].log, "utf8").includes("A previous attempt at this subtask failed"), "the large model gets the failure output");
  assert.equal(report.tasks.find((t) => t.id === "easy")!.attempts.length, 1);
});

test("complex subtasks start directly on the large model", async () => {
  const { repo, tiers, worktreeRoot, stateDir } = setup();
  const plan = Plan.parse({ summary: "x", subtasks: [sub("big", [], { difficulty: "complex" })] });
  const report = await runSwarm({ repo, task: "t", plan, tiers, worktreeRoot, stateDir });
  assert.deepEqual(report.tasks[0].attempts.map((a) => a.tier), ["large"]);
});

test("a subtask nobody can solve fails, its dependents are skipped, and the rest is merged", async () => {
  const { repo, tiers, worktreeRoot, stateDir } = setup({ failOn: { small: ["x"], large: ["x"] } });
  const plan = Plan.parse({ summary: "x", subtasks: [sub("x"), sub("y", ["x"]), sub("z")] });
  const report = await runSwarm({ repo, task: "t", plan, tiers, worktreeRoot, stateDir });

  assert.equal(report.ok, false);
  assert.deepEqual(report.tasks.map((t) => t.status), ["failed", "skipped", "merged"]);
  assert.equal(report.tasks[0].attempts.length, 4);
  assert.equal(gitOut(repo, "show", `${report.branch}:out/z.txt`), "ok-z");
  assert.equal(gitOut(repo, "worktree", "list").trim().split("\n").length, 1);
});

test("the large model fixes a failing final test on the integration branch", async () => {
  const { repo, tiers, worktreeRoot, stateDir } = setup({ fixFinal: true });
  const plan = Plan.parse({ summary: "x", subtasks: [sub("a")], finalTest: "node check-final.mjs" });
  const report = await runSwarm({ repo, task: "t", plan, tiers, worktreeRoot, stateDir });
  assert.ok(report.ok);
  assert.deepEqual([report.finalTest?.passed, report.finalTest?.fixAttempts], [true, 1]);
  assert.equal(gitOut(repo, "show", `${report.branch}:FINAL`), "ok");
});

test("orqen swarm --plan --yes --json runs a saved plan from the CLI", () => {
  const { repo, tiers, tools } = setup();
  const planFile = join(tools, "plan.json");
  writeFileSync(planFile, JSON.stringify({ summary: "cli", subtasks: [sub("a"), sub("b")] }));
  const cli = fileURLToPath(new URL("../src/index.ts", import.meta.url));
  const loaders = process.execArgv.filter((a) => !a.startsWith("--test"));
  const r = spawnSync(process.execPath, [...loaders, cli, "swarm", "--plan", planFile, "--yes", "--json", "--no-setup",
    "--small", tiers[0].command, "--large", tiers[1].command], { cwd: repo, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const report = JSON.parse(r.stdout);
  assert.deepEqual(report.tasks.map((t: { status: string }) => t.status), ["merged", "merged"]);
  assert.ok(existsSync(join(repo, "orqen", "state", "swarm", report.runId, "report.json")));
});
