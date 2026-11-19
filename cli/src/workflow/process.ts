/**
 * Core of the request process. Used by the CLI (`orqen ...`) and the tests.
 *
 *  - review():   advances everything that does NOT need an agent (gates, unblocks) and lists the pending work.
 *  - analyze():  opens the analysis driven by an analyst (grilling) and returns the context.
 *  - lane():     records the chosen lane; for light/full it creates the branch + OpenSpec change.
 *  - take():     reserves a request at an agent stage, prepares branch/tests/OpenSpec and returns the context.
 *  - complete(): validates the output (schema + OpenSpec), publishes to the tickets/git/factory and moves the state.
 *                When closing ANALYSIS with the analyst's OK it creates the issue (if there is an issues system) and links it to the request.
 *
 * The request is what the client sees (requests system); the issue (optional) is the team's (issues system). Both are reached through connectors/.
 */
import { join, relative } from "node:path";
import { detectarIdioma } from "../lib/lang.ts";
import type { Config } from "./config.ts";
import { SCHEMAS } from "./schemas.ts";
import {
  LANES, type Lane, State, type AgentState, GATES, isAgentState, isFinal, isGate, nextStateAfterStage,
} from "./states.ts";
import { Factory } from "./factory.ts";
import { canLinkNatively, type Comment, type Connectors, isBotComment, LEGACY_STATE_LABELS, STATE_LABEL, type Tracker } from "../connectors/index.ts";
import { type Scenario, type OpenSpecApi, type Task, hoursOf } from "./openspec.ts";
import { reviewSql } from "./sql.ts";
import { type WorkItem, Store, newWorkItem } from "./store.ts";
import { needsQa, nextSteps, returned, roleOf, workKey, type NextStep, type Role } from "./board.ts";
import { branchFor, type EnvironmentResult, type PrChecks, type PrReview, type Workspace } from "./workspace.ts";

const CMD = /^\s*\/(approve|reject)\b\s*([\s\S]*)/i;
/** Verdicts of `orqen code-review` (code review report for the senior) and how they read on the ticket. */
export const VERDICTS = { approve: "Approvable", minor: "Approvable with minor changes", reject: "Reject" } as const;
const COMMENT_MAX = 30_000;   // Jira rejects comments over 32767 characters (GitHub: 65536)

/** `for` says who has to act: support (SUPPORT, or NEW with SUPPORT_STAGE=on), the analyst (NEW/ANALYSIS) or an unattended agent. */
export interface Pending { key: string; state: AgentState | "NEW"; for: "support" | "analyst" | "agent"; takenBy?: string }
/** One row of `orqen list`: who acts on the request and which command comes next. */
export interface BoardItem {
  key: string; title?: string; issue?: string; work: string; state: State; lane?: string; route?: string; role: Role;
  takenBy?: string; since?: string; returned?: string; estimated_hours?: number; pr?: string;
  qa?: "pending" | "approved"; next: NextStep[]; updated?: string;
  /** DELIVERY: whether a person already merged the PR into the development branch (orqen never merges it). */
  merge?: "pending" | "merged";
  review?: { status: "none" | "current" | "stale" | "unknown"; detail?: string };
  /** The state comes only from the ticket's label: this machine has no record of the request (see Process.item). */
  recovered?: "label";
  /** `orqen list prs`: CI of the PR and conflicts with the development branch ("unknown": gh could not read them). */
  checks?: { ci: PrChecks["ci"] | "unknown"; conflicts?: boolean; detail?: string };
}
export type CompleteResult = { ok: true; next: State } | { ok: false; errors: string[] };

export class Process {
  private fac: Factory;
  /** Where the client's ticket lives. */
  private requests: Tracker;
  /** Where the team's ticket is created (optional). */
  private issues?: Tracker;
  constructor(
    private cfg: Config, connectors: Connectors, private store: Store,
    private ws: Workspace, private os: OpenSpecApi,
  ) {
    this.fac = new Factory(cfg.factoryDir);
    this.requests = connectors.requests;
    this.issues = connectors.issues;
  }

  // ================================================================ the record of a request on this machine
  /**
   * The request as this machine knows it. The source of truth is orqen/state (ignored by git, one per machine); when it has no
   * record, the full snapshot that orqen commits with the request branch (orqen/worqs/<KEY>/state.json) is used and saved here.
   * The snapshot is read from the working tree or from a local or fetched branch: `git fetch origin orqen/<key>` is enough.
   */
  item(key: string): WorkItem | undefined {
    return this.store.get(key) ?? this.fromSnapshot(key);
  }

  private fromSnapshot(key: string): WorkItem | undefined {
    let found;
    try { found = this.ws.snapshotOf?.(key); } catch { return undefined; }
    const s = found?.snapshot as Record<string, any> | undefined;
    // the short projections of earlier versions have no artifacts: not enough to continue from
    if (!found || !s || typeof s !== "object" || typeof s.state !== "string" || !(s.state in State) || typeof s.artifacts !== "object" || !s.artifacts) return undefined;
    const { _note, updated, lock, recovered, ...rest } = s;
    this.store.save({ ...newWorkItem(key), ...rest, key } as WorkItem);
    this.store.log(key, { ts: new Date().toISOString(), from: s.state as State, to: s.state as State, detail: `record recovered from ${found.source}`, agent: "process" });
    return this.store.get(key);
  }

  /** `orqen status`: a request this machine has no record of, with the state its ticket's label says (read only), if any. */
  async peek(key: string): Promise<WorkItem | undefined> {
    const i = await this.known(key);
    return i.recovered ? i : undefined;
  }

  /** Requests whose state was read from the ticket's label (read only: nothing is advanced from a label). */
  private fromLabels = new Map<string, WorkItem>();

