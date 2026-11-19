/**
 * Eval cases: a ticket, the step the agent runs on it and what a good run looks like. They live in the project
 * (orqen/evals/*.yaml, committed, so the whole team shares them); the built-in ones cover the basics when a project
 * has none. `orqen learn --to-eval` turns a run marked wrong in the desktop app into a new case.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import type { EvalTicket } from "./fake-jira.ts";

/** The steps an eval can run (the /orqen:* command and the stage whose output is checked). */
export const EVAL_STEPS = {
  support: { command: "support", stage: "SUPPORT" },
  analyze: { command: "analyze", stage: "ANALYSIS" },
} as const;
export type EvalStep = keyof typeof EVAL_STEPS;

export interface EvalCase {
  id: string;
  /** support | analyze */
  step: EvalStep;
  description?: string;
  /** Language the agent talks in (es | en). */
  lang?: string;
  ticket: EvalTicket;
  /** Files of the project the agent can read (path → content), on top of a README. */
  files?: Record<string, string>;
  expect: {
    /** Allowed states after the run (any of them). */
    state?: string[];
    /** Fields of the stage output that must have this value (e.g. outcome: escalate, ready: false). */
    output?: Record<string, unknown>;
    /** Minimum length of list fields of the output (e.g. open_questions: 1). */
    min_items?: Record<string, number>;
    /** Texts (case-insensitive) that must / must not appear in the output and in what was posted on the ticket. */
    must_mention?: string[];
    must_not_mention?: string[];
    /** Most it may cost (US$, when the agent reports it). */
    max_cost_usd?: number;
  };
  /** Where it was read from ("built-in" or the file). */
  source?: string;
}

export const BUILT_IN: EvalCase[] = [
  {
    id: "support-escalates-new-feature",
    step: "support",
    description: "A request for something the product does not do: support escalates it and promises nothing.",
    ticket: { title: "Export invoices to CSV", description: "Accounting needs to download the month's invoices as a CSV file. Today they copy them by hand from the invoices screen." },
    files: { "src/invoices.js": "export function listInvoices(db) { return db.query('select * from invoices'); }\n" },
    expect: {
      state: ["ANALYSIS"],
      output: { outcome: "escalate" },
      must_mention: ["CSV"],
      must_not_mention: ["tomorrow", "next week", "by friday", "guarantee", "already available"],
    },
  },
  {
    id: "support-answers-from-the-docs",
    step: "support",
    description: "The answer is in the project's docs: support answers the client with it, without inventing steps.",
    ticket: { title: "How do I reset my password?", description: "I forgot my password and I cannot find where to change it." },
    files: { "docs/help.md": "# Help\n\n## Passwords\n\nTo reset your password open Settings › Security and press \"Send reset link\". The link arrives by email and lasts 30 minutes.\n" },
    expect: {
      state: ["ACCEPTANCE"],
      output: { outcome: "resolved" },
      must_mention: ["Security", "reset link"],
      must_not_mention: ["sms", "call us", "24 hours"],
    },
  },
  {
    id: "analysis-asks-instead-of-inventing",
    step: "analyze",
    description: "A vague request: the analysis asks the client what is missing instead of making up scope or numbers.",
    ticket: { title: "The report is slow", description: "Please make it faster." },
    files: { "src/reports.js": "export async function salesReport(db, from, to) { return db.query('select * from sales where day between ? and ?', [from, to]); }\n" },
    expect: {
      state: ["WAITING_CLIENT", "BLOCKED"],
      output: { ready: false },
      min_items: { open_questions: 1 },
    },
  },
];

/** The project's cases (orqen/evals/*.yaml); the built-in ones when it has none. */
export function loadCases(repo: string): EvalCase[] {
  const dir = join(repo, "orqen", "evals");
  const own: EvalCase[] = [];
  if (existsSync(dir)) {
    for (const f of readdirSync(dir).filter((x) => /\.ya?ml$/.test(x)).sort()) {
      const c = parse(readFileSync(join(dir, f), "utf8")) as EvalCase;
      const problems = validateCase(c);
      if (problems.length) throw new Error(`orqen/evals/${f}: ${problems.join("; ")}`);
      own.push({ ...c, source: `orqen/evals/${f}` });
    }
  }
  return own.length ? own : BUILT_IN.map((c) => ({ ...c, source: "built-in" }));
}

export function validateCase(c: EvalCase): string[] {
  const p: string[] = [];
  if (!c || typeof c !== "object") return ["not a case"];
  if (!c.id) p.push("id is missing");
  if (!c.step || !(c.step in EVAL_STEPS)) p.push(`step must be one of: ${Object.keys(EVAL_STEPS).join(", ")}`);
  if (!c.ticket?.title) p.push("ticket.title is missing");
  if (!c.expect || typeof c.expect !== "object") p.push("expect is missing");
  return p;
}
