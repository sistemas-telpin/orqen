/**
 * Swarm planning: a capable model breaks a task into small subtasks that small models can solve
 * in parallel. The plan is a dependency graph validated before any worker starts.
 */
import { z } from "zod";
import { extraerJson } from "../lib/agent.ts";
import { ejecutarAsync, partirComando } from "../lib/proc.ts";

export const Subtask = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,40}$/, "use 1-41 lowercase letters, digits, or hyphens"),
  title: z.string().min(1),
  description: z.string().min(1).describe("Self-contained instructions: a small model must solve it without seeing other subtasks"),
  files: z.array(z.string()).default([]).describe("Files the subtask creates or edits (relative to the repository root)"),
  dependsOn: z.array(z.string()).default([]).describe("Subtask ids that must be merged before this one starts"),
  acceptance: z.array(z.string()).default([]),
  test: z.string().nullish().describe("Fast command, run from the repository root, that passes only when the subtask is done"),
  difficulty: z.enum(["simple", "complex"]).default("simple").describe("complex starts directly on the large model"),
});
export type Subtask = z.infer<typeof Subtask>;

export const Plan = z.object({
  summary: z.string(),
  subtasks: z.array(Subtask).min(1).max(40),
  finalTest: z.string().nullish().describe("Command that verifies the whole task after every subtask is merged"),
});
export type Plan = z.infer<typeof Plan>;

export function planJsonSchema() {
  return z.toJSONSchema(Plan, { io: "input" });
}

/** Ids of every subtask that `id` depends on, directly or transitively. */
export function ancestors(plan: Plan, id: string): Set<string> {
  const byId = new Map(plan.subtasks.map((s) => [s.id, s]));
  const out = new Set<string>();
  const stack = [...(byId.get(id)?.dependsOn ?? [])];
  while (stack.length) {
    const d = stack.pop()!;
    if (out.has(d)) continue;
    out.add(d);
    stack.push(...(byId.get(d)?.dependsOn ?? []));
  }
  return out;
}

/** Structural checks the schema cannot express. Returns a list of errors (empty = valid). */
export function validatePlan(plan: Plan): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const s of plan.subtasks) {
    if (ids.has(s.id)) errors.push(`duplicate subtask id "${s.id}"`);
    ids.add(s.id);
  }
  for (const s of plan.subtasks) {
    for (const d of s.dependsOn) {
      if (d === s.id) errors.push(`${s.id} depends on itself`);
      else if (!ids.has(d)) errors.push(`${s.id} depends on unknown subtask "${d}"`);
    }
  }
  if (errors.length) return errors;
  // Cycles (Kahn's algorithm).
  const pending = new Map(plan.subtasks.map((s) => [s.id, new Set(s.dependsOn)]));
  let progress = true;
  while (progress && pending.size) {
    progress = false;
    for (const [id, deps] of pending) {
      if ([...deps].every((d) => !pending.has(d))) { pending.delete(id); progress = true; }
    }
  }
  if (pending.size) return [`dependency cycle among: ${[...pending.keys()].join(", ")}`];
  // Subtasks that may run at the same time must not touch the same files.
  const norm = (f: string) => f.replace(/\\/g, "/").replace(/^\.\//, "");
  const anc = new Map(plan.subtasks.map((s) => [s.id, ancestors(plan, s.id)]));
  for (let i = 0; i < plan.subtasks.length; i++) {
    for (let j = i + 1; j < plan.subtasks.length; j++) {
      const a = plan.subtasks[i], b = plan.subtasks[j];
      if (anc.get(a.id)!.has(b.id) || anc.get(b.id)!.has(a.id)) continue;
      const shared = a.files.map(norm).filter((f) => b.files.map(norm).includes(f));
      if (shared.length) errors.push(`${a.id} and ${b.id} can run in parallel but both touch ${shared.join(", ")}: make one depend on the other or merge them`);
    }
  }
  return errors;
}