  /** Local record, else the repository snapshot, else (only to show it) the state label of the ticket, else a new request. */
  private async known(key: string): Promise<WorkItem> {
    const local = this.item(key) ?? this.fromLabels.get(key);
    if (local) return local;
    let ticket;
    try { ticket = await this.requests.ticket(key); } catch { return newWorkItem(key); }
    const prefix = [STATE_LABEL, ...LEGACY_STATE_LABELS].find((p) => ticket.labels.some((l) => l.startsWith(p)));
    const label = prefix ? ticket.labels.find((l) => l.startsWith(prefix))! : undefined;
    const state = label ? label.slice(prefix!.length).toUpperCase() : "";
    if (!(state in State) || state === "NEW") return newWorkItem(key);
    const item: WorkItem = { ...newWorkItem(key), state: state as State, title: ticket.title, recovered: "label" };
    this.fromLabels.set(key, item);
    return item;
  }

  /** The worq of a request, as `orqen worq` and `orqen worqs` show it: orqen's unit of work (request + issue + branch + PR + record). */
  worq(item: WorkItem) {
    const b = this.boardItem(item);
    return {
      key: item.key, title: item.title ?? (item.artifacts.ANALYSIS?.summary as string | undefined)?.slice(0, 90), issue: item.issue,
      state: item.state, role: b.role, lane: item.lane, route: item.route, round: item.round, branch: item.branch || undefined,
      pr: item.artifacts.devel_pr as string | undefined, merged: item.artifacts.devel_pr_merged ? true : undefined,
      analyst: item.analyst, supporter: item.supporter, request_url: this.requests.url(item.key),
      issue_url: item.issue && this.issues ? this.issues.url(item.issue) : undefined,
      dir: this.worqRel(item.key), updated: this.store.events(item.key).at(-1)?.ts, next: b.next,
    };
  }

  /** Folder of a worq inside the repository, as written in tickets and messages (orqen/worqs/<KEY>); the default when the folder is elsewhere. */
  worqRel(key: string): string {
    const rel = relative(this.cfg.repoPath, join(this.cfg.factoryDir, key)).replaceAll("\\", "/");
    return rel.startsWith("..") || /^[a-zA-Z]:/.test(rel) ? `orqen/worqs/${key}` : rel;
  }

  private fetchHint(key: string) {
    return `If someone worked on it elsewhere, fetch its branch (git fetch origin ${branchFor(key)}) so orqen can recover its worq from ${this.worqRel(key)}/state.json.`;
  }
  private unknownMsg(key: string) { return `${key} is unknown to orqen on this machine. ${this.fetchHint(key)}`; }

