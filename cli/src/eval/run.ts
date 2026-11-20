/**
 * `orqen eval`: runs an agent on each case in a throwaway project (git repo + orqen + an in-memory Jira) through
 * the real /orqen:* command and CLI, then checks what it left: the state, the stage output (already validated by its
 * schema), what it posted on the ticket, cost, and optionally a judge for made-up facts.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import { escribirConfig, leerConfig } from "../lib/config.ts";
import { ejecutarAsync, partirComando } from "../lib/proc.ts";
import { Store } from "../workflow/store.ts";
import { EVAL_STEPS, type EvalCase } from "./cases.ts";
import { FakeJira } from "./fake-jira.ts";

export const EVAL_KEY = "REQ-1";

export interface Check { name: string; ok: boolean; detail?: string }
export interface CaseResult {
  id: string; step: string; source?: string; pass: boolean; checks: Check[];
  state?: string; output?: unknown; posted: string[]; cost?: number; secs: number; log: string; error?: string;
}
export interface EvalOptions {
  /** How to run this same CLI: [node, script]. */
  cli: [string, string];
  /** Headless agent command (the prompt goes on stdin, or replaces {prompt}). */
  agentCmd: string;
  /** Judge command for made-up facts (same form); none = no judge. */
  judgeCmd?: string;
  outDir: string;
  keep?: boolean;
  timeoutMs?: number;
  /** The project's orqen/knowledge (team lessons), copied into each test project; none = run without lessons. */
  knowledge?: string;
}

const PREAMBLE = [
  "You are being evaluated by `orqen eval` on a test project. Nobody will answer you: the evaluator plays the person.",
  "Wherever the instructions say to wait for the person's OK or approval, take YOUR OWN recommendation as approved and continue",
  "(set the *_ok fields only for what you recommended). Wherever you would ask the person something, decide with the information you have;",
  "questions for the CLIENT go where the instructions say. Never wait for input. Run the CLI as `orqen`.",
].join(" ");

/** A /orqen:<command> expanded from the project's plugin file: its instructions and the tools it declares. */
export function expandCommand(repo: string, command: string, args: string): { prompt: string; tools: string[] } {
  const raw = readFileSync(join(repo, "orqen", "plugin", "commands", `${command}.md`), "utf8").replace(/\r\n/g, "\n");
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  const front = m?.[1] ?? "", body = m ? raw.slice(m[0].length) : raw;
  const line = front.split("\n").find((l) => l.startsWith("allowed-tools:"))?.slice("allowed-tools:".length) ?? "";
  const tools: string[] = [];
  let depth = 0, cur = "";
  for (const ch of line) {
    if (ch === "(") depth++; else if (ch === ")") depth--;
    if (ch === "," && depth === 0) { tools.push(cur.trim()); cur = ""; } else cur += ch;
  }
  if (cur.trim()) tools.push(cur.trim());
  return {
    prompt: `Run the orqen command /orqen:${command} ${args}. Its instructions follow, with $ARGUMENTS = "${args}".\n\n${body.replaceAll("$ARGUMENTS", args).trim()}`,
    tools: tools.filter((t) => t && t !== "AskUserQuestion"),
  };
}

/** The agent command line for a prompt; Claude Code gets the command's tools and JSON output (for the cost). */
export function agentArgs(agentCmd: string, prompt: string, tools: string[]): { bin: string; args: string[]; stdin?: string } {
  const [bin, ...args] = partirComando(agentCmd);
  if (args.some((a) => a.includes("{prompt}"))) return { bin, args: args.map((a) => a.replaceAll("{prompt}", prompt)) };
  if (basename(bin).toLowerCase().startsWith("claude")) {
    if (!args.includes("--output-format")) args.push("--output-format", "json");
    if (!args.includes("--allowedTools")) {
      const all = ["Bash(orqen:*)", "Read", "Grep", "Glob", ...tools];
      const twins = all.filter((t) => t.startsWith("Bash(")).map((t) => `PowerShell(${t.slice(5)}`);
      args.push("--allowedTools", ...new Set([...all, ...twins]));
    }
    if (!args.includes("--disallowedTools")) args.push("--disallowedTools", "AskUserQuestion");
  }
  return { bin, args, stdin: prompt };
}

/** Value of a dotted path (outcome, spec.change…). */
const at = (v: unknown, path: string) => path.split(".").reduce<any>((o, k) => (o == null ? undefined : o[k]), v);

