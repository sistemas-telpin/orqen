/** Output contract of each stage. `orqen complete` rejects anything that does not comply. */
import { z } from "zod";
import { LANES, type Lane, type AgentState } from "./states.ts";

const list = z.array(z.string());

export const SCHEMAS = {
  SUPPORT: z.object({
    summary: z.string().min(20).describe("What the client reports, in business terms"),
    checked: list.min(1).describe("What was checked to answer: the issue and comments, similar requests, the knowledge base, the repository"),
    outcome: z.enum(["resolved", "escalate"]).describe("resolved = the client can be answered without development or analysis; escalate = the analyst must take it"),
    client_response: z.string().default("").describe("Reply to the client. Mandatory when resolved; optional interim reply when escalating"),
    escalation_summary: z.string().default("").describe("Mandatory when escalating: what is known, what was tried, what is missing and why it needs an analyst"),
    support_ok: z.boolean().default(false).describe("The support person explicitly approved the outcome and the text that will reach the client. Mandatory"),
  }).superRefine((s, ctx) => {
    const missing = (path: string, message: string) => ctx.addIssue({ code: "custom", path: [path], message });
    if (!s.support_ok) missing("support_ok", "The support person must approve the outcome and the client reply (support_ok=true)");
    if (s.outcome === "resolved" && s.client_response.trim().length < 20) missing("client_response", "When resolved, write the reply to the client (≥20 characters)");
    if (s.outcome === "escalate" && s.escalation_summary.trim().length < 20) missing("escalation_summary", "When escalating, explain what is known and why an analyst is needed (≥20 characters)");
  }),

  ANALYSIS: z.object({
    summary: z.string().min(20).describe("What the client asks for, in business terms"),
    type: z.enum(["feature", "change", "bug", "query", "performance", "other"]),
    acceptance_criteria: list.min(1).describe("Verifiable (Given/When/Then); they become the OpenSpec Scenarios or the testing checklist of the direct lane"),
    affected_capabilities: list.describe("openspec/specs paths it touches (or new ones, in kebab-case)"),
    decisions: z.array(z.object({ question: z.string(), answer: z.string() })).default([])
      .describe("Grilling log: each question the analyst resolved and its answer"),
    open_questions: list.max(5).describe("Only those the CLIENT must answer and that block the specification"),
    risks: list,
    related: list.optional(),
    ready: z.boolean().describe("true if the analyst gave the OK and it is enough to move forward"),
    analyst_ok: z.boolean().default(false).describe("The analyst explicitly confirmed the analysis AND the chosen lane. Mandatory with ready=true"),
    route: z.enum(["development", "operational"]).default("development")
      .describe("operational = resolved WITHOUT changing code (SQL script, restart, data cleanup, configuration); development = requires code"),
    lane: z.enum(LANES as [Lane, ...Lane[]]).optional()
      .describe("direct (no spec) | light | full. Mandatory with ready=true. The operational route is always direct"),
    lane_rationale: z.string().optional().describe("Why that lane (size, risk, scope)"),
    plan: list.optional().describe("Direct lane (development route): implementation steps in order"),
    estimated_hours: z.number().nonnegative().optional().describe("Direct lane: total estimate. In light/full it is computed from tasks.md"),
    spec: z.object({
      change: z.string().describe("id of the OpenSpec change assigned by orqen lane"),
      summary: z.string().min(20).describe("Summary of the proposal"),
      assumptions: list,
    }).optional().describe("Mandatory in the light and full lanes"),
  }).superRefine((s, ctx) => {
    if (!s.ready) return;
    const missing = (path: string, message: string) => ctx.addIssue({ code: "custom", path: [path], message });
    if (!s.analyst_ok) missing("analyst_ok", "With ready=true the analyst must have given an explicit OK (analyst_ok=true)");
    if (!s.lane) return missing("lane", "With ready=true choose the lane: direct | light | full");
    if (!s.lane_rationale || s.lane_rationale.length < 10) missing("lane_rationale", "Justify the chosen lane");
    if (s.route === "operational" && s.lane !== "direct") missing("lane", "The operational route has no spec: the lane is direct");
    if (s.route === "development" && s.lane === "direct" && !s.plan?.length) missing("plan", "The direct lane needs the implementation plan");
    if (s.route === "development" && s.lane !== "direct" && !s.spec) missing("spec", "The light and full lanes need the spec (orqen lane + OpenSpec artifacts)");
  }),

  DEVELOPMENT: z.object({
    completed: z.boolean(),
    changes_summary: z.string(),
    modified_files: list,
    added_tests: list,
    blocker: z.string().optional().describe("Mandatory if completed=false"),
  }).refine((s) => s.completed || !!s.blocker, { message: "If completed=false explain the blocker", path: ["blocker"] }),

  TESTING: z.object({
    scenarios: z.array(z.object({
      requirement: z.string(),
      scenario: z.string(),
      covered: z.boolean(),
      test: z.string().optional().describe("file::name of the test that covers it"),
    })).describe("ONE per each Scenario of the change's spec deltas"),
    failure_diagnosis: z.string(),
    suggestions: list,
    coverage_ok: z.boolean(),
  }),

  DELIVERY: z.object({
    release_notes: z.string(),
    client_message: z.string().min(20),
    validation_steps: list.min(1),
  }),

  EXECUTION: z.object({
    summary: z.string().min(20).describe("What will be done and why it resolves the request"),
    system: z.string().min(2).describe("Where it is applied (database, server, service)"),
    impact: z.string().min(10).describe("What it touches: affected rows/tables/services, window, downtime"),
    estimated_rows: z.number().int().nonnegative().optional().describe("Rows the script affects (obtained with a prior SELECT COUNT)"),
    sql_script: z.string().optional().describe("SQL script to run, complete"),
    manual_steps: list.optional().describe("Non-SQL steps in order (restarts, commands, configuration)"),
    rollback: z.string().min(5).describe("How to undo it (script or procedure); if there is no way back, say so and why"),
    verification: z.string().min(5).describe("SELECT query or check that confirms it is resolved"),
    risks: list,
  }).refine((s) => !!s.sql_script?.trim() || !!s.manual_steps?.length, {
    message: "There must be sql_script or manual_steps", path: ["sql_script"],
  }),

  VERIFICATION: z.object({
    verified: z.boolean().describe("true if the evidence confirms the problem is solved"),
    evidence: z.string().min(5).describe("Verification result (output of the query/check)"),
    requires_development: z.boolean().default(false).describe("true if it was shown that the cause needs a code change"),
    client_message: z.string().default(""),
    validation_steps: list.default([]),
  }).refine((s) => !s.verified || (s.client_message.length >= 20 && s.validation_steps.length > 0), {
    message: "If verified=true fill in client_message (≥20 characters) and validation_steps", path: ["client_message"],
  }),
} satisfies Record<AgentState, z.ZodType>;

export type Output<S extends AgentState> = z.infer<(typeof SCHEMAS)[S]>;

export const jsonSchema = (s: AgentState) => z.toJSONSchema(SCHEMAS[s], { io: "input" });
