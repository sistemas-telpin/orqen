/**
 * REC state machine. This code decides the FLOW; the agent (any one:
 * Claude Code, Codex, Cursor, Copilot...) only produces content at each stage.
 *
 * SUPPORT (optional, `SUPPORT_STAGE=on`) and ANALYSIS are the stretches driven by a person (support via `/orqen:support`,
 * the analyst via `/orqen:analyze`). Once ANALYSIS closes with the analyst's OK, the lane, the spec (if any) and the SIS are decided.
 */
export const State = {
  NEW: "NEW",
  SUPPORT: "SUPPORT",                 // support person + agent: tries to answer the client; resolves (→ ACCEPTANCE) or escalates (→ ANALYSIS)
  ANALYSIS: "ANALYSIS",               // analyst + agent (grilling): understand, pick lane, spec if needed, create the SIS
  WAITING_CLIENT: "WAITING_CLIENT",   // gate: the client answers questions
  DEVELOPMENT: "DEVELOPMENT",         // agent: implements (openspec apply, or the plan of the direct lane)
  TESTING: "TESTING",                 // script runs tests; agent verifies scenarios/criteria
  CODE_REVIEW: "CODE_REVIEW",         // gate: a senior reviews the PR
  DELIVERY: "DELIVERY",               // script: openspec archive (if there was a spec); agent: notes + message
  // --- fast lane (route=operational): SQL script / restart / runbook, no code or OpenSpec
  EXECUTION: "EXECUTION",             // agent: prepares script/steps + rollback + verification
  EXECUTION_APPROVAL: "EXECUTION_APPROVAL", // gate: DBA/infra authorizes what is about to be run
  APPLICATION: "APPLICATION",         // gate: a person applies it and reports the result
  VERIFICATION: "VERIFICATION",       // agent: verifies (read-only) that the problem is solved
  ACCEPTANCE: "ACCEPTANCE",           // gate: the client signs off
  CLOSED: "CLOSED",
  BLOCKED: "BLOCKED",
} as const;
export type State = (typeof State)[keyof typeof State];

export type AgentState = "SUPPORT" | "ANALYSIS" | "DEVELOPMENT" | "TESTING" | "DELIVERY" | "EXECUTION" | "VERIFICATION";
export const AGENT_STATES: readonly State[] = ["SUPPORT", "ANALYSIS", "DEVELOPMENT", "TESTING", "DELIVERY", "EXECUTION", "VERIFICATION"];

/** How a REC is resolved: development (code) or operational (fast lane: SQL, restarts...). */
export type Route = "development" | "operational";

/**
 * How much specification a development REC carries (proposed by the agent, confirmed by the analyst):
 *  - direct: no OpenSpec. The plan and acceptance criteria live in the analysis and in the SIS.
 *  - light:  compact OpenSpec change (proposal + deltas + tasks; minimal design).
 *  - full:   full OpenSpec change (proposal + specs + design + tasks).
 */
export type Lane = "direct" | "light" | "full";
export const LANES: readonly Lane[] = ["direct", "light", "full"];

export const isAgentState = (s: State): s is AgentState => AGENT_STATES.includes(s);

export type Gate = "WAITING_CLIENT" | "CODE_REVIEW" | "ACCEPTANCE" | "EXECUTION_APPROVAL" | "APPLICATION";
export const GATES: Record<Gate, { kind: "answer" | "approval"; approve: State; reject: State }> = {
  WAITING_CLIENT: { kind: "answer", approve: "ANALYSIS", reject: "ANALYSIS" },
  CODE_REVIEW: { kind: "approval", approve: "DELIVERY", reject: "DEVELOPMENT" },
  ACCEPTANCE: { kind: "approval", approve: "CLOSED", reject: "ANALYSIS" },
  EXECUTION_APPROVAL: { kind: "approval", approve: "APPLICATION", reject: "EXECUTION" },
  APPLICATION: { kind: "approval", approve: "VERIFICATION", reject: "EXECUTION" },
};
export const isGate = (s: State): s is Gate => s in GATES;

export const MAX_TESTING_ATTEMPTS = 3;
export const MAX_QUESTION_ROUNDS = 3;

/** Next state from the (already validated) output of a stage. */
export function nextStateAfterStage(
  state: AgentState,
  output: Record<string, any>,
  c: { testingAttempts: number; questionRounds: number },
): State {
  switch (state) {
    case "SUPPORT":
      // resolved: the client confirms in ACCEPTANCE (no SIS is created); escalated: the analyst continues with what support found
      return output.outcome === "resolved" ? "ACCEPTANCE" : "ANALYSIS";
    case "ANALYSIS":
      if (output.open_questions?.length && !output.ready)
        return c.questionRounds >= MAX_QUESTION_ROUNDS ? "BLOCKED" : "WAITING_CLIENT";
      // ready = the analyst gave the OK: the route decides the path (no intermediate gate)
      return output.route === "operational" ? "EXECUTION" : "DEVELOPMENT";
    case "DEVELOPMENT":
      return output.completed ? "TESTING" : "BLOCKED";
    case "TESTING":
      if (output.approved) return "CODE_REVIEW";
      return c.testingAttempts >= MAX_TESTING_ATTEMPTS ? "BLOCKED" : "DEVELOPMENT";
    case "DELIVERY":
      return "ACCEPTANCE";
    case "EXECUTION":
      return "EXECUTION_APPROVAL";
    case "VERIFICATION":
      if (output.verified) return "ACCEPTANCE";
      if (output.requires_development) return "ANALYSIS";   // escalation: the analyst re-analyzes and picks a development lane
      return c.testingAttempts >= MAX_TESTING_ATTEMPTS ? "BLOCKED" : "EXECUTION";
  }
}
