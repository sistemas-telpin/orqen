/**
 * Swarm orchestrator: plan → run small agents in parallel worktrees → verify → merge → final test.
 *
 * Each subtask starts on the first (cheapest) tier. When a tier exhausts its attempts the subtask
 * moves to the next, larger tier with the failure output as feedback. A subtask is merged into the
 * integration branch only after its test passes; subtasks that depend on it start afterwards, on top
 * of the merged code.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { ejecutarAsync, partirComando } from "../lib/proc.ts";
import { SwarmGit, runLine } from "./git.ts";
import type { Plan, Subtask } from "./plan.ts";

export interface Tier { name: string; command: string; attempts: number }

export type TaskStatus = "pending" | "running" | "merged" | "failed" | "skipped";
export type Outcome = "passed" | "agent-error" | "no-changes" | "test-failed" | "merge-conflict" | "setup-failed";

export interface AttemptRecord { tier: string; attempt: number; outcome: Outcome; seconds: number; log: string; detail?: string }
export interface TaskRecord { id: string; title: string; status: TaskStatus; attempts: AttemptRecord[]; solvedBy?: string; files?: string[]; reason?: string }

export interface SwarmReport {
  runId: string; task: string; ok: boolean;
  branch: string; baseCommit: string; commits: string[];
  plan: Plan; tasks: TaskRecord[];
  finalTest?: { command: string; passed: boolean; fixAttempts: number; log?: string };
  startedAt: string; finishedAt: string; stateDir: string; worktree?: string;
}

export type SwarmEvent =
  | { type: "start"; runId: string; branch: string; worktreeRoot: string }
  | { type: "task-start"; id: string; tier: string; attempt: number; of: number }
  | { type: "task-attempt-failed"; id: string; tier: string; attempt: number; outcome: Outcome; detail: string }
  | { type: "task-escalated"; id: string; from: string; to: string }
  | { type: "task-merged"; id: string; tier: string; attempts: number }
  | { type: "task-failed"; id: string; reason: string }
  | { type: "task-skipped"; id: string; reason: string }
  | { type: "final-test"; command: string; passed: boolean; attempt: number }
  | { type: "final-fix"; tier: string; attempt: number };

export interface SwarmOptions {
  repo: string;
  task: string;
  plan: Plan;
  tiers: Tier[];
  parallel?: number;
  /** Used for the final verification when the plan has no finalTest. */
  testCommand?: string;
  /** Commands run once in each new worktree (dependency install, codegen…). */
  setup?: string[];
  agentTimeoutMs?: number;
  testTimeoutMs?: number;
  keepWorktrees?: boolean;
  runId?: string;
  worktreeRoot?: string;
  stateDir?: string;
  onEvent?: (e: SwarmEvent) => void;
}

export function newRunId(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${Math.random().toString(36).slice(2, 5)}`;
}

const tail = (s: string, n = 4000) => (s.length > n ? `…${s.slice(-n)}` : s);

export function workerPrompt(task: string, plan: Plan, st: Subtask, o: { done: string[]; feedback?: string; tier: string }): string {
  const others = plan.subtasks.filter((x) => x.id !== st.id && !o.done.includes(x.id) && x.files.length);
  return [
    "You are an ORQEN swarm worker. You are in a git worktree of the repository and must complete ONE small",
    "subtask of a larger task. Other workers handle the other subtasks in parallel in their own worktrees.",
    "",
    "Overall task (context only, do not do all of it):",
    task.trim(),
    "",
    `Plan: ${plan.summary}`,
    "",
    `Your subtask: ${st.id} — ${st.title}`,
    st.description.trim(),
    ...(st.files.length ? ["", "Files you are expected to create or edit:", ...st.files.map((f) => `- ${f}`)] : []),
    ...(st.acceptance.length ? ["", "Acceptance criteria:", ...st.acceptance.map((a) => `- ${a}`)] : []),
    ...(o.done.length ? ["", `Already merged into your worktree: ${o.done.join(", ")}.`] : []),
    ...(st.test ? ["", `When you finish, orqen runs \`${st.test}\` from the repository root. It must pass.`] : []),
    "",
    "Rules:",
    "- Do only this subtask. Keep the change minimal and consistent with the existing code.",
    ...(others.length ? [`- Do not edit files owned by other subtasks: ${[...new Set(others.flatMap((x) => x.files))].join(", ")}.`] : []),
    "- Do not commit, create branches, push, or install new dependencies. orqen commits and merges your work.",
    "- If you can run the verification command, run it and fix failures before finishing.",
    "- Finish with one line summarizing what you changed.",
    ...(o.feedback ? ["", "A previous attempt at this subtask failed. Your worktree was reset to the latest merged code.", "Failure details:", tail(o.feedback)] : []),
  ].join("\n");
}

