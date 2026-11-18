/**
 * Core of the request process. Used by the CLI (`orqen ...`) and the tests.
 *
 *  - review():   advances everything that does NOT need an agent (gates, unblocks) and lists the pending work.
 *  - analyze():  opens the analysis driven by an analyst (grilling) and returns the context.
 *  - lane():     records the chosen lane; for light/full it creates the branch + OpenSpec change.
 *  - take():     reserves a request at an agent stage, prepares branch/tests/OpenSpec and returns the context.
 *  - complete(): validates the output (schema + OpenSpec), publishes to the tickets/git/factory and moves the state.
 *                When closing ANALYSIS with the analyst's OK it creates the internal ticket (if configured) and links it to the external one.
 *
 * The external ticket is what the client sees; the internal one (optional) is the team's. Both are reached through connectors/.
 */
import { join } from "node:path";
import { detectarIdioma } from "../lib/lang.ts";
import type { Config } from "./config.ts";
import { SCHEMAS } from "./schemas.ts";
import {
  LANES, type Lane, type State, type AgentState, GATES, isAgentState, isGate, nextStateAfterStage,
} from "./states.ts";
import { Factory } from "./factory.ts";
import { canLinkNatively, type Comment, type Connectors, isBotComment, type Tracker } from "../connectors/index.ts";
import { type Scenario, type OpenSpecApi, type Task, hoursOf } from "./openspec.ts";
import { reviewSql } from "./sql.ts";
import { type WorkItem, Store, newWorkItem } from "./store.ts";
import { branchFor, type EnvironmentResult, type PrReview, type Workspace } from "./workspace.ts";

const CMD = /^\s*\/(approve|reject)\b\s*([\s\S]*)/i;
/** Verdicts of `orqen review` (code review report for the senior) and how they read on the ticket. */
export const VERDICTS = { approve: "Approvable", minor: "Approvable with minor changes", reject: "Reject" } as const;
const COMMENT_MAX = 30_000;   // Jira rejects comments over 32767 characters (GitHub: 65536)

/** `for` says who has to act: support (SUPPORT, or NEW with SUPPORT_STAGE=on), the analyst (NEW/ANALYSIS) or an unattended agent. */
export interface Pending { key: string; state: AgentState | "NEW"; for: "support" | "analyst" | "agent"; takenBy?: string }
export type CompleteResult = { ok: true; next: State } | { ok: false; errors: string[] };

export class Process {
  private fac: Factory;
  /** Where the client's ticket lives. */
  private ext: Tracker;
  /** Where the team's ticket is created (optional). */
  private int?: Tracker;
  constructor(
    private cfg: Config, connectors: Connectors, private store: Store,
    private ws: Workspace, private os: OpenSpecApi,
  ) {
    this.fac = new Factory(cfg.factoryDir);
    this.ext = connectors.external;
    this.int = connectors.internal;
  }

  // ================================================================ review
  async review(): Promise<Pending[]> {
    const pending: Pending[] = [];
    for (const key of await this.ext.pending()) {
      try {
        const item = this.store.get(key) ?? newWorkItem(key);
        if (isGate(item.state)) await this.reviewGate(item as WorkItem & { state: keyof typeof GATES });
        else if (item.state === "BLOCKED") await this.reviewUnblock(item);
        if (item.state === "NEW") pending.push({ key, state: "NEW", for: this.cfg.supportStage ? "support" : "analyst" });
        else if (isAgentState(item.state)) {
          const lock = this.activeLock(item);
          pending.push({ key, state: item.state, for: item.state === "ANALYSIS" ? "analyst" : item.state === "SUPPORT" ? "support" : "agent", takenBy: lock?.agent });
        }
      } catch (e) {
        await this.block(key, `Error reviewing the request: ${(e as Error).message}`, "process");
      }
    }
    return pending;
  }

  // ================================================================ support
  /**
   * Opens (or resumes) the first-line handling of a request (available even with SUPPORT_STAGE=off: that variable only decides whether new requests are routed here). The support person drives it; the agent helps them
   * find an answer. The stage ends resolved (the client confirms in ACCEPTANCE) or escalated to the analyst.
   */
  async support(key: string, agent = "agent", person = agent) {
    const item = this.store.get(key) ?? newWorkItem(key);
    if (item.state !== "NEW" && item.state !== "SUPPORT")
      throw new Error(`${key} is not waiting for support (state: ${item.state}).${item.state === "ANALYSIS" ? " It was escalated to the analyst: use `orqen analyze`." : ""}`);
    this.assertClaimable(item, agent);
    if (item.state === "NEW") {
      item.supporter = person;
      await this.ext.comment(key, `${person} (support) is handling this request.`);
      await this.move(item, "SUPPORT", "taken by support", agent);
    }
    item.supporter = person;
    this.store.save(item);
    return this.take(key, agent, true);
  }

  // ================================================================ analyze
  /** Opens (or resumes) the analysis of a request. An analyst drives it; the agent does the grilling with them. */
  async analyze(key: string, agent = "agent", analyst = agent) {
    const item = this.store.get(key) ?? newWorkItem(key);
    if (item.state === "WAITING_CLIENT")
      throw new Error(`${key} is waiting for client answers on the ticket. When they reply it goes back to ANALYSIS (\`orqen pending\`).`);
    if (item.state !== "NEW" && item.state !== "SUPPORT" && item.state !== "ANALYSIS")
      throw new Error(`${key} already went through the analysis (state: ${item.state}). If it must be redone, a rejection or an escalation sends it back to ANALYSIS.`);
    this.assertClaimable(item, agent);
    if (item.state === "NEW" || item.state === "SUPPORT") {
      const from = item.state;
      item.analyst = analyst;
      await this.ext.comment(key, `${analyst} started analyzing this request.`);
      await this.move(item, "ANALYSIS", from === "SUPPORT" ? "taken by the analyst before support finished" : "registered by analyst", agent);
    }
    item.analyst = analyst;
    this.store.save(item);
    return this.take(key, agent, true);
  }

