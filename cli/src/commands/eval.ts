/**
 * `orqen eval` and `orqen learn`: measure the agents on the flow's steps and turn the team's feedback into lessons
 * (injected into each stage's instructions) and new eval cases.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";
import { buildConnectors } from "../connectors/index.ts";
import { isBotComment } from "../connectors/types.ts";
import { EVAL_STEPS, loadCases, type EvalCase, type EvalStep } from "../eval/cases.ts";
import { runCase, type CaseResult } from "../eval/run.ts";
import { loadConfig } from "../workflow/config.ts";

export const EVAL_HELP = `  eval [case|step...]     Run the agent on test tickets and check its work (orqen/evals/*.yaml, or the built-in cases)
      --agent "<cmd>"     Headless agent (default: agent.command of orqen/config.yaml)
      --judge "<cmd>"     Also ask a judge agent whether the output made facts up ("" = the same agent)
      --no-lessons        Without the team's lessons (orqen/knowledge): compare how much they help
      --keep              Keep the test projects · --json  Machine-readable result
  learn                   What the team marked right/wrong in the desktop app, by step
      --apply             Add the new notes to orqen/knowledge/lessons/<STAGE>.md (the agent reads them in that stage)
      --to-eval <run>     Turn a run marked wrong into an eval case (orqen/evals/)`;

function gitRoot(): string {
  try { return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch { return process.cwd(); }
}

function takeFlag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const v = args[i + 1];
  args.splice(i, v !== undefined && !v.startsWith("--") ? 2 : 1);
  return v !== undefined && !v.startsWith("--") ? v : "";
}
function takeBool(args: string[], name: string): boolean {
  const i = args.indexOf(`--${name}`);
  if (i >= 0) args.splice(i, 1);
  return i >= 0;
}

export async function evalCommand(args: string[]) {
  const a = [...args];
  const json = takeBool(a, "json"), keep = takeBool(a, "keep"), noLessons = takeBool(a, "no-lessons");
  const agentFlag = takeFlag(a, "agent"), judgeFlag = takeFlag(a, "judge");
  const repo = gitRoot();
  const cfgAgent = existsSync(join(repo, "orqen", "config.yaml")) ? loadConfig().agentCmd : "";
  const agentCmd = agentFlag || cfgAgent || "claude -p";
  const judgeCmd = judgeFlag === undefined ? undefined : judgeFlag || agentCmd;
  let cases = loadCases(repo);
  if (a.length) cases = cases.filter((c) => a.includes(c.id) || a.includes(c.step));
  if (!cases.length) { console.error(`No eval cases match: ${a.join(" ")}`); process.exitCode = 1; return; }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = join(repo, "orqen", "state", "evals", stamp);
  const results: CaseResult[] = [];
  if (!json) console.log(`orqen eval · ${cases.length} case(s) · agent: ${agentCmd}${judgeCmd ? ` · judge: ${judgeCmd}` : ""}\n`);
  for (const c of cases) {
    if (!json) process.stdout.write(`… ${c.id} (${c.step})`);
    const knowledge = noLessons ? undefined : join(repo, "orqen", "knowledge");
    const r = await runCase(c, { cli: [process.execPath, process.argv[1]], agentCmd, judgeCmd, outDir, keep, knowledge });
    results.push(r);
    if (!json) {
      process.stdout.write(`\r${r.pass ? "✔" : "✘"} ${c.id} (${c.step}) · ${r.state ?? "?"} · ${r.secs.toFixed(0)} s${r.cost !== undefined ? ` · US$ ${r.cost.toFixed(2)}` : ""}\n`);
      for (const k of r.checks.filter((x) => !x.ok)) console.log(`    ✘ ${k.name}${k.detail ? ` — ${k.detail}` : ""}`);
    }
  }
  const passed = results.filter((r) => r.pass).length;
  const cost = results.reduce((s, r) => s + (r.cost ?? 0), 0);
  const summary = { ts: new Date().toISOString(), agent: agentCmd, judge: judgeCmd ?? null, lessons: !noLessons, passed, total: results.length, cost, results };
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "result.json"), JSON.stringify(summary, null, 2));
  // the history, to see whether a change in the commands, the stages or the model made things better or worse
  appendFileSync(join(repo, "orqen", "state", "evals", "history.jsonl"), JSON.stringify({ ts: summary.ts, agent: agentCmd, lessons: !noLessons, passed, total: results.length, cost, failed: results.filter((r) => !r.pass).map((r) => r.id) }) + "\n");
  if (json) console.log(JSON.stringify(summary, null, 2));
  else console.log(`\n${passed}/${results.length} passed${cost ? ` · US$ ${cost.toFixed(2)}` : ""} · logs: ${outDir}`);
  if (passed < results.length) process.exitCode = 1;
}

// ================================================================ learn

/** /orqen:<command> → the stage whose instructions get the lesson. */
const STAGE_OF: Record<string, string> = {
  "/orqen:support": "SUPPORT", "/orqen:analyze": "ANALYSIS", "/orqen:implement": "DEVELOPMENT",
  "/orqen:pr": "DELIVERY", "/orqen:review": "TESTING", "/orqen:approve": "DELIVERY",
};
const STEP_OF: Record<string, EvalStep> = { "/orqen:support": "support", "/orqen:analyze": "analyze" };