export function checkCase(c: EvalCase, r: { state?: string; output?: unknown; posted: string[]; cost?: number }): Check[] {
  const e = c.expect ?? {};
  const out: Check[] = [];
  const stage = EVAL_STEPS[c.step].stage;
  out.push({ name: `completed ${stage}`, ok: r.output !== undefined, detail: r.output === undefined ? "the agent did not finish the stage (no valid output via orqen complete)" : undefined });
  if (e.state?.length) out.push({ name: `state ∈ ${e.state.join("|")}`, ok: !!r.state && e.state.includes(r.state), detail: `state ${r.state ?? "?"}` });
  for (const [k, want] of Object.entries(e.output ?? {})) {
    const got = at(r.output, k);
    out.push({ name: `${k} = ${JSON.stringify(want)}`, ok: JSON.stringify(got) === JSON.stringify(want), detail: `got ${JSON.stringify(got)}` });
  }
  for (const [k, n] of Object.entries(e.min_items ?? {})) {
    const got = at(r.output, k);
    const len = Array.isArray(got) ? got.length : 0;
    out.push({ name: `${k} ≥ ${n}`, ok: len >= n, detail: `${len}` });
  }
  const text = `${JSON.stringify(r.output ?? {})}\n${r.posted.join("\n")}`.toLowerCase();
  for (const m of e.must_mention ?? []) out.push({ name: `mentions "${m}"`, ok: text.includes(m.toLowerCase()) });
  for (const m of e.must_not_mention ?? []) out.push({ name: `does not mention "${m}"`, ok: !text.includes(m.toLowerCase()) });
  if (e.max_cost_usd !== undefined) out.push({ name: `cost ≤ US$ ${e.max_cost_usd}`, ok: r.cost === undefined || r.cost <= e.max_cost_usd, detail: r.cost === undefined ? "not reported" : `US$ ${r.cost.toFixed(3)}` });
  return out;
}

/** Cost reported by the agent's output (Claude Code JSON: total_cost_usd). */
export function costOf(stdout: string): number | undefined {
  const all = [...stdout.matchAll(/"total_cost_usd"\s*:\s*([0-9.]+)/g)];
  return all.length ? Number(all[all.length - 1][1]) : undefined;
}