  /** Records the lane. Light/full: prepares branch + OpenSpec change so the agent writes the spec. */
  async lane(key: string, lane: string, agent = "agent") {
    const item = this.store.get(key);
    if (!item || item.state !== "ANALYSIS") throw new Error(`${key} is not in ANALYSIS (state: ${item?.state ?? "unknown"}).`);
    const lock = this.activeLock(item) ?? (item.lock?.agent === agent ? item.lock : undefined);
    if (!lock || lock.agent !== agent) throw new Error(`Run \`orqen analyze ${key}\` first`);
    if (!LANES.includes(lane as Lane)) throw new Error(`Invalid lane "${lane}". Options: ${LANES.join(", ")}`);
    item.lane = lane as Lane;
    if (item.lane === "direct") {
      this.store.save(item);
      return { lane: item.lane, openspec: undefined as undefined | { change: string; dir: string }, branch: undefined as string | undefined };
    }
    const issue = await this.ext.ticket(key);
    item.branch = this.ws.prepareBranch(key);
    if (!item.change || !this.os.exists(item.change)) {
      item.change = changeName(key, issue.title, item.round);
      this.os.newChange(item.change, `${key}: ${issue.title}`);
    }
    this.store.save(item);
    return { lane: item.lane, branch: item.branch, openspec: { change: item.change, dir: `openspec/changes/${item.change}` } };
  }

  // ================================================================ take
  async take(key: string, agent = "agent", fromAnalyze = false) {
    const item = this.store.get(key);
    if (!item || !isAgentState(item.state))
      throw new Error(`${key} has no work for an agent (state: ${item?.state ?? "unknown"}). Run \`orqen pending\`.`);
    if (item.state === "ANALYSIS" && !fromAnalyze)
      throw new Error(`The analysis of ${key} is driven by an analyst: use /orqen:analyze ${key} (or \`orqen analyze ${key}\`).`);
    if (item.state === "SUPPORT" && !fromAnalyze)
      throw new Error(`Support for ${key} is driven by a person: use /orqen:support ${key} (or \`orqen support ${key}\`).`);
    this.assertClaimable(item, agent);
    item.lock = { agent, since: new Date().toISOString() };
    this.store.save(item);

    const issue = await this.ext.ticket(key);
    const state = item.state;

    // ANALYSIS (light/full are created by `orqen lane`) and the fast lane (EXECUTION/VERIFICATION) do not prepare a branch here
    if (["DEVELOPMENT", "TESTING", "DELIVERY"].includes(state)) item.branch = this.ws.prepareBranch(key);
    let environment: EnvironmentResult | undefined;
    if (state === "DEVELOPMENT") environment = await this.ws.startEnvironment?.(false);
    if (state === "TESTING") {
      try {
        environment = await this.ws.startEnvironment?.(true);
        item.artifacts.test_result = environment?.ok === false
          ? { ok: false, output: environment.output ?? environment.detail }
          : this.ws.runTests();
      } finally {
        this.ws.stopEnvironment?.();
      }
    }
    if (state === "DELIVERY" && item.change && !item.artifacts.archive) {
      item.artifacts.archive = this.os.archive(item.change);
      this.ws.commit(key, `Archive OpenSpec change ${item.change}`);
      this.attempt(() => this.ws.push(item.branch));
    }
    this.store.save(item);

    const comments = (await this.ext.comments(key)).map((c) => ({
      author: c.authorName, date: c.created, text: c.body, is_agent: isBotComment(c.body),
    }));
    const openspec = item.change ? {
      change: item.change,
      dir: item.artifacts.archive ? `openspec/changes/archive/${item.artifacts.archive.archivedAs}` : `openspec/changes/${item.change}`,
    } : undefined;

    return {
      item,
      context: {
        key, state, round: item.round, branch: item.branch || undefined,
        // A person is on the other side (everything but the unattended `orqen cycle`): keep them informed and ask them.
        human_present: agent !== "cycle",
        // The person's language, from the operating system: talk to them in it (artifacts keep their own rules).
        language: detectarIdioma(),
        supporter: item.supporter, analyst: item.analyst, lane: item.lane, factory: `orqen/work/${key}/round-${item.round}`,
        issue, internal: item.internal, comments, environment,
        openspec,
        ...(["DEVELOPMENT", "TESTING"].includes(state) ? { tasks: this.tasksOf(item) } : {}),
        ...(state === "TESTING" ? { scenarios: this.scenariosOf(item) } : {}),
        test_result: state === "TESTING" ? item.artifacts.test_result : undefined,
        previous_stages: Object.fromEntries(Object.entries(item.artifacts).filter(([k]) => SCHEMAS[k as AgentState])),
        human_feedback: item.feedback,
      },
    };
  }

  // ================================================================ pr
  /** Where the request branch would go and whether it can be sent now (used by `orqen pr <KEY>` before writing the explanation). */
  prInfo(key: string) {
    const item = this.store.get(key);
    if (!item) throw new Error(`${key} is unknown to orqen.`);
    if (item.route === "operational") throw new Error(`${key} is operational (no code): there is no branch to send.`);
    if (!item.branch || !["TESTING", "CODE_REVIEW", "DELIVERY", "ACCEPTANCE", "CLOSED"].includes(item.state))
      throw new Error(`${key} is in ${item.state}: the PR to ${this.cfg.develBranch} is opened once development is done (TESTING or later).`);
    return {
      key, state: item.state, branch: item.branch, base: this.cfg.develBranch, lane: item.lane, internal: item.internal,
      analysis: `orqen/work/${key}/round-${item.round}/analysis.md`,
      change: item.change ? `openspec/changes/${item.change}` : undefined,
      existing: item.artifacts.devel_pr as string | undefined,
    };
  }