interface RunRec { type: "run"; run: string; ts: string; key: string; command: string; agent?: string; model?: string; state_before?: string }
interface Verdict { run: string; verdict: "up" | "down"; note?: string }

/** The desktop app's run log: runs, verdicts and what the person said was wrong. */
export function readFeedback(repo: string): { runs: Map<string, RunRec>; verdicts: Map<string, Verdict> } {
  const runs = new Map<string, RunRec>(), verdicts = new Map<string, Verdict>();
  const file = join(repo, "orqen", "state", "app-chat", "runs.jsonl");
  if (!existsSync(file)) return { runs, verdicts };
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    let v: any; try { v = JSON.parse(line); } catch { continue; }
    if (v.type === "run") runs.set(v.run, v);
    if (v.type === "feedback") verdicts.set(v.run, { run: v.run, verdict: v.verdict, note: verdicts.get(v.run)?.note });
    if (v.type === "feedback-note" && typeof v.text === "string") {
      const cur: Verdict = verdicts.get(v.run) ?? { run: v.run, verdict: "down" };
      verdicts.set(v.run, { ...cur, note: [cur.note, v.text.trim()].filter(Boolean).join(" · ") });
    }
  }
  return { runs, verdicts };
}

export async function learnCommand(args: string[]) {
  const a = [...args];
  const apply = takeBool(a, "apply");
  const toEval = takeFlag(a, "to-eval");
  const repo = gitRoot();
  const { runs, verdicts } = readFeedback(repo);
  if (toEval !== undefined) return caseFromRun(repo, toEval, runs, verdicts);
  const doneFile = join(repo, "orqen", "state", "app-chat", "learned.json");
  const done = new Set<string>(existsSync(doneFile) ? JSON.parse(readFileSync(doneFile, "utf8")) : []);
  const byCommand = new Map<string, { up: number; down: number }>();
  const fresh: Array<{ rec: RunRec; v: Verdict }> = [];
  for (const v of verdicts.values()) {
    const rec = runs.get(v.run);
    const cmd = rec?.command ?? "chat";
    const n = byCommand.get(cmd) ?? { up: 0, down: 0 };
    n[v.verdict]++; byCommand.set(cmd, n);
    if (rec && v.verdict === "down" && v.note && !done.has(v.run)) fresh.push({ rec, v });
  }
  if (!byCommand.size) { console.log("No feedback yet: mark runs with ✓ / ✗ in the desktop app's chat."); return; }
  console.log("Feedback by step (✓ / ✗):");
  for (const [cmd, n] of [...byCommand].sort()) console.log(`  ${cmd.padEnd(20)} ${n.up} ✓  ${n.down} ✗`);
  if (!fresh.length) { console.log("\nNo new notes on runs marked wrong."); return; }
  console.log(`\nNew notes on runs marked wrong (${fresh.length}):`);
  for (const { rec, v } of fresh) console.log(`  ${v.run}  ${rec.command} ${rec.key}: ${v.note}`);
  if (!apply) { console.log("\n`orqen learn --apply` adds them to orqen/knowledge/lessons/ (review and commit them); `orqen learn --to-eval <run>` makes an eval case."); return; }
  const dir = join(repo, "orqen", "knowledge", "lessons");
  mkdirSync(dir, { recursive: true });
  const touched = new Set<string>();
  for (const { rec, v } of fresh) {
    const stage = STAGE_OF[rec.command] ?? "GENERAL";
    const file = join(dir, `${stage}.md`);
    if (!existsSync(file)) writeFileSync(file, `# Lessons for ${stage}\n\nWhat the team corrected in past runs. The agent reads this file in the ${stage} stage: keep it short and concrete; delete what no longer applies.\n\n`);
    appendFileSync(file, `- ${v.note!.replace(/\s+/g, " ").trim()} _(${rec.key}, ${new Date(Number(rec.ts) * 1000 || Date.now()).toISOString().slice(0, 10)})_\n`);
    touched.add(`orqen/knowledge/lessons/${stage}.md`);
    done.add(v.run);
  }
  mkdirSync(join(repo, "orqen", "state", "app-chat"), { recursive: true });
  writeFileSync(doneFile, JSON.stringify([...done], null, 2));
  console.log(`\nUpdated: ${[...touched].join(", ")}. Review them and commit: the whole team's agents learn from them.`);
}