export async function runCase(c: EvalCase, o: EvalOptions): Promise<CaseResult> {
  const started = Date.now();
  const root = mkdtempSync(join(tmpdir(), "orqen-eval-"));
  const repo = join(root, "project"), bin = join(root, "bin");
  mkdirSync(repo); mkdirSync(bin);
  mkdirSync(o.outDir, { recursive: true });
  const log = join(o.outDir, `${c.id}.log`);
  const jira = new FakeJira({ [EVAL_KEY]: c.ticket });
  const result: CaseResult = { id: c.id, step: c.step, source: c.source, pass: false, checks: [], posted: [], secs: 0, log };
  try {
    // `orqen` in the agent's PATH is this same CLI
    const [node, script] = o.cli;
    writeFileSync(join(bin, "orqen"), `#!/bin/sh\nexec "${node}" "${script}" "$@"\n`); chmodSync(join(bin, "orqen"), 0o755);
    writeFileSync(join(bin, "orqen.cmd"), `@"${node}" "${script}" %*\r\n`);
    const url = await jira.start();
    const env: NodeJS.ProcessEnv = {
      ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", ORQEN_LANG: c.lang ?? "en", OPENSPEC_TELEMETRY_DISABLED: "1",
      JIRA_URL: url, JIRA_DEPLOYMENT: "server", JIRA_USER: "orqen-eval", JIRA_TOKEN: "orqen-eval", BASE_BRANCH: "main", ORQEN_AGENT: "eval",
      PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
    };
    // the case's project, not the one this command was run from
    for (const k of ["ORQEN_STATE_DIR", "REC_STATE_DIR", "REPO_PATH", "FACTORY_DIR", "SUPPORT_STAGE"]) delete env[k];
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, env, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
    git("init", "-qb", "main"); git("config", "user.name", "orqen eval"); git("config", "user.email", "eval@orqen.invalid");
    writeFileSync(join(repo, "README.md"), "# Test project\n\nA small business application used by `orqen eval`.\n");
    for (const [p, content] of Object.entries(c.files ?? {})) { mkdirSync(dirname(join(repo, p)), { recursive: true }); writeFileSync(join(repo, p), content); }
    const init = await ejecutarAsync(node, [script, "init", "--yes", "--no-ai", "--no-openspec", "--no-connectors", "--no-animation"], { cwd: repo, env, timeoutMs: 120_000 });
    if (init.codigo !== 0) throw new Error(`orqen init failed: ${init.stderr || init.stdout}`);
    const cfg = leerConfig(repo);
    cfg.conectores = {
      requests: { tipo: "jira", filtro: "project = REQ" },
      issues: { tipo: "jira", proyecto: "DEV", tipo_ticket: "Task", vinculo: "Relates" },
    } as typeof cfg.conectores;
    escribirConfig(repo, cfg);
    // with the team's lessons, the cases measure the agent as the team runs it (and --no-lessons, without them)
    if (o.knowledge && existsSync(o.knowledge)) cpSync(o.knowledge, join(repo, "orqen", "knowledge"), { recursive: true });
    git("add", "-A"); git("commit", "-qm", "Test project with orqen");

    const { command } = EVAL_STEPS[c.step];
    const { prompt, tools } = expandCommand(repo, command, EVAL_KEY);
    const run = agentArgs(o.agentCmd, `${PREAMBLE}\n\n${prompt}`, tools);
    const r = await ejecutarAsync(run.bin, run.args, { cwd: repo, env, entrada: run.stdin, timeoutMs: o.timeoutMs ?? 15 * 60_000 });
    writeFileSync(log, `$ ${o.agentCmd}\n(exit ${r.codigo})\n\n--- stdout\n${r.stdout}\n\n--- stderr\n${r.stderr}\n`);
    result.cost = costOf(r.stdout);
    const item = new Store(join(repo, "orqen", "state")).get(EVAL_KEY);
    result.state = item?.state;
    result.output = item?.artifacts?.[EVAL_STEPS[c.step].stage];
    result.posted = jira.posted(EVAL_KEY);
    result.checks = checkCase(c, result);
    if (o.judgeCmd && result.output !== undefined) result.checks.push(await judge(c, result, o.judgeCmd, repo, env));
    result.pass = result.checks.every((k) => k.ok);
  } catch (e) {
    result.error = (e as Error).message;
    result.checks.push({ name: "run", ok: false, detail: result.error });
  } finally {
    await jira.stop();
    result.secs = (Date.now() - started) / 1000;
    if (!o.keep) rmSync(root, { recursive: true, force: true });
    else result.log += ` (project: ${repo})`;
  }
  return result;
}

/** A second agent reads the ticket, the project files and what the first one produced, and says if it made things up. */
async function judge(c: EvalCase, r: CaseResult, cmd: string, cwd: string, env: NodeJS.ProcessEnv): Promise<Check> {
  const prompt = [
    "You check the work of another AI agent for MADE-UP FACTS. Answer ONLY a JSON object: {\"grounded\": true|false, \"problems\": [\"…\"]}.",
    "grounded=false if the output states facts (features, steps, dates, numbers, names, causes, promises) that are not supported by the ticket or the project files below.",
    "Reasonable questions, plans and general wording are fine.",
    "", "## Ticket", JSON.stringify(c.ticket, null, 2),
    "", "## Project files", ...Object.entries(c.files ?? {}).map(([p, t]) => `### ${p}\n${t}`),
    "", "## Agent output (stage)", JSON.stringify(r.output, null, 2),
    "", "## Posted on the ticket", ...r.posted,
  ].join("\n");
  const run = agentArgs(cmd, prompt, []);
  const j = await ejecutarAsync(run.bin, run.args, { cwd, env, entrada: run.stdin, timeoutMs: 5 * 60_000 });
  let text = j.stdout;
  try { const v = JSON.parse(text); if (typeof v.result === "string") text = v.result; } catch { /* plain text */ }
  const m = text.match(/\{[\s\S]*"grounded"[\s\S]*\}/);
  if (!m) return { name: "judge: no made-up facts", ok: false, detail: `the judge did not answer JSON (exit ${j.codigo})` };
  try {
    const v = JSON.parse(m[0]);
    return { name: "judge: no made-up facts", ok: v.grounded === true, detail: (v.problems ?? []).join(" · ") || undefined };
  } catch { return { name: "judge: no made-up facts", ok: false, detail: "unreadable judge answer" }; }
}
