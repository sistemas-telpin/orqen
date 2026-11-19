/**
 * `orqen swarm "<task>"`: split a task into small subtasks, solve them in parallel with small models
 * (escalating to a larger model after repeated failures), verify each with its test, and merge
 * everything into one integration branch.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { existeConfig, leerConfig } from "../lib/config.ts";
import { confirmar, gris, interactivo, p, pc } from "../ui/console.ts";
import { Plan, planTask, validatePlan } from "../swarm/plan.ts";
import { SwarmGit } from "../swarm/git.ts";
import { describePlan, newRunId, runSwarm, type SwarmEvent, type Tier } from "../swarm/run.ts";

export const SWARM_DEFAULTS = {
  planner: "claude -p --model opus",
  small: "claude -p --model haiku --permission-mode acceptEdits",
  large: "claude -p --model sonnet --permission-mode acceptEdits",
};

export const SWARM_HELP = `  swarm "<task>"          Split a task into small subtasks, solve them in parallel, verify, and merge
      --file <path>       Read the task from a file ("-" = stdin)
      --parallel <n>      Workers running at the same time (default 4)
      --planner "<cmd>"   Agent that splits the task (default: ${SWARM_DEFAULTS.planner})
      --small "<cmd>"     Small model for subtasks (default: ${SWARM_DEFAULTS.small})
      --large "<cmd>"     Larger model after the small one fails (default: ${SWARM_DEFAULTS.large})
      --small-attempts <n> --large-attempts <n>   Attempts per tier (default 2 and 2)
      --test "<cmd>"      Final verification when the plan has none (default: tests.unit of orqen/environment.yaml)
      --setup "<cmd>"     Run in each worktree before the agent (default: entornos.preparar); --no-setup
      --apply             Integrate a successful result into the starting branch (fast-forward only)
      --plan <file.json>  Use an existing plan instead of planning · --plan-only  Only write the plan
      --timeout <min>     Per agent run (default 20) · --keep  Keep worktrees · --yes  No confirmation · --json`;

function repoRoot(dir: string): string {
  try { return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch { throw new Error(`${dir} is not inside a git repository`); }
}

const icon: Record<string, string> = { merged: pc.green("✔"), failed: pc.red("✘"), skipped: pc.yellow("▲"), running: "…", pending: "·" };

function printEvent(e: SwarmEvent) {
  const t = gris(new Date().toTimeString().slice(0, 8));
  switch (e.type) {
    case "start": return console.log(`${t} branch ${pc.cyan(e.branch)} · worktrees in ${gris(e.worktreeRoot)}`);
    case "task-start": return console.log(`${t} ${pc.cyan("▶")} ${e.id} ${gris(`[${e.tier} ${e.attempt}/${e.of}]`)}`);
    case "task-attempt-failed": return console.log(`${t} ${pc.yellow("↻")} ${e.id} ${gris(`[${e.tier} ${e.attempt}]`)} ${e.outcome}: ${gris(e.detail.split("\n")[0].slice(0, 120))}`);
    case "task-escalated": return console.log(`${t} ${pc.magenta("⇧")} ${e.id} escalates ${e.from} → ${e.to}`);
    case "task-merged": return console.log(`${t} ${pc.green("✔")} ${e.id} merged ${gris(`(${e.tier}, ${e.attempts} attempt${e.attempts > 1 ? "s" : ""})`)}`);
    case "task-failed": return console.log(`${t} ${pc.red("✘")} ${e.id}: ${e.reason}`);
    case "task-skipped": return console.log(`${t} ${pc.yellow("▲")} ${e.id} skipped: ${e.reason}`);
    case "final-test": return console.log(`${t} ${e.passed ? pc.green("✔") : pc.red("✘")} final test ${gris(e.command)}`);
    case "final-fix": return console.log(`${t} ${pc.magenta("⇧")} integrator (${e.tier}) fixing the final test, attempt ${e.attempt}`);
  }
}

export async function swarm(argv: string[]) {
  const { values: v, positionals } = parseArgs({
    args: argv, allowPositionals: true, strict: true,
    options: {
      file: { type: "string" }, parallel: { type: "string" },
      planner: { type: "string" }, small: { type: "string" }, large: { type: "string" },
      "small-attempts": { type: "string" }, "large-attempts": { type: "string" },
      test: { type: "string" }, setup: { type: "string", multiple: true }, "no-setup": { type: "boolean" },
      plan: { type: "string" }, "plan-only": { type: "boolean" },
      timeout: { type: "string" }, keep: { type: "boolean" }, yes: { type: "boolean", short: "y" },
      apply: { type: "boolean" }, json: { type: "boolean" }, dir: { type: "string" }, help: { type: "boolean", short: "h" },
    },
  });
  if (v.help) return console.log(SWARM_HELP);
  const repo = repoRoot(resolve(v.dir ?? "."));
  const task = v.file ? readFileSync(v.file === "-" ? 0 : resolve(v.file), "utf8") : positionals.join(" ");
  if (!task.trim() && !v.plan) throw new Error(`Describe the task: orqen swarm "<task>" or --file <path>\n${SWARM_HELP}`);

  const project = existeConfig(repo) ? leerConfig(repo) : undefined;
  const num = (s: string | undefined, d: number, name: string) => {
    if (s === undefined) return d;
    const n = Number(s);
    if (!Number.isInteger(n) || n < 1) throw new Error(`--${name} must be a positive integer`);
    return n;
  };
  const tiers: Tier[] = [
    { name: "small", command: v.small ?? process.env.ORQEN_SWARM_SMALL ?? SWARM_DEFAULTS.small, attempts: num(v["small-attempts"], 2, "small-attempts") },
    { name: "large", command: v.large ?? process.env.ORQEN_SWARM_LARGE ?? SWARM_DEFAULTS.large, attempts: num(v["large-attempts"], 2, "large-attempts") },
  ];
  const planner = v.planner ?? process.env.ORQEN_SWARM_PLANNER ?? SWARM_DEFAULTS.planner;
  const testCommand = v.test ?? project?.entornos.tests.unitarios ?? undefined;
  const setup = v["no-setup"] ? [] : (v.setup as string[] | undefined) ?? project?.entornos.preparar ?? [];
  const timeoutMs = num(v.timeout, 20, "timeout") * 60_000;
  const yes = !!v.yes || !interactivo();
  const runId = newRunId();
  const stateDir = join(repo, "orqen", "state", "swarm", runId);
  const quiet = !!v.json;

  // Capture the starting checkout before planning, which can take several minutes.
  let git: SwarmGit | undefined;
  if (v.apply) {
    git = new SwarmGit(repo, runId, join(stateDir, "unused"));
    git.checkApply();
  }

  if (!quiet) p.intro(pc.bold("orqen swarm"));

  // 1. Plan
  let plan: Plan;
  if (v.plan) {
    const r = Plan.safeParse(JSON.parse(readFileSync(resolve(v.plan), "utf8")));
    if (!r.success) throw new Error(`Invalid plan: ${r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    const errors = validatePlan(r.data);
    if (errors.length) throw new Error(`Invalid plan:\n- ${errors.join("\n- ")}`);
    plan = r.data;
  } else {
    const s = quiet ? undefined : p.spinner();
    s?.start(`Planning with ${gris(planner)}`);
    const r = await planTask(repo, task, planner, { testCommand, timeoutMs, onRetry: (e) => s?.message(`Plan rejected (${e.length} error${e.length > 1 ? "s" : ""}), asking again`) });
    if (!r.ok) { s?.error("Planning failed"); throw new Error(`The planner did not produce a valid plan:\n- ${r.errors.join("\n- ")}`); }
    s?.stop(`Plan: ${r.plan!.subtasks.length} subtasks`);
    plan = r.plan!;
  }
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "plan.json"), JSON.stringify(plan, null, 2));

  if (v["plan-only"]) {
    if (quiet) console.log(JSON.stringify(plan, null, 2));
    else { p.note(describePlan(plan, tiers).join("\n"), plan.summary); p.outro(`Plan saved to ${join(stateDir, "plan.json")} · run it with --plan`); }
    return;
  }

  // 2. Confirm with the person (unless --yes or unattended)
  git ??= new SwarmGit(repo, runId, join(stateDir, "unused"));
  if (!quiet) {
    p.note(describePlan(plan, tiers).join("\n"), plan.summary);
    p.log.info([
      `Workers: ${tiers.map((t) => `${t.name} ×${t.attempts} ${gris(`(${t.command})`)}`).join(" → ")} · ${num(v.parallel, 4, "parallel")} in parallel`,
      `Final test: ${plan.finalTest || testCommand || gris("none")} · setup per worktree: ${setup.length ? setup.join(" && ") : gris("none")}`,
    ].join("\n"));
    if (git.dirty()) p.log.warn("You have uncommitted changes: the swarm starts from the last commit and does not include them.");
  }
  if (!(await confirmar("Launch the swarm with this plan?", true, yes))) { p.cancel("Canceled. The plan is in " + join(stateDir, "plan.json")); return; }

  // 3. Run
  if (v.apply) git.checkApply();
  const report = await runSwarm({
    repo, task: task || plan.summary, plan, tiers, runId, stateDir,
    parallel: num(v.parallel, 4, "parallel"), testCommand, setup,
    agentTimeoutMs: timeoutMs, testTimeoutMs: timeoutMs, keepWorktrees: !!v.keep,
    onEvent: quiet ? undefined : printEvent,
  });

  if (v.apply && report.ok) git.apply(report.branch);

  if (quiet) { console.log(JSON.stringify({ ...report, applied: !!v.apply && report.ok }, null, 2)); }
  else {
    const lines = report.tasks.map((t) => `${icon[t.status]} ${t.id} ${gris(t.solvedBy ? `${t.solvedBy}, ${t.attempts.length} attempt${t.attempts.length > 1 ? "s" : ""}` : t.reason ?? "")}`);
    if (report.finalTest) lines.push(`${report.finalTest.passed ? icon.merged : icon.failed} final test ${gris(report.finalTest.command)}${report.finalTest.fixAttempts ? gris(` (${report.finalTest.fixAttempts} integrator fix${report.finalTest.fixAttempts > 1 ? "es" : ""})`) : ""}`);
    p.note(lines.join("\n"), report.ok ? "All subtasks merged" : "Swarm finished with problems");
    p.log.info([
      `Result branch: ${pc.cyan(report.branch)} (${report.commits.length} commits)`,
      `Report and logs: ${gris(stateDir)}`,
      `Review: git log --oneline ${report.baseCommit.slice(0, 8)}..${report.branch}`,
      v.apply && report.ok ? "Result integrated into the starting branch." : `Bring it in: git merge ${report.branch}`,
    ].join("\n"));
    p.outro(report.ok ? pc.green("Done") : pc.yellow("Done with failures"));
  }
  if (!report.ok) process.exitCode = 1;
}
