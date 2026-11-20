/**
 * Who has to act on each request and which command comes next: the 9 steps of the orqen flow
 * (list requests · support · analyze · list issues · implement · pr · review (QA) · list prs · approve).
 * Pure functions over the stored work item: `orqen list`, `orqen status <KEY> --json` and the desktop app use them.
 */
import type { Config } from "./config.ts";
import type { WorkItem } from "./store.ts";

/** Who acts now. `client` and `gate` wait outside the team's queue; `blocked` waits for a person on the ticket. */
export type Role = "support" | "analyst" | "developer" | "qa" | "senior" | "client" | "gate" | "blocked" | "done";

/** One suggested command. `step` is its number in the 9-step flow (0 = not one of the 9: a plain orqen command). */
export interface NextStep { step: number; role: Role; command: string; what: string }

/** The key a developer works with: the issue when there is one. */
export const workKey = (item: WorkItem) => item.issue ?? item.key;

/** The full lane goes through QA (QA_REVIEW, after TESTING) before the senior. */
export const needsQa = (item: WorkItem) => item.lane === "full" && item.route !== "operational";

/** Came back to development with something to fix: failed tests, QA rejection or changes requested by the senior. */
export function returned(item: WorkItem): string | undefined {
  if (item.state !== "DEVELOPMENT") return undefined;
  const r = [...item.feedback].reverse().find((f) => f.rejection);
  if (r) return `${r.from}: ${r.rejection}`;
  if (item.testingAttempts > 0) return `testing failed (attempt ${item.testingAttempts})`;
  return undefined;
}

export function roleOf(item: WorkItem, cfg: Pick<Config, "supportStage">): Role {
  switch (item.state) {
    case "NEW": return cfg.supportStage ? "support" : "analyst";
    case "SUPPORT": return "support";
    case "ANALYSIS": return "analyst";
    case "WAITING_CLIENT": case "ACCEPTANCE": return "client";
    case "DEVELOPMENT": case "TESTING": case "EXECUTION": case "VERIFICATION": return "developer";
    case "QA_REVIEW": return "qa";
    case "CODE_REVIEW": return item.artifacts.devel_pr ? "senior" : "developer";
    case "DELIVERY": return "senior";
    case "EXECUTION_APPROVAL": case "APPLICATION": return "gate";
    case "BLOCKED": return "blocked";
    default: return "done";
  }
}

/** The commands that move the request on from where it is, first the recommended one. */
export function nextSteps(item: WorkItem, cfg: Pick<Config, "supportStage">): NextStep[] {
  const k = item.key, ik = workKey(item);
  const s = (step: number, role: Role, command: string, what: string): NextStep => ({ step, role, command, what });
  switch (item.state) {
    case "NEW": {
      const support = s(2, "support", `/orqen:support ${k}`, "First-line support: answer the client or escalate");
      const analyze = s(3, "analyst", `/orqen:analyze ${k}`, "Analysis: criteria, lane and spec");
      return cfg.supportStage ? [support, analyze] : [analyze, support];
    }
    case "SUPPORT": return [s(2, "support", `/orqen:support ${k}`, "Continue support")];
    case "ANALYSIS": return [s(3, "analyst", `/orqen:analyze ${k}`, "Continue the analysis")];
    case "WAITING_CLIENT": return [s(0, "client", `orqen status ${k}`, "Waiting for the client's answers on the request")];
    case "DEVELOPMENT": return [s(5, "developer", `/orqen:implement ${ik}`, returned(item) ? "Implement the requested changes" : "Implement")];
    case "TESTING": return [s(5, "developer", `/orqen:implement ${ik}`, "The agent runs the testing on its own (full regression)")];
    case "QA_REVIEW": return [
      s(7, "qa", `/orqen:review ${ik}`, "QA: check the e2e of the change on screen, approve or reject"),
      ...(item.artifacts.devel_pr ? [] : [s(6, "developer", `/orqen:pr ${ik}`, "Open the PR")]),
    ];
    case "CODE_REVIEW":
      if (!item.artifacts.devel_pr) return [s(6, "developer", `/orqen:pr ${ik}`, "Explain the changes and open the PR")];
      return [s(9, "senior", `/orqen:approve ${ik}`, "Senior: approve the PR or request changes")];
    case "DELIVERY":
      if (item.origin === "internal") return [s(0, "senior", item.artifacts.devel_pr ? `merge ${item.artifacts.devel_pr}` : `orqen status ${k}`, "Merge the approved PR by hand: orqen detects it and closes this internal development")];
      return item.artifacts.devel_pr && !item.artifacts.devel_pr_merged
      ? [s(0, "senior", `merge ${item.artifacts.devel_pr}`, "Merge the approved PR by hand; orqen detects it"), s(9, "senior", `/orqen:approve ${ik}`, "Then deliver to the client")]
      : [s(9, "senior", `/orqen:approve ${ik}`, "Deliver to the client")];
    case "ACCEPTANCE": return [s(0, "client", `orqen status ${k}`, "Waiting for the client to confirm with /approve")];
    case "EXECUTION": case "VERIFICATION": return [s(0, "developer", `orqen take ${ik}`, "Operational stage")];
    case "EXECUTION_APPROVAL": case "APPLICATION": return [s(0, "gate", `orqen status ${k}`, "Waiting for /approve on the request")];
    case "BLOCKED": return [s(0, "blocked", `orqen status ${k}`, "Blocked: answer on the request with /approve <what to do>")];
    default: return [];
  }
}

/** The 9 commands of the flow, for menus and autocompletion. */
export const FLOW_COMMANDS: { step: number; role: Role | "all"; command: string; arg?: string; what: string }[] = [
  { step: 1, role: "all", command: "/orqen:list", arg: "requests", what: "Everyone's work list, by role" },
  { step: 2, role: "support", command: "/orqen:support", arg: "<KEY>", what: "First-line support" },
  { step: 3, role: "analyst", command: "/orqen:analyze", arg: "<KEY>", what: "Interview, criteria, lane and spec" },
  { step: 4, role: "developer", command: "/orqen:list", arg: "issues", what: "Development queue" },
  { step: 5, role: "developer", command: "/orqen:implement", arg: "<KEY>", what: "Implement after approving the plan" },
  { step: 6, role: "developer", command: "/orqen:pr", arg: "<KEY>", what: "Explain the changes and open the PR" },
  { step: 7, role: "qa", command: "/orqen:review", arg: "<KEY>", what: "QA: e2e on screen, approve or reject" },
  { step: 8, role: "senior", command: "/orqen:list", arg: "prs", what: "Senior's review queue" },
  { step: 9, role: "senior", command: "/orqen:approve", arg: "<KEY>", what: "Approve the PR or request changes" },
];