export function fixerPrompt(task: string, plan: Plan, command: string, output: string): string {
  return [
    "You are the ORQEN swarm integrator. Several workers completed the subtasks below and their work was merged",
    "into this worktree, but the final verification fails. Fix the integration problems with minimal changes.",
    "Do not commit, create branches, or push.",
    "",
    "Overall task:", task.trim(), "",
    `Plan: ${plan.summary}`,
    ...plan.subtasks.map((s) => `- ${s.id}: ${s.title}`),
    "",
    `Verification command (run from the repository root): \`${command}\``,
    "Output:", tail(output, 8000),
  ].join("\n");
}

async function runAgent(command: string, prompt: string, cwd: string, timeoutMs: number) {
  const [bin, ...args] = partirComando(command);
  const usesArg = args.some((a) => a.includes("{prompt}"));
  return ejecutarAsync(bin, usesArg ? args.map((a) => a.replace("{prompt}", prompt)) : args, {
    cwd, entrada: usesArg ? undefined : prompt, timeoutMs,
  });
}

export async function runSwarm(o: SwarmOptions): Promise<SwarmReport> {
  if (!o.tiers.length) throw new Error("At least one model tier is required");
  const runId = o.runId ?? newRunId();
  const startedAt = new Date().toISOString();
  const emit = o.onEvent ?? (() => {});
  const parallel = Math.max(1, o.parallel ?? 4);
  const agentTimeoutMs = o.agentTimeoutMs ?? 20 * 60_000;
  const testTimeoutMs = o.testTimeoutMs ?? 20 * 60_000;
  const stateDir = o.stateDir ?? join(o.repo, "orqen", "state", "swarm", runId);
  const logs = join(stateDir, "logs");
  mkdirSync(logs, { recursive: true });
  const root = o.worktreeRoot ?? join(tmpdir(), "orqen-swarm", `${basename(o.repo)}-${runId}`);
  const git = new SwarmGit(o.repo, runId, root);
  const { plan } = o;
  const records = new Map<string, TaskRecord>(plan.subtasks.map((s) => [s.id, { id: s.id, title: s.title, status: "pending", attempts: [] }]));
  const merged: string[] = [];

  const saveReport = (extra: Partial<SwarmReport> = {}): SwarmReport => {
    const report: SwarmReport = {
      runId, task: o.task, ok: false, branch: git.integrationBranch, baseCommit: git.baseCommit, commits: [],
      plan, tasks: [...records.values()], startedAt, finishedAt: new Date().toISOString(), stateDir, ...extra,
    };
    writeFileSync(join(stateDir, "report.json"), JSON.stringify(report, null, 2));
    return report;
  };

  async function setup(dir: string): Promise<{ ok: boolean; output: string }> {
    let output = "";
    for (const cmd of o.setup ?? []) {
      const r = await runLine(cmd, dir, testTimeoutMs);
      output += `$ ${cmd}\n${r.output}\n`;
      if (r.code !== 0) return { ok: false, output };
    }
    return { ok: true, output };
  }

  async function runSubtask(st: Subtask): Promise<void> {
    const rec = records.get(st.id)!;
    rec.status = "running";
    let dir: string;
    try { dir = git.taskWorktree(st.id); } catch (e) { rec.status = "failed"; rec.reason = (e as Error).message; return; }
    const prepared = await setup(dir);
    if (!prepared.ok) {
      const log = join(logs, `${st.id}-setup.log`);
      writeFileSync(log, prepared.output);
      rec.attempts.push({ tier: "-", attempt: 0, outcome: "setup-failed", seconds: 0, log, detail: tail(prepared.output, 500) });
      rec.status = "failed"; rec.reason = "setup failed";
      return;
    }
    const firstTier = st.difficulty === "complex" ? Math.min(1, o.tiers.length - 1) : 0;
    let feedback: string | undefined;
    for (let t = firstTier; t < o.tiers.length; t++) {
      const tier = o.tiers[t];
      if (t > firstTier) emit({ type: "task-escalated", id: st.id, from: o.tiers[t - 1].name, to: tier.name });
      for (let attempt = 1; attempt <= tier.attempts; attempt++) {
        if (rec.attempts.length) git.resetTask(dir);
        emit({ type: "task-start", id: st.id, tier: tier.name, attempt, of: tier.attempts });
        const t0 = Date.now();
        const prompt = workerPrompt(o.task, plan, st, { done: [...merged], feedback, tier: tier.name });
        const r = await runAgent(tier.command, prompt, dir, agentTimeoutMs);
        const log = join(logs, `${st.id}-${rec.attempts.length + 1}-${tier.name}.log`);
        let logText = `# ${st.id} · ${tier.name} · attempt ${attempt}\n\n## Prompt\n${prompt}\n\n## Agent output (exit ${r.codigo})\n${r.stdout}\n${r.stderr}\n`;
        const fail = (outcome: Outcome, detail: string) => {
          writeFileSync(log, logText + `\n## Result: ${outcome}\n${detail}\n`);
          rec.attempts.push({ tier: tier.name, attempt, outcome, seconds: Math.round((Date.now() - t0) / 1000), log, detail: tail(detail, 500) });
          emit({ type: "task-attempt-failed", id: st.id, tier: tier.name, attempt, outcome, detail: tail(detail, 300) });
          feedback = detail;
        };
        if (r.error || (r.codigo !== 0 && !git.changes(dir).length)) {
          fail("agent-error", r.error ? `Could not execute the agent: ${r.error.message}` : `The agent exited with code ${r.codigo}: ${tail(r.stderr || r.stdout, 1500)}`);
          continue;
        }
        const changed = git.changes(dir);
        if (!changed.length) { fail("no-changes", "The previous attempt finished without changing any file. Make the changes the subtask requires."); continue; }
        if (st.test) {
          const tr = await runLine(st.test, dir, testTimeoutMs);
          logText += `\n## Test: ${st.test} (exit ${tr.code}${tr.timedOut ? ", timed out" : ""})\n${tr.output}\n`;
          if (tr.code !== 0) { fail("test-failed", `\`${st.test}\` failed${tr.timedOut ? " (timed out)" : ""}:\n${tail(tr.output)}`); continue; }
        }
        git.commitAll(dir, `${st.id}: ${st.title}\n\norqen swarm ${runId} · ${tier.name} · attempt ${attempt}`);
        const m = git.merge(st.id, `Merge ${st.id}: ${st.title}`);
        if (!m.ok) {
          fail("merge-conflict", `Your change conflicted with work merged meanwhile${m.conflicts.length ? ` in ${m.conflicts.join(", ")}` : ""}. Redo the subtask on top of the latest code (already in your worktree) without undoing other subtasks' changes.`);
          continue;
        }
        writeFileSync(log, logText + "\n## Result: passed and merged\n");
        rec.attempts.push({ tier: tier.name, attempt, outcome: "passed", seconds: Math.round((Date.now() - t0) / 1000), log });
        rec.status = "merged"; rec.solvedBy = tier.name; rec.files = changed;
        merged.push(st.id);
        emit({ type: "task-merged", id: st.id, tier: tier.name, attempts: rec.attempts.length });
        return;
      }
    }
    rec.status = "failed";
    rec.reason = `not solved after ${rec.attempts.length} attempts (${o.tiers.slice(firstTier).map((t) => t.name).join(" → ")})`;
    emit({ type: "task-failed", id: st.id, reason: rec.reason });
  }

  git.start();
  emit({ type: "start", runId, branch: git.integrationBranch, worktreeRoot: root });
  saveReport();

  try {
    // Scheduler: start every subtask whose dependencies are merged, up to `parallel` at a time.
    const running = new Map<string, Promise<void>>();
    for (;;) {
      for (const s of plan.subtasks) {
        const rec = records.get(s.id)!;
        if (rec.status !== "pending") continue;
        const blocker = s.dependsOn.find((d) => ["failed", "skipped"].includes(records.get(d)!.status));
        if (blocker) {
          rec.status = "skipped"; rec.reason = `depends on ${blocker}, which did not complete`;
          emit({ type: "task-skipped", id: s.id, reason: rec.reason });
        }
      }
      const ready = plan.subtasks.filter((s) => records.get(s.id)!.status === "pending" && s.dependsOn.every((d) => records.get(d)!.status === "merged"));
      for (const s of ready) {
        if (running.size >= parallel) break;
        const p = runSubtask(s).catch((e) => {
          const rec = records.get(s.id)!;
          rec.status = "failed"; rec.reason = (e as Error).message;
          emit({ type: "task-failed", id: s.id, reason: rec.reason });
        }).finally(() => { running.delete(s.id); saveReport(); });
        running.set(s.id, p);
      }
      if (!running.size) break;
      await Promise.race(running.values());
    }

    const allMerged = [...records.values()].every((r) => r.status === "merged");
    let finalTest: SwarmReport["finalTest"];
    const finalCommand = plan.finalTest || o.testCommand;
    if (allMerged && finalCommand) {
      const prepared = await setup(git.integrationDir);
      const log = join(logs, "final-test.log");
      let logText = prepared.output;
      let passed = false, fixAttempts = 0;
      const top = o.tiers[o.tiers.length - 1];
      if (prepared.ok) {
        for (let attempt = 0; ; attempt++) {
          const tr = await runLine(finalCommand, git.integrationDir, testTimeoutMs);
          logText += `\n## ${finalCommand} (exit ${tr.code})\n${tr.output}\n`;
          passed = tr.code === 0;
          emit({ type: "final-test", command: finalCommand, passed, attempt });
          if (passed || attempt >= top.attempts) break;
          fixAttempts++;
          emit({ type: "final-fix", tier: top.name, attempt: fixAttempts });
          const r = await runAgent(top.command, fixerPrompt(o.task, plan, finalCommand, tr.output), git.integrationDir, agentTimeoutMs);
          logText += `\n## Integrator (${top.name}, exit ${r.codigo})\n${r.stdout}\n${r.stderr}\n`;
          git.commitIntegration(`Fix integration (${top.name})\n\norqen swarm ${runId}`);
        }
      }
      writeFileSync(log, logText);
      finalTest = { command: finalCommand, passed, fixAttempts, log };
    }

    const ok = allMerged && (finalTest ? finalTest.passed : true);
    return saveReport({ ok, commits: git.log(), finalTest, worktree: o.keepWorktrees ? git.integrationDir : undefined });
  } finally {
    git.cleanup({ keepIntegrationWorktree: o.keepWorktrees });
  }
}

/** One line per subtask for showing the plan to the person. */
export function describePlan(plan: Plan, tiers: Tier[]): string[] {
  return plan.subtasks.map((s) => {
    const start = s.difficulty === "complex" ? tiers[Math.min(1, tiers.length - 1)].name : tiers[0].name;
    return `${s.id} — ${s.title}${s.dependsOn.length ? `  (after ${s.dependsOn.join(", ")})` : ""}  [${start}]${s.test ? `  test: ${s.test}` : ""}`;
  });
}