/** Order in which subtasks can be merged (a topological order). */
export function topologicalOrder(plan: Plan): Subtask[] {
  const done = new Set<string>(), out: Subtask[] = [];
  while (out.length < plan.subtasks.length) {
    const next = plan.subtasks.filter((s) => !done.has(s.id) && s.dependsOn.every((d) => done.has(d)));
    if (!next.length) throw new Error("the plan has a dependency cycle");
    for (const s of next) { done.add(s.id); out.push(s); }
  }
  return out;
}

export function plannerPrompt(task: string, o: { testCommand?: string; errors?: string[] } = {}): string {
  return [
    "You are the ORQEN swarm planner. Break the task below into small subtasks that cheap, fast models",
    "(e.g. Claude Haiku) will solve in parallel, each in its own git worktree, without talking to each other.",
    "Read the repository as needed to plan well, but do not modify any file.",
    "",
    "Task:",
    task.trim(),
    "",
    "How to split:",
    "- Each subtask is small and concrete: ideally one to three files and one clear outcome.",
    "- `description` is self-contained: the worker only sees its own subtask, the overall task, and the code.",
    "  Name exact files, functions, signatures, and data shapes it must use so parallel pieces fit together.",
    "- Maximize parallelism: only add `dependsOn` when a subtask really needs another one's code.",
    "  Subtasks without a dependency between them must not list the same file in `files`.",
    "- Shared contracts (types, interfaces, schemas) go in an early subtask that the others depend on.",
    "- Give every subtask a fast `test` command run from the repository root that fails until the subtask is done",
    "  (a focused unit test, a type check, a script). The subtask may write that test itself.",
    "- Mark `difficulty: \"complex\"` only when a small model clearly cannot do it.",
    `- \`finalTest\` verifies the whole task after all merges${o.testCommand ? ` (the project's suite is \`${o.testCommand}\`)` : ""}.`,
    "- Use short lowercase hyphenated ids (e.g. `user-model`, `login-endpoint`). Write in English.",
    "",
    "Output JSON Schema:",
    JSON.stringify(planJsonSchema()),
    "",
    ...(o.errors?.length ? ["The previous plan was rejected. Fix these errors:", ...o.errors.map((e) => `- ${e}`), ""] : []),
    "Reply with only the JSON object, without Markdown or extra text.",
  ].join("\n");
}

export interface PlanResult { ok: boolean; plan?: Plan; errors: string[]; output: string }

/** Ask the planner agent for a plan; invalid plans get one retry with the validation errors. */
export async function planTask(
  repo: string, task: string, command: string,
  o: { testCommand?: string; timeoutMs?: number; onRetry?: (errors: string[]) => void } = {},
): Promise<PlanResult> {
  const [bin, ...args] = partirComando(command);
  const usesArg = args.some((a) => a.includes("{prompt}"));
  let errors: string[] | undefined, output = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const prompt = plannerPrompt(task, { testCommand: o.testCommand, errors });
    const r = await ejecutarAsync(bin, usesArg ? args.map((a) => a.replace("{prompt}", prompt)) : args, {
      cwd: repo, entrada: usesArg ? undefined : prompt, timeoutMs: o.timeoutMs ?? 15 * 60_000,
    });
    output = (r.stdout + "\n" + r.stderr).trim();
    if (r.error) return { ok: false, errors: [`Could not execute "${bin}": ${r.error.message}`], output };
    const data = extraerJson(r.stdout);
    if (data === undefined) {
      errors = [r.codigo !== 0 ? `The planner exited with code ${r.codigo}: ${output.slice(-300)}` : "The planner returned no JSON"];
    } else {
      const v = Plan.safeParse(data);
      if (v.success) {
        errors = validatePlan(v.data);
        if (!errors.length) return { ok: true, plan: v.data, errors: [], output };
      } else {
        errors = v.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
      }
    }
    if (attempt === 0) o.onRetry?.(errors);
  }
  return { ok: false, errors: errors ?? [], output };
}