/** A run marked wrong → orqen/evals/<key>-<step>.yaml with the ticket as it is now, for the person to finish the expectations. */
async function caseFromRun(repo: string, runId: string, runs: Map<string, RunRec>, verdicts: Map<string, Verdict>) {
  const rec = runs.get(runId);
  if (!rec) throw new Error(`Run ${runId} is not in orqen/state/app-chat/runs.jsonl`);
  const step = STEP_OF[rec.command];
  if (!step) throw new Error(`Only ${Object.keys(STEP_OF).join(" and ")} runs can become eval cases for now (this one: ${rec.command}).`);
  const cfg = loadConfig();
  const tracker = buildConnectors(cfg.connectors).requests;
  const t = await tracker.ticket(rec.key);
  const comments = (await tracker.comments(rec.key)).filter((c) => !isBotComment(c.body)).map((c) => ({ author: c.authorName || c.author, body: c.body }));
  const note = verdicts.get(runId)?.note;
  const c: EvalCase = {
    id: `${rec.key.toLowerCase()}-${step}`,
    step,
    description: `From run ${runId} marked wrong${note ? `: ${note}` : ""}`,
    ticket: { title: t.title, description: t.description, comments },
    expect: { state: [], output: {}, must_mention: [], must_not_mention: [] },
  };
  const dir = join(repo, "orqen", "evals");
  mkdirSync(dir, { recursive: true });
  let file = join(dir, `${c.id}.yaml`), n = 2;
  while (existsSync(file)) file = join(dir, `${c.id}-${n++}.yaml`);
  writeFileSync(file, `# Fill in "expect" with what a good run must do (see the built-in cases: orqen eval --help).\n# Steps: ${Object.keys(EVAL_STEPS).join(", ")}\n${stringify(c)}`);
  console.log(`Created ${file.slice(repo.length + 1)}: complete its "expect" and commit it. \`orqen eval ${c.id}\` runs it.`);
}

/** The lessons of a stage, for its instructions (empty when there are none). */
export function lessonsFor(repo: string, state: string): string {
  const file = join(repo, "orqen", "knowledge", "lessons", `${state}.md`);
  if (!existsSync(file)) return "";
  const text = readFileSync(file, "utf8").trim();
  if (!text) return "";
  const capped = text.length > 6000 ? `${text.slice(0, 6000)}\n…` : text;
  return `## Team lessons for this stage (orqen/knowledge/lessons/${state}.md)\nCorrections from past runs. Follow them unless the person says otherwise.\n\n${capped.replace(/^# .*\n+/, "")}`;
}