  /**
   * Sends the request branch to the development branch: records the explanation (written by the agent), commits what is pending
   * on the branch (e.g. hand adjustments), pushes and opens the PR. If the PR already exists it only pushes the new commits.
   */
  async pr(key: string, body: string, title?: string, agent = "agent") {
    const info = this.prInfo(key);
    const item = this.store.get(key)!;
    if (body.trim().length < 80) throw new Error("The explanation is too short: describe what changed, why and how to verify it.");
    // fail before writing anything: otherwise devel-pr.md and the pending changes would stay out of the pushed branch
    const current = this.ws.currentBranch();
    if (current !== item.branch)
      throw new Error(`The repo is on "${current}", not on the request branch "${item.branch}": switch to it (git checkout ${item.branch}) and run again.`);
    const bodyFile = `orqen/work/${key}/round-${item.round}/devel-pr.md`;
    this.fac.write(item, "devel-pr.md", body.trim() + "\n");
    this.ws.commit(key, `PR explanation for ${info.base}`, { branch: item.branch });
    this.ws.push(item.branch);
    if (info.existing) return { url: info.existing, created: false, base: info.base };
    const issue = await this.ext.ticket(key);
    const out = this.ws.openPr({
      key, branch: item.branch, base: info.base, body: bodyFile, change: item.change,
      title: (title ?? item.artifacts.ANALYSIS?.summary ?? issue.title).slice(0, 80),
    }, this.cfg.develPrCommand);
    const url = out.match(/https?:\/\/\S+/)?.[0];
    if (!url) throw new Error(`The PR was not opened. Output: ${out || "(none)"}`);
    item.artifacts.devel_pr = url;
    this.store.save(item);
    await this.commentBoth(item, `PR to *${info.base}* opened from branch \`${item.branch}\`: ${url}`);
    this.store.log(key, { ts: new Date().toISOString(), from: item.state, to: item.state, detail: `PR to ${info.base}: ${url}`, agent });
    return { url, created: true, base: info.base };
  }

  // ================================================================ code review
  /**
   * Records the code review report (written by the agent for the senior) without moving the state: saves it in
   * round-N/code-review-<n>.md, comments it on the internal ticket (or the external one) and logs it. With CODE_REVIEW_GATE=ticket the senior still gives /approve or /reject on the ticket.
   */
  async codeReview(key: string, body: string, verdict: string, agent = "agent") {
    const item = this.store.get(key);
    if (!item) throw new Error(`${key} is unknown to orqen.`);
    if (item.route === "operational") throw new Error(`${key} is operational (no code): there is nothing to review.`);
    if (item.state !== "CODE_REVIEW") throw new Error(`${key} is in ${item.state}: the code review is recorded in CODE_REVIEW.`);
    if (!item.artifacts.devel_pr) throw new Error(`${key} has no PR to ${this.cfg.develBranch} yet: open it first with \`orqen pr ${key} <explanation.md>\`.`);
    if (!(verdict in VERDICTS)) throw new Error(`Invalid verdict "${verdict}". Options: ${Object.keys(VERDICTS).join(", ")}`);
    if (body.trim().length < 80) throw new Error("The report is too short: include the verdict, the findings and their possible solutions.");

    const reviews: { round: number; n: number; verdict: string; file: string; ts: string }[] = (item.artifacts.code_reviews ??= []);
    const n = reviews.filter((r) => r.round === item.round).length + 1;
    const file = `code-review-${n}.md`;
    const path = `orqen/work/${key}/round-${item.round}/${file}`;
    this.fac.write(item, file, body.trim() + "\n");
    reviews.push({ round: item.round, n, verdict, file: path, ts: new Date().toISOString() });
    this.store.save(item);
    // only commits the report, and only on the request branch (no push: it travels with the next push of the branch)
    const committed = this.ws.commit(key, `code review #${n}`, { branch: item.branch, path: join(this.cfg.factoryDir, key) });

    const label = VERDICTS[verdict as keyof typeof VERDICTS];
    const text = `*Code review #${n}* (round ${item.round}) — verdict: *${label}*\nPR: ${item.artifacts.devel_pr}\n\n${body.trim()}`;
    // the report is already saved: a connector failure must not abort (retrying would duplicate it as #n+1)
    const onInternal = !!(item.internal && this.int);
    let commentedOn: string | undefined = onInternal ? item.internal : key;
    try {
      await (onInternal ? this.int! : this.ext).comment(commentedOn!, text.length > COMMENT_MAX ? text.slice(0, COMMENT_MAX) + `\n\n… (truncated; full report in \`${path}\`)` : text);
    } catch (e) {
      console.error(`[orqen] warning: could not comment the code review on ${commentedOn}: ${(e as Error).message}`);
      commentedOn = undefined;
    }
    this.store.log(key, { ts: new Date().toISOString(), from: item.state, to: item.state, detail: `code review #${n}: ${verdict}`, agent });
    return { n, path, verdict, committed, commentedOn };
  }