  // ================================================================ review
  async review(): Promise<Pending[]> {
    const pending: Pending[] = [];
    for (const key of await this.requests.pending()) {
      try {
        const item = await this.known(key);
        if (item.recovered) continue;   // state read from the ticket's label only: shown by `board`, never advanced
        if (isGate(item.state)) await this.reviewGate(item as WorkItem & { state: keyof typeof GATES });
        else if (item.state === "BLOCKED") await this.reviewUnblock(item);
        else if (item.state === "DELIVERY") await this.checkMerge(item);   // quiet: "unknown" just keeps waiting
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

  // ================================================================ board (`orqen list`)
  /**
   * Step 1 of the flow: advances what already has a decision (review()) and lists every open request with who has to act
   * (role) and the next command. It does not take anything. `closed` also includes the closed ones.
   */
  async board(closed = false): Promise<BoardItem[]> {
    const pend = await this.review();
    const keys = new Set([...pend.map((p) => p.key), ...this.store.all().map((r) => r.key), ...this.fromLabels.keys()]);
    const out: BoardItem[] = [];
    for (const key of keys) {
      const item = this.item(key) ?? this.fromLabels.get(key) ?? newWorkItem(key);
      if (isFinal(item.state) && !closed) continue;
      out.push(this.boardItem(item));
    }
    return out;
  }

  boardItem(item: WorkItem): BoardItem {
    const lock = this.activeLock(item);
    return {
      key: item.key, title: item.title ?? item.artifacts?.ANALYSIS?.summary, issue: item.issue, work: workKey(item), state: item.state, lane: item.lane, route: item.route,
      role: roleOf(item, this.cfg), takenBy: lock?.agent, since: lock?.since, returned: returned(item),
      estimated_hours: item.artifacts.estimated_hours, pr: item.artifacts.devel_pr,
      qa: needsQa(item) && item.state === "QA_REVIEW" ? "pending" : needsQa(item) && item.state === "CODE_REVIEW" ? "approved" : undefined,
      recovered: item.recovered,
      next: item.recovered
        ? [{ step: 0, role: roleOf(item, this.cfg), command: `git fetch origin ${branchFor(item.key)}`, what: "The state comes from the ticket only: fetch the request branch so orqen recovers its full record, then continue" }]
        : nextSteps(item, this.cfg),
      updated: this.store.events(item.key).at(-1)?.ts,
      merge: item.state === "DELIVERY" && item.artifacts.devel_pr ? (item.artifacts.devel_pr_merged ? "merged" : "pending") : undefined,
    };
  }

  /**
   * Step 8: requests waiting for code review, with whether the senior's review on the PR is on the last commit,
   * and approved PRs still waiting for a person to merge them (DELIVERY, merge pending).
   */
  async prQueue(): Promise<BoardItem[]> {
    const items = (await this.board()).filter((b) => b.pr && (b.state === "CODE_REVIEW" || b.merge === "pending"));
    for (const b of items) {
      b.checks = this.prHealth(b.pr!);
      if (b.state === "DELIVERY") { b.review = { status: "current", detail: "approved: waiting for the merge" }; continue; }
      if (this.cfg.codeReviewGate !== "github" || !this.ws.prReviews) { b.review = { status: "none" }; continue; }
      try {
        const snap = this.ws.prReviews(b.pr!);
        const decisive = snap.reviews.filter((r) => ["APPROVED", "CHANGES_REQUESTED"].includes(r.state));
        const current = decisive.filter((r) => r.commit === snap.head);
        b.review = current.length ? { status: "current", detail: current.map((r) => `${r.author}: ${r.state.toLowerCase()}`).join(", ") }
          : decisive.length ? { status: "stale", detail: "a push after the last review: it has to be reviewed again" }
          : { status: "none" };
      } catch (e) { b.review = { status: "unknown", detail: (e as Error).message }; }
    }
    return items;
  }

  // ================================================================ senior's decision
  /**
   * Step 9: the senior approves the PR or requests changes. With CODE_REVIEW_GATE=github the review goes on the PR with their
   * gh session and the gate reads it (it only counts on the last commit); with the ticket gate orqen records it directly.
   * approve → DELIVERY; changes → back to development with the comment as an indication.
   */
  async decide(key: string, action: "approve" | "changes", body: string, person = "senior", agent = "agent", force = false) {
    const item = this.item(key);
    if (!item) throw new Error(this.unknownMsg(key));
    if (item.state !== "CODE_REVIEW") throw new Error(`${key} is in ${item.state}: the senior decides in CODE_REVIEW.`);
    const url = item.artifacts.devel_pr as string | undefined;
    if (!url) throw new Error(`${key} has no PR yet: it is opened with /orqen:pr ${workKey(item)}.`);
    if (action === "changes" && body.trim().length < 10) throw new Error("Say which changes are needed: the comment goes back to development as the indication.");
    if (action === "approve") {
      // a red or conflicting PR is not approved (unknown, e.g. no gh, does not block)
      const h = this.prHealth(url);
      const problem = h.conflicts ? `it has conflicts with ${this.cfg.develBranch}`
        : h.ci === "failing" ? `its CI is failing${h.detail ? ` (${h.detail})` : ""}`
        : h.ci === "pending" ? `its CI is still running${h.detail ? ` (${h.detail})` : ""}` : "";
      if (problem && !force)
        throw new Error(`The PR ${url} cannot be approved yet: ${problem}. ` + (h.conflicts
          ? `Request changes so development brings the branch up to date with ${this.cfg.develBranch} (orqen approve ${workKey(item)} --changes).`
          : h.ci === "pending" ? "Wait for it to finish and approve again." : "Request changes with what failed, or fix the CI first.")
          + " Use --force only if you know why it can be approved anyway.");
      if (problem) body = `${body.trim()}${body.trim() ? "\n\n" : ""}Approved with --force although ${problem}.`;
    }
    if (this.cfg.codeReviewGate === "github") {
      if (!this.ws.reviewPr) throw new Error("This workspace cannot review PRs; use CODE_REVIEW_GATE=ticket.");
      this.ws.reviewPr(url, action === "approve" ? "approve" : "request-changes", body.trim() || `Approved by ${person} with orqen.`);
      await this.reviewCodeOnPr(item);
      const after = this.item(key)!;
      if (after.state === "CODE_REVIEW")
        throw new Error(`The review was posted on ${url} but did not count${this.cfg.githubReviewers.length ? ` (GITHUB_REVIEWERS: ${this.cfg.githubReviewers.join(", ")})` : ""}. Check it on GitHub.`);
      return { state: after.state, url };
    }
    if (action === "approve") {
      await this.commentBoth(item, `Code review: PR approved by ${person}: ${url}${body.trim() ? `\n\n${body.trim()}` : ""}\nMoving to delivery.`);
      await this.move(item, "DELIVERY", `PR approved by ${person}`, agent);
    } else {
      item.feedback.push({ from: person, rejection: body.trim() });
      item.testingAttempts = 0;
      await this.commentBoth(item, `Code review: changes requested by ${person} on ${url}\n\n${body.trim()}\n\nReturning to development.`);
      await this.move(item, "DEVELOPMENT", `changes requested by ${person}`, agent);
    }
    return { state: item.state, url };
  }

  // ================================================================ support
  /**
   * Opens (or resumes) the first-line handling of a request (available even with SUPPORT_STAGE=off: that variable only decides whether new requests are routed here). The support person drives it; the agent helps them
   * find an answer. The stage ends resolved (the client confirms in ACCEPTANCE) or escalated to the analyst.
   */
  async support(key: string, agent = "agent", person = agent) {
    const item = this.item(key) ?? newWorkItem(key);
    if (item.state !== "NEW" && item.state !== "SUPPORT")
      throw new Error(`${key} is not waiting for support (state: ${item.state}).${item.state === "ANALYSIS" ? " It was escalated to the analyst: use `orqen analyze`." : ""}`);
    this.assertClaimable(item, agent);
    if (item.state === "NEW") {
      item.supporter = person;
      await this.requests.comment(key, `${person} (support) is handling this request.`);
      await this.move(item, "SUPPORT", "taken by support", agent);
    }
    item.supporter = person;
    this.store.save(item);
    return this.take(key, agent, true);
  }

  // ================================================================ analyze
  /** Opens (or resumes) the analysis of a request. An analyst drives it; the agent does the grilling with them. */
  async analyze(key: string, agent = "agent", analyst = agent) {
    const item = this.item(key) ?? newWorkItem(key);
    if (item.state === "WAITING_CLIENT")
      throw new Error(`${key} is waiting for client answers on the ticket. When they reply it goes back to ANALYSIS (\`orqen list requests\`).`);
    if (item.state !== "NEW" && item.state !== "SUPPORT" && item.state !== "ANALYSIS")
      throw new Error(`${key} already went through the analysis (state: ${item.state}). If it must be redone, a rejection or an escalation sends it back to ANALYSIS.`);
    this.assertClaimable(item, agent);
    if (item.state === "NEW" || item.state === "SUPPORT") {
      const from = item.state;
      item.analyst = analyst;
      await this.requests.comment(key, `${analyst} started analyzing this request.`);
      await this.move(item, "ANALYSIS", from === "SUPPORT" ? "taken by the analyst before support finished" : "registered by analyst", agent);
    }
    item.analyst = analyst;
    this.store.save(item);
    return this.take(key, agent, true);
  }

  /** Records the lane. Light/full: prepares branch + OpenSpec change so the agent writes the spec. */
  async lane(key: string, lane: string, agent = "agent") {
    const item = this.item(key);
    if (!item) throw new Error(this.unknownMsg(key));
    if (item.state !== "ANALYSIS") throw new Error(`${key} is not in ANALYSIS (state: ${item.state}).`);
    const lock = this.activeLock(item) ?? (item.lock?.agent === agent ? item.lock : undefined);
    if (!lock || lock.agent !== agent) throw new Error(`Run \`orqen analyze ${key}\` first`);
    if (!LANES.includes(lane as Lane)) throw new Error(`Invalid lane "${lane}". Options: ${LANES.join(", ")}`);
    item.lane = lane as Lane;
    if (item.lane === "direct") {
      this.store.save(item);
      return { lane: item.lane, openspec: undefined as undefined | { change: string; dir: string }, branch: undefined as string | undefined };
    }
    const ticket = await this.requests.ticket(key);
    item.branch = this.ws.prepareBranch(key);
    if (!item.change || !this.os.exists(item.change)) {
      item.change = changeName(key, ticket.title, item.round);
      this.os.newChange(item.change, `${key}: ${ticket.title}`);
    }
    this.store.save(item);
    return { lane: item.lane, branch: item.branch, openspec: { change: item.change, dir: `openspec/changes/${item.change}` } };
  }

  // ================================================================ take
  async take(key: string, agent = "agent", fromAnalyze = false) {
    const item = this.item(key);
    if (!item) throw new Error(`${key} has no work for an agent (state: unknown). Run \`orqen list requests\`. ${this.fetchHint(key)}`);
    if (!isAgentState(item.state))
      throw new Error(`${key} has no work for an agent (state: ${item.state}). Run \`orqen list requests\`.`);
    if (item.state === "ANALYSIS" && !fromAnalyze)
      throw new Error(`The analysis of ${key} is driven by an analyst: use /orqen:analyze ${key} (or \`orqen analyze ${key}\`).`);
    if (item.state === "SUPPORT" && !fromAnalyze)
      throw new Error(`Support for ${key} is driven by a person: use /orqen:support ${key} (or \`orqen support ${key}\`).`);
    this.assertClaimable(item, agent);
    item.lock = { agent, since: new Date().toISOString() };
    this.store.save(item);

    const ticket = await this.requests.ticket(key);
    if (ticket.title && item.title !== ticket.title) { item.title = ticket.title; this.store.save(item); }
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
    // The PR is merged by a person (orqen never merges it); the delivery to the client waits for it. The archive commit
    // above is already on the branch, so it goes in with the merge.
    if (state === "DELIVERY") {
      const m = await this.checkMerge(item).catch((e) => { delete item.lock; this.store.save(item); throw e; });
      if (m.status !== "merged") {
        delete item.lock;
        this.store.save(item);
        const how = `Merge it by hand into ${this.cfg.develBranch}${item.artifacts.archive ? " (it already includes the OpenSpec archive)" : ""}`;
        throw new Error(m.status === "open"
          ? `The PR of ${key} is approved but not merged yet: ${item.artifacts.devel_pr}\n${how}; orqen detects it, then run this again to deliver to the client.`
          : `orqen could not read whether the PR of ${key} is merged (${m.detail}): ${item.artifacts.devel_pr}\n${how}, confirm it with \`orqen merged ${key}\` and run this again.`);
      }
    }

    const comments = (await this.requests.comments(key)).map((c) => ({
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
        supporter: item.supporter, analyst: item.analyst, lane: item.lane, worq: `${this.worqRel(key)}/round-${item.round}`, factory: `${this.worqRel(key)}/round-${item.round}`,   // factory: old name of worq
        request: ticket, issue: item.issue, comments, environment,
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
    const item = this.item(key);
    if (!item) throw new Error(this.unknownMsg(key));
    if (item.route === "operational") throw new Error(`${key} is operational (no code): there is no branch to send.`);
    if (!item.branch || !["TESTING", "QA_REVIEW", "CODE_REVIEW", "DELIVERY", "ACCEPTANCE", "CLOSED"].includes(item.state))
      throw new Error(`${key} is in ${item.state}: the PR to ${this.cfg.develBranch} is opened once development is done (TESTING or later).`);
    return {
      key, state: item.state, branch: item.branch, base: this.cfg.develBranch, lane: item.lane, issue: item.issue,
      analysis: `${this.worqRel(key)}/round-${item.round}/analysis.md`,
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
    const item = this.item(key)!;
    if (body.trim().length < 80) throw new Error("The explanation is too short: describe what changed, why and how to verify it.");
    // fail before writing anything: otherwise devel-pr.md and the pending changes would stay out of the pushed branch
    const current = this.ws.currentBranch();
    if (current !== item.branch)
      throw new Error(`The repo is on "${current}", not on the request branch "${item.branch}": switch to it (git checkout ${item.branch}) and run again.`);
    const bodyFile = `${this.worqRel(key)}/round-${item.round}/devel-pr.md`;
    this.fac.write(item, "devel-pr.md", body.trim() + "\n");
    this.ws.commit(key, `PR explanation for ${info.base}`, { branch: item.branch });
    this.ws.push(item.branch);
    if (info.existing) return { url: info.existing, created: false, base: info.base };
    const ticket = await this.requests.ticket(key);
    const out = this.ws.openPr({
      key, branch: item.branch, base: info.base, body: bodyFile, change: item.change,
      title: (title ?? item.artifacts.ANALYSIS?.summary ?? ticket.title).slice(0, 80),
    }, this.cfg.develPrCommand);
    const url = out.match(/(?:https?|file):\/\/\S+/)?.[0];
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
   * round-N/code-review-<n>.md, comments it on the issue (or the request) and logs it. With CODE_REVIEW_GATE=ticket the senior still gives /approve or /reject on the ticket.
   */
  async codeReview(key: string, body: string, verdict: string, agent = "agent") {
    const item = this.item(key);
    if (!item) throw new Error(this.unknownMsg(key));
    if (item.route === "operational") throw new Error(`${key} is operational (no code): there is nothing to review.`);
    if (item.state !== "CODE_REVIEW") throw new Error(`${key} is in ${item.state}: the code review is recorded in CODE_REVIEW.`);
    if (!item.artifacts.devel_pr) throw new Error(`${key} has no PR to ${this.cfg.develBranch} yet: open it first with \`orqen pr ${key} <explanation.md>\`.`);
    if (!(verdict in VERDICTS)) throw new Error(`Invalid verdict "${verdict}". Options: ${Object.keys(VERDICTS).join(", ")}`);
    if (body.trim().length < 80) throw new Error("The report is too short: include the verdict, the findings and their possible solutions.");

    const reviews: { round: number; n: number; verdict: string; file: string; ts: string }[] = (item.artifacts.code_reviews ??= []);
    const n = reviews.filter((r) => r.round === item.round).length + 1;
    const file = `code-review-${n}.md`;
    const path = `${this.worqRel(key)}/round-${item.round}/${file}`;
    this.fac.write(item, file, body.trim() + "\n");
    reviews.push({ round: item.round, n, verdict, file: path, ts: new Date().toISOString() });
    this.store.save(item);
    // only commits the report, and only on the request branch (no push: it travels with the next push of the branch)
    const committed = this.ws.commit(key, `code review #${n}`, { branch: item.branch, path: join(this.cfg.factoryDir, key) });

    const label = VERDICTS[verdict as keyof typeof VERDICTS];
    const text = `*Code review #${n}* (round ${item.round}) — verdict: *${label}*\nPR: ${item.artifacts.devel_pr}\n\n${body.trim()}`;
    // the report is already saved: a connector failure must not abort (retrying would duplicate it as #n+1)
    const onIssue = !!(item.issue && this.issues);
    let commentedOn: string | undefined = onIssue ? item.issue : key;
    try {
      await (onIssue ? this.issues! : this.requests).comment(commentedOn!, text.length > COMMENT_MAX ? text.slice(0, COMMENT_MAX) + `\n\n… (truncated; full report in \`${path}\`)` : text);
    } catch (e) {
      console.error(`[orqen] warning: could not comment the code review on ${commentedOn}: ${(e as Error).message}`);
      commentedOn = undefined;
    }
    this.store.log(key, { ts: new Date().toISOString(), from: item.state, to: item.state, detail: `code review #${n}: ${verdict}`, agent });
    return { n, path, verdict, committed, commentedOn };
  }

  // ================================================================ QA review
  /**
   * QA decision in QA_REVIEW (full lane only): approve sends the request to the senior (CODE_REVIEW); reject sends it back to
   * DEVELOPMENT with the reason as feedback. The optional report is saved as round-N/qa-review-<n>.md and committed by the move.
   * QA can also decide with /approve or /reject on the request (APPROVERS_QA).
   */
  async qaReview(key: string, decision: string, reason = "", report = "", by = "qa") {
    const item = this.item(key);
    if (!item) throw new Error(this.unknownMsg(key));
    if (item.state !== "QA_REVIEW")
      throw new Error(`${key} is not waiting for QA (state: ${item.state}). Only full-lane requests go through QA, after TESTING.`);
    if (decision !== "approve" && decision !== "reject") throw new Error(`Invalid decision "${decision}". Options: approve, reject`);
    if (decision === "reject" && reason.trim().length < 10)
      throw new Error('Say what development must fix: --reason "<text>" (10 characters or more).');
    const reviews: { round: number; n: number; decision: string; by: string; file?: string; ts: string }[] = (item.artifacts.qa_reviews ??= []);
    const n = reviews.filter((r) => r.round === item.round).length + 1;
    let path: string | undefined;
    if (report.trim()) {
      path = `${this.worqRel(key)}/round-${item.round}/qa-review-${n}.md`;
      this.fac.write(item, `qa-review-${n}.md`, report.trim() + "\n");
    }
    reviews.push({ round: item.round, n, decision, by, file: path, ts: new Date().toISOString() });
    const pr = item.artifacts.devel_pr ? ` (${item.artifacts.devel_pr})` : "";
    let text = decision === "approve"
      ? `*QA review #${n}*: approved by ${by}. Next: the senior reviews the PR${pr}.`
      : `*QA review #${n}*: changes requested by ${by}.\n${reason.trim()}\n\nReturning to development.`;
    if (report.trim()) text += `\n\n${report.trim()}`;
    if (text.length > COMMENT_MAX) text = text.slice(0, COMMENT_MAX) + `\n\n… (truncated; full report in \`${path}\`)`;
    // the decision is what matters: a failed comment must not leave the request half moved
    await this.attemptAsync(() => this.commentBoth(item, text));
    if (decision === "reject") {
      item.feedback.push({ from: by, rejection: reason.trim() });
      item.testingAttempts = 0;
      await this.move(item, GATES.QA_REVIEW.reject, `QA requested changes (${by})`, by);
    } else await this.move(item, GATES.QA_REVIEW.approve, `QA approved (${by})`, by);
    return { n, path, next: item.state };
  }

  // ================================================================ complete
  async complete(key: string, raw: unknown, agent = "agent"): Promise<CompleteResult> {
    const item = this.item(key);
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
    if (state === "VERIFICATION" && next === "ANALYSIS") {  // escalation: the new analysis creates a development issue
      item.route = "development"; delete item.lane; delete item.artifacts.issue_linked;
      if (item.issue) { (item.artifacts.previous_issues ??= []).push(item.issue); delete item.issue; }
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
  /** With the analyst's OK: estimate, record in orqen/worqs/, spec commit (if any) and issue linked to the request. */
  private async closeAnalysis(item: WorkItem, s: Record<string, any>) {
    item.artifacts.estimated_hours = item.change
      ? this.os.tasks(item.change).reduce((a, t) => a + (t.hours ?? 0), 0)
      : s.estimated_hours;
    await this.createIssue(item);
    this.recordAnalysis(item, s);
    if (item.change) this.ws.commit(item.key, `spec OpenSpec ${item.change}`);
  }

  private recordAnalysis(item: WorkItem, s: Record<string, any>) {
    const md = (t: string, xs: string[]) => xs.length ? `## ${t}\n\n${xs.map((x) => `- ${x}`).join("\n")}\n\n` : "";
    this.fac.write(item, "analysis.json", JSON.stringify(s, null, 2) + "\n");
    this.fac.write(item, "analysis.md",
      `# ${item.key} — analysis (round ${item.round})\n\n` +
      `- **Analyst:** ${item.analyst ?? "?"}\n- **Route:** ${s.route}\n- **Lane:** ${s.lane}\n- **Lane rationale:** ${s.lane_rationale}\n` +
      `- **Issue:** ${item.issue ?? "—"}\n` + (item.change ? `- **OpenSpec change:** openspec/changes/${item.change}/\n` : "") +
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
          return this.requests.comment(k, `${s.client_response.trim()}\n\n_Answered by support${item.supporter ? ` (${item.supporter})` : ""}._\n` +
            `To confirm the request is solved, comment */approve*. To report that it is not, comment */reject <reason>*.`);
        return this.requests.comment(k, (s.client_response.trim() ? `${s.client_response.trim()}\n\n` : "") +
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
          if (item.issue) t += `\n*Issue:* ${item.issue}`;
        }
        if (next === "WAITING_CLIENT") t += `\n\n*Please confirm the following so we can specify the request:*\n${bullets(s.open_questions, true)}`;
        if (next === "BLOCKED") t += "\n\nThe question limit has been reached. Human review is needed.";
        return this.requests.comment(k, t);
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
          const decide = next === "QA_REVIEW"
            ? "QA review (full lane): QA reviews the e2e of the change with /orqen:review and approves or requests changes. Then the senior reviews the PR."
            : this.cfg.codeReviewGate === "github"
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
          return this.requests.comment(k, t + "Verification shows that a code change is required. Returning to analysis to choose a development lane.");
        return this.requests.comment(k, t + (next === "BLOCKED"
          ? "The issue persists and retries are exhausted. Human review is needed."
          : "The issue persists. Preparing a new proposal."));
      }
      case "DELIVERY":
        return this.requests.comment(k, `${s.client_message}\n\n*How to verify:*\n${bullets(s.validation_steps, true)}\n\n` +
          `To accept the result, comment */approve*. To report a problem, comment */reject <reason>*.`);
    }
  }

  // ================================================================ gates
  private async newHumanComments(item: WorkItem): Promise<Comment[]> {
    const cs = await this.requests.comments(item.key);
    const i = cs.findIndex((c) => c.id === item.lastSeenComment);
    if (cs.length) item.lastSeenComment = cs[cs.length - 1].id;
    return cs.slice(i + 1).filter((c) => !isBotComment(c.body));
  }

  private approvers(s: State): string[] {
    const a = this.cfg.approvers;
    return ({ QA_REVIEW: a.qa ?? [], CODE_REVIEW: a.code, ACCEPTANCE: a.client, EXECUTION_APPROVAL: a.execution ?? [], APPLICATION: a.execution ?? [], BLOCKED: [...(a.analysis ?? []), ...a.code] } as Record<string, string[]>)[s] ?? [];
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
        await this.requests.comment(item.key, `${c.authorName}: you are not authorized to use /${m[1]} at this stage.`);
        continue;
      }
      const action = m[1].toLowerCase() as "approve" | "reject", reason = m[2].trim();
      if (action === "reject") item.feedback.push({ from: c.authorName, rejection: reason });
      if (action === "approve" && reason && item.state === "APPLICATION")
        item.feedback.push({ from: c.authorName, text: reason });  // result of the application
      if ((item.state === "CODE_REVIEW" || item.state === "QA_REVIEW") && action === "reject") item.testingAttempts = 0;
      if (item.state === "EXECUTION_APPROVAL" && action === "approve")
        await this.requests.comment(item.key, "Operational change approved. Apply the proposal as written and comment */approve <result>* on success or */reject <reason>* on failure.");
      if (item.state === "ACCEPTANCE" && action === "reject") {
        // new round: the previous change is already archived → the analyst re-analyzes (new lane, change and issue)
        item.round++; item.change = ""; item.questionRounds = 0; item.testingAttempts = 0; delete item.lane;
        delete item.artifacts.archive; delete item.artifacts.devel_pr; delete item.artifacts.devel_pr_merged; delete item.artifacts.issue_linked;
        if (item.issue) { (item.artifacts.previous_issues ??= []).push(item.issue); delete item.issue; }  // the new round gets its own issue
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

  // ================================================================ issue
  /**
   * When the analysis closes: creates the issue (if there is an issues system), links it to the request
   * and notifies both. Idempotent and resumable: if it fails halfway (e.g. the link), retrying `complete` picks up where it left off.
   */
  private async createIssue(item: WorkItem) {
    const a = item.artifacts.ANALYSIS ?? {};
    const operational = item.route === "operational";
    const lane = operational ? "operational" : a.lane;
    if (!this.issues) {
      if (!item.artifacts.issue_linked) {
        await this.requests.comment(item.key, `Analysis complete${item.analyst ? ` with ${item.analyst}` : ""} (${lane} lane). Milestones will be posted on this request.`);
        item.artifacts.issue_linked = true;
        this.store.save(item);
      }
      return;
    }
    if (!item.issue) {
      const ticket = await this.requests.ticket(item.key);
      const tasks = operational ? [] : this.tasksOf(item);
      const sc = operational ? [] : this.scenariosOf(item);
      item.issue = await this.issues.create({
        route: operational ? "operational" : "development",
        title: `[${item.key}] ${ticket.title}`, labels: [`origin-${item.key.toLowerCase()}`, `lane-${lane}`],
        description: operational
          ? `Operational resolution for request ${item.key} (no code changes).\n${this.requests.url(item.key)}\n\n*Summary:* ${a.summary}\n*Rationale:* ${a.lane_rationale}\n\n` +
            `*Acceptance criteria:*\n${bullets(a.acceptance_criteria ?? [])}\n\nThe execution stage prepares the script, rollback, and verification and posts them on the request.`
          : `Development for request ${item.key}. *Lane:* ${a.lane} — ${a.lane_rationale}\n${this.requests.url(item.key)}\n\n` +
            `*Summary:* ${item.artifacts.ANALYSIS?.spec?.summary ?? a.summary}\n\n` +
            `*Branch:* ${item.branch || branchFor(item.key)}\n` + (item.change ? `*OpenSpec change:* openspec/changes/${item.change}/\n` : `*Direct-lane analysis:* ${this.worqRel(item.key)}/round-${item.round}/analysis.md\n`) +
            `*Estimate:* ${item.artifacts.estimated_hours ?? "?"} h\n\n` +
            `*${item.change ? "Tasks" : "Plan"}:*\n${bullets(tasks.map((t) => t.description))}\n\n` +
            `*${item.change ? "Acceptance scenarios" : "Acceptance criteria"}:*\n${bullets(sc.map((e) => item.change ? `${e.requirement} › ${e.scenario}` : e.scenario))}`,
      });
      this.store.save(item);
    }
    if (!item.artifacts.issue_linked) {
      const native = canLinkNatively(this.issues, this.requests) && this.issues.link;
      if (native) await this.issues.link!(item.issue, item.key);
      const where = native ? item.issue : `${item.issue} (${this.issues.url(item.issue)})`;
      await this.requests.comment(item.key, `Analysis complete${item.analyst ? ` with ${item.analyst}` : ""}. Track implementation in ${where} (${lane} lane). Milestones will also be posted on this request.`);
      await this.issues.comment(item.issue, `Created from ${item.key}${native ? "" : ` (${this.requests.url(item.key)})`} after analysis. Worq: ${this.worqRel(item.key)}/`);
      item.artifacts.issue_linked = true;
      this.store.save(item);
    }
  }

  /** Comments on the request and, if it exists, mirrors on the issue. */
  private async commentBoth(item: WorkItem, text: string) {
    await this.requests.comment(item.key, text);
    if (item.issue && this.issues) await this.attemptAsync(() => this.issues!.comment(item.issue!, text));
  }

  // ================================================================ merge (by a person)
  /**
   * DELIVERY: reads whether the integration PR was merged. orqen never merges it; a person does it by hand and orqen records it
   * (devel_pr_merged) and comments it once. No PR, or a workspace that cannot read PRs: nothing to wait for. A PR closed
   * without merging is an error (it needs a person: reopen and merge it, or block the request).
   */
  private async checkMerge(item: WorkItem): Promise<{ status: "merged" | "open" | "unknown"; detail?: string }> {
    const url = item.artifacts.devel_pr as string | undefined;
    if (!url || item.artifacts.devel_pr_merged) return { status: "merged" };
    if (!this.ws.prState) return { status: "unknown", detail: "this workspace cannot read PRs" };
    let pr;
    try { pr = this.ws.prState(url); } catch (e) {
      // no gh, not logged in, or a PR outside GitHub (DEVEL_PR_COMMAND): a person confirms it with `orqen merged`
      return { status: "unknown", detail: ((e as Error).message.split("\n")[0] || "gh failed").slice(0, 200) };
    }
    if (pr.state === "CLOSED") throw new Error(`The PR ${url} was closed without merging: reopen and merge it, or block the request.`);
    if (pr.state !== "MERGED") return { status: "open" };
    await this.recordMerge(item, pr.mergedBy, pr.mergedAt);
    return { status: "merged" };
  }

  /** `orqen merged <KEY>`: a person confirms they merged the PR by hand (when orqen cannot read it from GitHub). */
  async confirmMerge(key: string, person: string) {
    const item = this.item(key);
    if (!item) throw new Error(this.unknownMsg(key));
    if (item.state !== "DELIVERY") throw new Error(`${key} is in ${item.state}: the merge is confirmed in DELIVERY, after the senior approves the PR.`);
    if (!item.artifacts.devel_pr) throw new Error(`${key} has no PR: there is nothing to merge.`);
    if (item.artifacts.devel_pr_merged) return item.artifacts.devel_pr_merged as { at: string; by?: string };
    await this.recordMerge(item, person, undefined, true);
    return item.artifacts.devel_pr_merged as { at: string; by?: string };
  }

  private async recordMerge(item: WorkItem, by: string | undefined, at = new Date().toISOString(), confirmed = false) {
    const url = item.artifacts.devel_pr as string;
    item.artifacts.devel_pr_merged = { at, by, ...(confirmed ? { confirmed_by_hand: true } : {}) };
    this.store.save(item);
    const what = `PR merged into ${this.cfg.develBranch}${by ? ` by ${by}` : ""}${confirmed ? " (confirmed by hand)" : ""}`;
    this.store.log(item.key, { ts: new Date().toISOString(), from: item.state, to: item.state, detail: what, agent: "process" });
    await this.attemptAsync(() => this.commentBoth(item, `${what}: ${url}`));
  }

  /** CI and conflicts of a PR. "unknown" (no gh, a PR outside GitHub…) never blocks: it is only shown. */
  private prHealth(url: string): NonNullable<BoardItem["checks"]> {
    if (!this.ws.prChecks) return { ci: "unknown", detail: "this workspace cannot read PRs" };
    try {
      const c = this.ws.prChecks(url);
      const names = c.failing.length ? c.failing : c.pending;
      return { ci: c.ci, conflicts: c.conflicts, ...(names.length ? { detail: names.slice(0, 5).join(", ") } : {}) };
    } catch (e) {
      return { ci: "unknown", detail: ((e as Error).message.split("\n")[0] || "gh failed").slice(0, 200) };
    }
  }

  // ================================================================ cancel
  /**
   * `orqen cancel <KEY>`: closes the request without delivering it (the client withdrew it, a duplicate, it no longer applies).
   * Closes the open PR without merging it (the branch stays), comments both tickets and moves to CANCELLED, which is final.
   * A PR already merged stays in the development branch: the comment says so, reverting it is a person's call.
   */
  async cancel(key: string, reason: string, person: string, agent = "agent") {
    let item = this.item(key);
    if (!item) { await this.requests.ticket(key); item = newWorkItem(key); }   // a request orqen has not touched yet: it must exist
    if (isFinal(item.state)) throw new Error(`${key} is already ${item.state}.`);
    if (reason.trim().length < 5) throw new Error("Say why it is cancelled (--reason): it goes on the request and the issue.");
    const url = item.artifacts.devel_pr as string | undefined;
    let pr: "closed" | "merged" | "open" | undefined;
    if (url) {
      const merged = !!item.artifacts.devel_pr_merged || this.attempt(() => this.ws.prState?.(url).state) === "MERGED";
      if (merged) pr = "merged";
      else if (this.ws.closePr && this.attempt(() => { this.ws.closePr!(url, `[orqen] ${key} was cancelled by ${person}: ${reason.trim()}`); return true; })) pr = "closed";
      else pr = "open";
    }
    item.artifacts.cancelled = { at: new Date().toISOString(), by: person, reason: reason.trim(), from: item.state, ...(pr ? { pr } : {}) };
    const note = pr === "merged" ? `\nThe PR was already merged into ${this.cfg.develBranch} (${url}): that code stays there; revert it by hand if needed.`
      : pr === "closed" ? `\nThe PR was closed without merging: ${url}`
      : pr === "open" ? `\nThe PR could not be closed automatically: close it by hand: ${url}` : "";
    await this.commentBoth(item, `Request cancelled by ${person}: ${reason.trim()}${note}`);
    await this.move(item, "CANCELLED", `cancelled by ${person}: ${reason.trim()}`, agent);
    return { state: item.state, pr, url };
  }

  // ================================================================ utilities
  async block(key: string, reason: string, agent = "agent") {
    const item = this.item(key) ?? newWorkItem(key);
    if (item.state === "BLOCKED") return;
    await this.requests.comment(key, `Human intervention needed: ${reason}\nWhen resolved, comment /approve <instructions> to retry.`);
    await this.move(item, "BLOCKED", reason, agent);
  }

  release(key: string) {
    const item = this.item(key);
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
      const cs = await this.requests.comments(item.key);
      item.lastSeenComment = cs.at(-1)?.id ?? "";
    }
    this.store.save(item);
    this.store.log(item.key, { ts: new Date().toISOString(), from, to, detail, agent });
    this.fac.record(item, from, to, detail, agent);
    if (item.branch) this.attempt(() => this.ws.commit(item.key, `registro ${from} → ${to}`, { path: this.cfg.factoryDir, branch: item.branch }));
    try {
      await this.requests.setStateLabel(item.key, to);
      // CANCELLED falls back to the CLOSED destination when the connector has no own "CANCELLED" transition
      const dest = (ts?: Record<string, string>) => ts?.[to] ?? (to === "CANCELLED" ? ts?.CLOSED : undefined);
      const t = dest(this.cfg.connectors.requests.transitions);
      if (t) await this.requests.transition(item.key, t);
      if (item.issue && this.issues) {
        const ts = dest(this.cfg.connectors.issues?.transitions);
        if (ts) await this.issues.transition(item.issue, ts);
      }
      // a finished request also closes its tickets where the column alone does not (GitHub issues in a project)
      if (isFinal(to)) {
        const reason = to === "CANCELLED" ? "not_planned" : "completed";
        await this.requests.finish?.(item.key, reason);
        if (item.issue) await this.issues?.finish?.(item.issue, reason);
      }
    } catch (e) {
      console.error(`[orqen] could not update the state on ${this.requests.label}: ${(e as Error).message}`);
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
