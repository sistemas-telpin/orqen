/** orqen eval (cases run through the real CLI against an in-memory Jira) and orqen learn (feedback → lessons). */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { BUILT_IN, loadCases, validateCase } from "../src/eval/cases.ts";
import { agentArgs, checkCase, costOf, expandCommand, runCase } from "../src/eval/run.ts";
import { lessonsFor, readFeedback } from "../src/commands/eval.ts";

const CLI = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const AGENT = fileURLToPath(new URL("./fixtures/eval-agent.mjs", import.meta.url));
const opts = (out: string) => ({ cli: [process.execPath, CLI] as [string, string], agentCmd: `node "${AGENT}"`, outDir: out });

test("eval: a good agent passes the built-in cases through the real CLI", async () => {
  assert.ok(existsSync(CLI), "build first");
  const out = mkdtempSync(join(tmpdir(), "orqen-evtest-"));
  for (const c of BUILT_IN) {
    const r = await runCase(c, opts(out));
    assert.equal(r.pass, true, `${c.id}: ${JSON.stringify(r.checks.filter((k) => !k.ok))} ${r.error ?? ""}`);
    assert.equal(r.cost, 0.02);
    assert.ok(r.posted.length >= 1, "orqen posted on the (fake) ticket");
  }
});

test("eval: an agent that promises and makes things up fails", async () => {
  const out = mkdtempSync(join(tmpdir(), "orqen-evtest-"));
  process.env.BAD_AGENT = "1";
  try {
    const r = await runCase(BUILT_IN[0], opts(out));
    assert.equal(r.pass, false);
    const failed = r.checks.filter((k) => !k.ok).map((k) => k.name);
    assert.ok(failed.includes('outcome = "escalate"') && failed.includes('does not mention "tomorrow"') && failed.includes('does not mention "already available"'), failed.join(", "));
  } finally { delete process.env.BAD_AGENT; }
});

test("eval: checks, cost, commands and cases", () => {
  const c = BUILT_IN[2];
  assert.deepEqual(checkCase(c, { state: "WAITING_CLIENT", output: { ready: false, open_questions: ["Which report?"] }, posted: [] }).every((k) => k.ok), true);
  assert.equal(checkCase(c, { state: "ANALYSIS", output: undefined, posted: [] }).filter((k) => !k.ok).length, 4);
  assert.equal(costOf('{"type":"result","total_cost_usd":0.1}\n{"total_cost_usd": 0.25}'), 0.25);
  const claude = agentArgs("claude -p --model sonnet", "hi", ["Write", "Bash(git log:*)"]);
  assert.deepEqual(claude.args.slice(0, 5), ["-p", "--model", "sonnet", "--output-format", "json"]);
  assert.ok(claude.args.includes("PowerShell(orqen:*)") && claude.args.includes("Bash(git log:*)") && claude.stdin === "hi");
  assert.deepEqual(agentArgs("my-agent --prompt {prompt}", "hola", []), { bin: "my-agent", args: ["--prompt", "hola"] });
  const repo = mkdtempSync(join(tmpdir(), "orqen-evrepo-"));
  mkdirSync(join(repo, "orqen", "plugin", "commands"), { recursive: true });
  writeFileSync(join(repo, "orqen", "plugin", "commands", "support.md"), "---\r\nallowed-tools: Bash(orqen:*), Write, AskUserQuestion\r\n---\r\n\r\nHandle $ARGUMENTS.\r\n");
  const e = expandCommand(repo, "support", "REQ-1");
  assert.deepEqual(e.tools, ["Bash(orqen:*)", "Write"]);
  assert.ok(e.prompt.endsWith("Handle REQ-1."));
  assert.equal(loadCases(repo).length, BUILT_IN.length, "built-in cases when the project has none");
  mkdirSync(join(repo, "orqen", "evals"));
  writeFileSync(join(repo, "orqen", "evals", "mine.yaml"), "id: mine\nstep: support\nticket: { title: Hi }\nexpect: { state: [ANALYSIS] }\n");
  assert.deepEqual(loadCases(repo).map((x) => x.id), ["mine"]);
  assert.deepEqual(validateCase({ id: "x", step: "deploy" } as never).length, 3);
});

test("learn: verdicts and notes from the desktop app become lessons the stage reads", () => {
  const repo = mkdtempSync(join(tmpdir(), "orqen-learn-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  const log = join(repo, "orqen", "state", "app-chat");
  mkdirSync(log, { recursive: true });
  writeFileSync(join(log, "runs.jsonl"), [
    { type: "run", run: "r1", ts: "1795000000", key: "GH-1", command: "/orqen:support" },
    { type: "feedback", run: "r1", verdict: "down" },
    { type: "feedback-note", run: "r1", text: "Inventó que ya existía un export; revisá el código antes de afirmar." },
    { type: "run", run: "r2", ts: "1795000001", key: "GH-2", command: "/orqen:analyze" },
    { type: "feedback", run: "r2", verdict: "up" },
  ].map((x) => JSON.stringify(x)).join("\n") + "\n");
  const { verdicts } = readFeedback(repo);
  assert.equal(verdicts.get("r1")?.note, "Inventó que ya existía un export; revisá el código antes de afirmar.");
  const out = execFileSync(process.execPath, [CLI, "learn", "--apply"], { cwd: repo, encoding: "utf8" });
  assert.match(out, /\/orqen:support\s+0 ✓\s+1 ✗/);
  const lessons = readFileSync(join(repo, "orqen", "knowledge", "lessons", "SUPPORT.md"), "utf8");
  assert.match(lessons, /Inventó que ya existía un export.*GH-1/);
  assert.match(lessonsFor(repo, "SUPPORT"), /Team lessons for this stage[\s\S]*Inventó/);
  assert.equal(lessonsFor(repo, "ANALYSIS"), "");
  // applied once: not again
  assert.match(execFileSync(process.execPath, [CLI, "learn", "--apply"], { cwd: repo, encoding: "utf8" }), /No new notes/);
});

test("eval: the team's lessons reach the agent through the stage instructions", async () => {
  const out = mkdtempSync(join(tmpdir(), "orqen-evtest-"));
  const knowledge = join(mkdtempSync(join(tmpdir(), "orqen-know-")), "knowledge");
  mkdirSync(join(knowledge, "lessons"), { recursive: true });
  writeFileSync(join(knowledge, "lessons", "SUPPORT.md"), "# Lessons for SUPPORT\n\n- LESSON-MARKER: never promise dates.\n");
  process.env.EVAL_ECHO_CONTEXT = "1";
  try {
    const r = await runCase(BUILT_IN[0], { ...opts(out), knowledge });
    assert.match(readFileSync(r.log, "utf8"), /Team lessons for this stage[\s\S]*LESSON-MARKER/);
  } finally { delete process.env.EVAL_ECHO_CONTEXT; }
});