  // ================================================================ complete
  async complete(key: string, raw: unknown, agent = "agent"): Promise<CompleteResult> {
    const item = this.store.get(key);
    if (!item || !isAgentState(item.state)) return { ok: false, errors: [`${key} is not in an agent stage`] };
    // an expired lock stays valid while nobody else took the request (the grilling can last longer than ORQEN_LOCK_MIN)
    const lock = this.activeLock(item) ?? (item.lock?.agent === agent ? item.lock : undefined);
    if (!lock) return { ok: false, errors: [`Run \`orqen ${item.state === "ANALYSIS" ? "analyze" : item.state === "SUPPORT" ? "support" : "take"} ${key}\` first`] };
    if (lock.agent !== agent) return { ok: false, errors: [`${key} is taken by "${lock.agent}"`] };

    const state = item.state;
    const parsed = SCHEMAS[state].safeParse(raw);
    if (!parsed.success)
      return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`) };
    const s: Record<string, any> = parsed.data;

    // --- validations against OpenSpec / repo (the agent fixes and completes again)
    const errors = this.validateAgainstOpenSpec(item, state, s);
    if (errors.length) return { ok: false, errors };

    // --- counters and decision
    if (state === "ANALYSIS") {
      item.route = s.route;
      if (s.ready) item.lane = s.lane;
      if (s.open_questions.length && !s.ready) item.questionRounds++;
    }
    if (state === "VERIFICATION") item.testingAttempts++;
    if (state === "TESTING") {
      item.testingAttempts++;
      s.approved = item.artifacts.test_result?.ok === true && s.coverage_ok && s.scenarios.every((e: any) => e.covered);
    }
    item.artifacts[state] = s;
    const next = nextStateAfterStage(state, s, item);
    if (state === "VERIFICATION" && next === "ANALYSIS") {  // escalation: the new analysis creates a development internal ticket
      item.route = "development"; delete item.lane; delete item.artifacts.internal_linked;
      if (item.internal) { (item.artifacts.previous_internal ??= []).push(item.internal); delete item.internal; }
    }
    if (state === "VERIFICATION" && next !== "EXECUTION") item.testingAttempts = 0;

    if (state === "ANALYSIS" && s.ready) await this.closeAnalysis(item, s);
    if (state === "DEVELOPMENT") this.ws.stopEnvironment?.();
    await this.publish(item, state, s, next);
    item.feedback = [];
    await this.move(item, next, `stage ${state} completed`, agent);
    return { ok: true, next };
  }

  private validateAgainstOpenSpec(item: WorkItem, state: AgentState, s: Record<string, any>): string[] {
    const err: string[] = [];
    if (state === "ANALYSIS" && s.ready && s.route === "development" && s.lane !== "direct") {
      if (item.lane !== s.lane) err.push(`The analysis lane ("${s.lane}") does not match the recorded one (${item.lane ?? "none"}): run \`orqen lane ${item.key} ${s.lane}\` and write the spec`);
      else if (!item.change) err.push(`The change is missing: run \`orqen lane ${item.key} ${s.lane}\``);
      else {
        if (s.spec.change !== item.change) err.push(`spec.change must be "${item.change}"`);
        const v = this.os.validate(item.change);
        if (!v.ok) err.push("openspec validate --strict failed:", ...v.problems.map((p) => "  " + p));
        if (!this.os.planningComplete(item.change)) err.push("The change is missing artifacts (see `openspec status --change " + item.change + "`)");
        const tasks = this.os.tasks(item.change);
        if (!tasks.length) err.push("tasks.md has no tasks");
        const unestimated = tasks.filter((t) => t.hours === undefined);
        if (unestimated.length) err.push(`Each task must end with its estimate, e.g. "(4h)". Not estimated: ${unestimated.map((t) => t.description).join(" | ")}`);
      }
    }
    if (state === "ANALYSIS" && s.ready && s.lane === "direct" && item.lane && item.lane !== "direct" && item.change)
      err.push(`You recorded the ${item.lane} lane and a change already exists (${item.change}); pick one or the other (if the decision changed run \`orqen lane ${item.key} direct\` and do not use the change).`);
    if (state === "DEVELOPMENT" && s.completed && item.change) {
      const pending = this.os.tasks(item.change).filter((t) => !t.done);
      if (pending.length) err.push(`There are unticked tasks in tasks.md: ${pending.map((t) => t.description).join(" | ")}`);
    }
    if (state === "EXECUTION") {
      err.push(...reviewSql(s.sql_script ?? "", "sql_script"), ...reviewSql(s.rollback, "rollback"));
    }
    if (state === "TESTING") {
      const reported = new Set(s.scenarios.map((e: any) => norm(e.scenario)));
      const missing = this.scenariosOf(item).filter((e) => !reported.has(norm(e.scenario)));
      if (missing.length) err.push(`Scenarios still to evaluate: ${missing.map((e) => `${e.requirement} › ${e.scenario}`).join(" | ")}`);
    }
    return err;
  }

  /** Tasks of the request: those in tasks.md (light/full) or the analysis plan (direct). */
  private tasksOf(item: WorkItem): Task[] {
    if (item.change) return this.os.tasks(item.change);
    return ((item.artifacts.ANALYSIS?.plan ?? []) as string[]).map((p) => ({ description: p, done: false, hours: hoursOf(p) }));
  }

  /** What testing must cover: Scenarios of the spec deltas, or the acceptance criteria in the direct lane. */
  private scenariosOf(item: WorkItem): Scenario[] {
    if (item.change) return this.os.scenarios(item.change);
    return ((item.artifacts.ANALYSIS?.acceptance_criteria ?? []) as string[])
      .map((c) => ({ capability: "-", requirement: "Acceptance criterion", scenario: c }));
  }

  // ================================================================ analysis closing
  /** With the analyst's OK: estimate, record in orqen/work/, spec commit (if any) and internal ticket linked to the external one. */
  private async closeAnalysis(item: WorkItem, s: Record<string, any>) {
    item.artifacts.estimated_hours = item.change
      ? this.os.tasks(item.change).reduce((a, t) => a + (t.hours ?? 0), 0)
      : s.estimated_hours;
    await this.createInternal(item);
    this.recordAnalysis(item, s);
    if (item.change) this.ws.commit(item.key, `spec OpenSpec ${item.change}`);
  }

  private recordAnalysis(item: WorkItem, s: Record<string, any>) {
    const md = (t: string, xs: string[]) => xs.length ? `## ${t}\n\n${xs.map((x) => `- ${x}`).join("\n")}\n\n` : "";
    this.fac.write(item, "analysis.json", JSON.stringify(s, null, 2) + "\n");
    this.fac.write(item, "analysis.md",
      `# ${item.key} — analysis (round ${item.round})\n\n` +
      `- **Analyst:** ${item.analyst ?? "?"}\n- **Route:** ${s.route}\n- **Lane:** ${s.lane}\n- **Lane rationale:** ${s.lane_rationale}\n` +
      `- **Internal ticket:** ${item.internal ?? "—"}\n` + (item.change ? `- **OpenSpec change:** openspec/changes/${item.change}/\n` : "") +
      (item.artifacts.estimated_hours !== undefined ? `- **Estimate:** ${item.artifacts.estimated_hours} h\n` : "") +
      `\n## Summary\n\n${s.summary}\n\n` +
      md("Acceptance criteria", s.acceptance_criteria) +
      (s.plan?.length ? `## Plan (direct lane)\n\n${s.plan.map((x: string, i: number) => `${i + 1}. ${x}`).join("\n")}\n\n` : "") +
      (s.decisions.length ? `## Analyst decisions\n\n${s.decisions.map((d: any) => `- **${d.question}** → ${d.answer}`).join("\n")}\n\n` : "") +
      md("Affected capabilities", s.affected_capabilities) + md("Risks", s.risks) +
      (s.spec ? md("Specification assumptions", s.spec.assumptions) : ""));
  }

  // ================================================================ publish
  private async publish(item: WorkItem, state: AgentState, s: Record<string, any>, next: State) {
    const k = item.key;
    switch (state) {
      case "SUPPORT": {
        const resolved = s.outcome === "resolved";
        this.fac.write(item, "support.json", JSON.stringify(s, null, 2) + "\n");
        this.fac.write(item, "support.md",
          `# ${k} — support (round ${item.round})\n\n- **Support:** ${item.supporter ?? "?"}\n- **Outcome:** ${s.outcome}\n\n## Summary\n\n${s.summary}\n\n` +
          `## Checked\n\n${bullets(s.checked)}\n\n` +
          (s.client_response.trim() ? `## Reply to the client\n\n${s.client_response.trim()}\n\n` : "") +
          (s.escalation_summary.trim() ? `## Escalation\n\n${s.escalation_summary.trim()}\n` : ""));
        if (resolved)
          return this.ext.comment(k, `${s.client_response.trim()}\n\n_Answered by support${item.supporter ? ` (${item.supporter})` : ""}._\n` +
            `To confirm the request is solved, comment */approve*. To report that it is not, comment */reject <reason>*.`);
        return this.ext.comment(k, (s.client_response.trim() ? `${s.client_response.trim()}\n\n` : "") +
          `*Support${item.supporter ? ` (${item.supporter})` : ""}*\n${s.summary}\n\n*Escalated to analysis:*\n${s.escalation_summary.trim()}\n\n*Checked:*\n${bullets(s.checked)}`);
      }
      case "ANALYSIS": {
        let t = `*Analysis*${item.analyst ? ` (analyst: ${item.analyst})` : ""}\n${s.summary}\n\n*Type:* ${s.type}\n\n*Acceptance criteria:*\n${bullets(s.acceptance_criteria)}`;
        if (s.risks.length) t += `\n\n*Risks:*\n${bullets(s.risks)}`;
        if (s.ready) {
          t += `\n\n*Lane:* ${s.route === "operational" ? "operational (no code changes)" : s.lane} — ${s.lane_rationale}`;
          if (item.change) {
            const sc = this.os.scenarios(item.change);
            t += `\n*Spec:* OpenSpec change \`${item.change}\` (branch \`${item.branch}\`), ${sc.length} scenario(s), ${item.artifacts.estimated_hours} estimated hours.`;
          } else if (s.route === "development") t += `\n*Plan:*\n${bullets(s.plan ?? [], true)}` + (s.estimated_hours !== undefined ? `\n*Estimate:* ${s.estimated_hours} h` : "");
          if (item.internal) t += `\n*Internal ticket:* ${item.internal}`;
        }
        if (next === "WAITING_CLIENT") t += `\n\n*Please confirm the following so we can specify the request:*\n${bullets(s.open_questions, true)}`;
        if (next === "BLOCKED") t += "\n\nThe question limit has been reached. Human review is needed.";
        return this.ext.comment(k, t);
      }
      case "DEVELOPMENT":
        if (s.completed) {
          this.ws.commit(k, s.changes_summary.slice(0, 200));
          return this.commentBoth(item, `Development complete on branch \`${item.branch}\`.\n${s.changes_summary}\n\nTests added:\n${bullets(s.added_tests)}\nMoving to testing.`);
        }
        return this.commentBoth(item, `Development could not be completed: ${s.blocker}`);
      case "TESTING": {
        const rt = item.artifacts.test_result;
        const table = s.scenarios.map((e: any) => `- ${e.covered ? "✔" : "✘"} ${e.requirement} › ${e.scenario}${e.test ? ` (${e.test})` : ""}`).join("\n");
        if (s.approved) {
          // testing does not open the PR: the senior reviews the PR to the devel branch (`orqen pr`)
          const pr = item.artifacts.devel_pr ? `PR to *${this.cfg.develBranch}*: ${item.artifacts.devel_pr}` : `Branch \`${item.branch}\` (the PR to *${this.cfg.develBranch}* is opened with /orqen:pr)`;
          const decide = this.cfg.codeReviewGate === "github"
            ? "Code review: approve or request changes on the PR in GitHub."
            : "Code review: comment */approve* or */reject <reason>*.";
          return this.commentBoth(item, `Tests passed and all scenarios are covered:\n${table}\n\n${pr}\n${decide}`);
        }
        return this.commentBoth(item, `Testing failed (attempt ${item.testingAttempts}). Suite: ${rt?.ok ? "OK" : "FAILED"}\n${table}\n\nDiagnosis: ${s.failure_diagnosis}` +
          (next === "BLOCKED" ? "\nRetries are exhausted. Human review is needed." : "\nReturning to development."));
      }
      case "EXECUTION": {
        this.fac.write(item, "execution/summary.md", `# Operational proposal\n\n${s.summary}\n\n- System: ${s.system}\n- Impact: ${s.impact}\n`);
        if (s.sql_script) this.fac.write(item, "execution/script.sql", s.sql_script);
        if (s.manual_steps?.length) this.fac.write(item, "execution/steps.md", bullets(s.manual_steps, true));
        this.fac.write(item, "execution/rollback.txt", s.rollback);
        this.fac.write(item, "execution/verification.txt", s.verification);
        const t = `*Operational proposal (no code changes)*\n${s.summary}\n\n*System:* ${s.system}\n*Impact:* ${s.impact}` +
          (s.estimated_rows !== undefined ? `\n*Estimated rows:* ${s.estimated_rows}` : "") +
          (s.sql_script ? `\n\n*SQL script:*\n{code:sql}\n${s.sql_script}\n{code}` : "") +
          (s.manual_steps?.length ? `\n\n*Manual steps:*\n${bullets(s.manual_steps, true)}` : "") +
          `\n\n*Rollback:*\n{code}\n${s.rollback}\n{code}\n\n*Verification:*\n{code}\n${s.verification}\n{code}` +
          (s.risks.length ? `\n\n*Risks:*\n${bullets(s.risks)}` : "") +
          `\n\nTo authorize the change, comment */approve*. To request revisions, comment */reject <reason>*.`;
        return this.commentBoth(item, t);
      }
      case "VERIFICATION": {
        const t = `*Verification*\n${s.evidence}\n\n`;
        if (next === "ACCEPTANCE")
          return this.commentBoth(item, t + `${s.client_message}\n\n*How to verify:*\n${bullets(s.validation_steps, true)}\n\n` +
            `To accept the result, comment */approve*. To report a problem, comment */reject <reason>*.`);
        if (next === "ANALYSIS")
          return this.ext.comment(k, t + "Verification shows that a code change is required. Returning to analysis to choose a development lane.");
        return this.ext.comment(k, t + (next === "BLOCKED"
          ? "The issue persists and retries are exhausted. Human review is needed."
          : "The issue persists. Preparing a new proposal."));
      }
      case "DELIVERY":
        return this.ext.comment(k, `${s.client_message}\n\n*How to verify:*\n${bullets(s.validation_steps, true)}\n\n` +
          `To accept the result, comment */approve*. To report a problem, comment */reject <reason>*.`);
    }
  }

  // ================================================================ gates
  private async newHumanComments(item: WorkItem): Promise<Comment[]> {
    const cs = await this.ext.comments(item.key);
    const i = cs.findIndex((c) => c.id === item.lastSeenComment);
    if (cs.length) item.lastSeenComment = cs[cs.length - 1].id;
    return cs.slice(i + 1).filter((c) => !isBotComment(c.body));
  }

  private approvers(s: State): string[] {
    const a = this.cfg.approvers;
    return ({ CODE_REVIEW: a.code, ACCEPTANCE: a.client, EXECUTION_APPROVAL: a.execution ?? [], APPLICATION: a.execution ?? [], BLOCKED: [...(a.analysis ?? []), ...a.code] } as Record<string, string[]>)[s] ?? [];
  }

  /**
   * CODE_REVIEW with CODE_REVIEW_GATE=github: the senior decides with a review on the integration PR.
   * Only reviews submitted on the PR's current head count (a push after the review makes it stale, like GitHub's
   * "dismiss stale approvals"), each review is handled once, and with GITHUB_REVIEWERS set only those GitHub logins count.
   * Changes requested win over approvals. If GitHub cannot be read, the request keeps waiting (it is not blocked).
   */
  private async reviewCodeOnPr(item: WorkItem) {
    const url = item.artifacts.devel_pr as string | undefined;
    if (!url) return this.store.save(item);   // no PR yet: nothing to decide on (`/orqen:pr` opens it)
    if (!this.ws.prReviews) { console.error("[orqen] warning: this workspace cannot read PR reviews; use CODE_REVIEW_GATE=ticket"); return this.store.save(item); }
    let snap: { head: string; reviews: PrReview[] };
    try { snap = this.ws.prReviews(url); } catch (e) {
      console.error(`[orqen] warning: could not read the reviews of ${url}: ${(e as Error).message}`);
      return this.store.save(item);
    }
    const handled = new Set<string>(item.artifacts.handled_reviews ?? []);
    const authorized = this.cfg.githubReviewers;
    const latest = new Map<string, PrReview>();   // last decisive review per author, on the current head
    for (const r of snap.reviews) {
      if (!["APPROVED", "CHANGES_REQUESTED"].includes(r.state) || r.commit !== snap.head || handled.has(r.id)) continue;
      if (authorized.length && !authorized.includes(r.author)) continue;
      latest.set(r.author, r);
    }
    const decisive = [...latest.values()];
    const rejected = decisive.filter((r) => r.state === "CHANGES_REQUESTED");
    const approved = decisive.filter((r) => r.state === "APPROVED");
    if (!rejected.length && !approved.length) return this.store.save(item);

    const used = rejected.length ? rejected : approved;
    item.artifacts.handled_reviews = [...handled, ...used.map((r) => r.id)];
    if (rejected.length) {
      for (const r of rejected) item.feedback.push({ from: r.author, rejection: r.body.trim() || `Changes requested on the PR: ${url}` });
      item.testingAttempts = 0;
      await this.commentBoth(item, `Changes requested on the PR by ${rejected.map((r) => r.author).join(", ")}: ${url}\nReturning to development.`);
      return this.move(item, GATES.CODE_REVIEW.reject, `changes requested on the PR by ${rejected.map((r) => r.author).join(", ")}`);
    }
    await this.commentBoth(item, `PR approved by ${approved.map((r) => r.author).join(", ")}: ${url}\nMoving to delivery.`);
    return this.move(item, GATES.CODE_REVIEW.approve, `PR approved by ${approved.map((r) => r.author).join(", ")}`);
  }

  private async reviewGate(item: WorkItem & { state: keyof typeof GATES }) {
    const gate = GATES[item.state];
    if (item.state === "CODE_REVIEW" && this.cfg.codeReviewGate === "github") return this.reviewCodeOnPr(item);
    const fresh = await this.newHumanComments(item);
    if (gate.kind === "answer") {
      if (fresh.length) {
        item.feedback.push(...fresh.map((c) => ({ from: c.authorName, text: c.body })));
        return this.move(item, gate.approve, "client answered");
      }
      return this.store.save(item);
    }
    const authorized = this.approvers(item.state);
    for (const c of fresh) {
      const m = c.body.match(CMD);
      if (!m) { item.feedback.push({ from: c.authorName, text: c.body }); continue; }
      if (authorized.length && !authorized.includes(c.author)) {
        await this.ext.comment(item.key, `${c.authorName}: you are not authorized to use /${m[1]} at this stage.`);
        continue;
      }
      const action = m[1].toLowerCase() as "approve" | "reject", reason = m[2].trim();
      if (action === "reject") item.feedback.push({ from: c.authorName, rejection: reason });
      if (action === "approve" && reason && item.state === "APPLICATION")
        item.feedback.push({ from: c.authorName, text: reason });  // result of the application
      if (item.state === "CODE_REVIEW" && action === "reject") item.testingAttempts = 0;
      if (item.state === "EXECUTION_APPROVAL" && action === "approve")
        await this.ext.comment(item.key, "Operational change approved. Apply the proposal as written and comment */approve <result>* on success or */reject <reason>* on failure.");
      if (item.state === "ACCEPTANCE" && action === "reject") {
        // new round: the previous change is already archived → the analyst re-analyzes (new lane, change and internal ticket)
        item.round++; item.change = ""; item.questionRounds = 0; item.testingAttempts = 0; delete item.lane;
        delete item.artifacts.archive; delete item.artifacts.devel_pr; delete item.artifacts.internal_linked;
        if (item.internal) { (item.artifacts.previous_internal ??= []).push(item.internal); delete item.internal; }  // the new round gets its own internal ticket
      }
      return this.move(item, gate[action === "approve" ? "approve" : "reject"], `/${action} by ${c.authorName} ${reason}`.trim());
    }
    this.store.save(item);
  }

  private async reviewUnblock(item: WorkItem) {
    const authorized = this.approvers("BLOCKED");
    for (const c of await this.newHumanComments(item)) {
      const m = c.body.match(CMD);
      if (m && m[1].toLowerCase() === "approve" && (!authorized.length || authorized.includes(c.author))) {
        item.testingAttempts = 0; item.questionRounds = 0;
        if (m[2].trim()) item.feedback.push({ from: c.authorName, text: m[2].trim() });
        return this.move(item, item.stateBeforeBlock ?? "ANALYSIS", `unblocked by ${c.authorName}`);
      }
      item.feedback.push({ from: c.authorName, text: c.body });
    }
    this.store.save(item);
  }

  // ================================================================ internal ticket
  /**
   * When the analysis closes: creates the internal ticket (if there is an internal connector), links it to the external one
   * and notifies both. Idempotent and resumable: if it fails halfway (e.g. the link), retrying `complete` picks up where it left off.
   */
  private async createInternal(item: WorkItem) {
    const a = item.artifacts.ANALYSIS ?? {};
    const operational = item.route === "operational";
    const lane = operational ? "operational" : a.lane;
    if (!this.int) {
      if (!item.artifacts.internal_linked) {
        await this.ext.comment(item.key, `Analysis complete${item.analyst ? ` with ${item.analyst}` : ""} (${lane} lane). Milestones will be posted on this request.`);
        item.artifacts.internal_linked = true;
        this.store.save(item);
      }
      return;
    }
    if (!item.internal) {
      const issue = await this.ext.ticket(item.key);
      const tasks = operational ? [] : this.tasksOf(item);
      const sc = operational ? [] : this.scenariosOf(item);
      item.internal = await this.int.create({
        route: operational ? "operational" : "development",
        title: `[${item.key}] ${issue.title}`, labels: [`origin-${item.key.toLowerCase()}`, `lane-${lane}`],
        description: operational
          ? `Operational resolution for request ${item.key} (no code changes).\n${this.ext.url(item.key)}\n\n*Summary:* ${a.summary}\n*Rationale:* ${a.lane_rationale}\n\n` +
            `*Acceptance criteria:*\n${bullets(a.acceptance_criteria ?? [])}\n\nThe execution stage prepares the script, rollback, and verification and posts them on the request.`
          : `Development for request ${item.key}. *Lane:* ${a.lane} — ${a.lane_rationale}\n${this.ext.url(item.key)}\n\n` +
            `*Summary:* ${item.artifacts.ANALYSIS?.spec?.summary ?? a.summary}\n\n` +
            `*Branch:* ${item.branch || branchFor(item.key)}\n` + (item.change ? `*OpenSpec change:* openspec/changes/${item.change}/\n` : `*Direct-lane analysis:* orqen/work/${item.key}/round-${item.round}/analysis.md\n`) +
            `*Estimate:* ${item.artifacts.estimated_hours ?? "?"} h\n\n` +
            `*${item.change ? "Tasks" : "Plan"}:*\n${bullets(tasks.map((t) => t.description))}\n\n` +
            `*${item.change ? "Acceptance scenarios" : "Acceptance criteria"}:*\n${bullets(sc.map((e) => item.change ? `${e.requirement} › ${e.scenario}` : e.scenario))}`,
      });
      this.store.save(item);
    }
    if (!item.artifacts.internal_linked) {
      const native = canLinkNatively(this.int, this.ext) && this.int.link;
      if (native) await this.int.link!(item.internal, item.key);
      const where = native ? item.internal : `${item.internal} (${this.int.url(item.internal)})`;
      await this.ext.comment(item.key, `Analysis complete${item.analyst ? ` with ${item.analyst}` : ""}. Track implementation in ${where} (${lane} lane). Milestones will also be posted on this request.`);
      await this.int.comment(item.internal, `Created from ${item.key}${native ? "" : ` (${this.ext.url(item.key)})`} after analysis. Request record: orqen/work/${item.key}/.`);
      item.artifacts.internal_linked = true;
      this.store.save(item);
    }
  }

  /** Comments on the external ticket and, if it exists, mirrors on the internal one. */
  private async commentBoth(item: WorkItem, text: string) {
    await this.ext.comment(item.key, text);
    if (item.internal && this.int) await this.attemptAsync(() => this.int!.comment(item.internal!, text));
  }

  // ================================================================ utilities
  async block(key: string, reason: string, agent = "agent") {
    const item = this.store.get(key) ?? newWorkItem(key);
    if (item.state === "BLOCKED") return;
    await this.ext.comment(key, `Human intervention needed: ${reason}\nWhen resolved, comment /approve <instructions> to retry.`);
    await this.move(item, "BLOCKED", reason, agent);
  }

  release(key: string) {
    const item = this.store.get(key);
    if (item) { delete item.lock; this.store.save(item); }
  }

  private assertClaimable(item: WorkItem, agent: string) {
    const lock = this.activeLock(item);
    if (lock && lock.agent !== agent) throw new Error(`${item.key} was already taken by "${lock.agent}" since ${lock.since}.`);
  }

  private activeLock(item: WorkItem) {
    if (!item.lock) return undefined;
    const expired = Date.now() - Date.parse(item.lock.since) > this.cfg.lockMinutes * 60_000;
    return expired ? undefined : item.lock;
  }

  private async attemptAsync(fn: () => Promise<unknown>) {
    try { await fn(); } catch (e) { console.error(`[orqen] warning: ${(e as Error).message}`); }
  }

  private attempt<T>(fn: () => T): T | undefined {
    try { return fn(); } catch (e) { console.error(`[orqen] warning: ${(e as Error).message}`); return undefined; }
  }

  private async move(item: WorkItem, to: State, detail: string, agent?: string) {
    const from = item.state;
    if (to === "BLOCKED" && from !== "BLOCKED") item.stateBeforeBlock = from;
    item.state = to;
    delete item.lock;
    if (isGate(to) || to === "BLOCKED") {  // when entering a gate, ignore earlier comments
      const cs = await this.ext.comments(item.key);
      item.lastSeenComment = cs.at(-1)?.id ?? "";
    }
    this.store.save(item);
    this.store.log(item.key, { ts: new Date().toISOString(), from, to, detail, agent });
    this.fac.record(item, from, to, detail, agent);
    if (item.branch) this.attempt(() => this.ws.commit(item.key, `registro ${from} → ${to}`, { path: this.cfg.factoryDir, branch: item.branch }));
    try {
      await this.ext.setStateLabel(item.key, to);
      const t = this.cfg.connectors.external.transitions[to];
      if (t) await this.ext.transition(item.key, t);
      if (item.internal && this.int) {
        const ts = this.cfg.connectors.internal?.transitions[to];
        if (ts) await this.int.transition(item.internal, ts);
      }
    } catch (e) {
      console.error(`[orqen] could not update the state on ${this.ext.label}: ${(e as Error).message}`);
    }
  }
}

export function changeName(key: string, title: string, round: number) {
  const slug = title.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter((w) => w.length > 2).slice(0, 4).join("-");
  return [key.toLowerCase(), slug, round > 1 ? `r${round}` : ""].filter(Boolean).join("-");
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
const bullets = (xs: string[], numbered = false) => xs.map((x) => `${numbered ? "#" : "*"} ${x}`).join("\n") || "_(none)_";
