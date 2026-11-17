/**
 * Core of the REC process. Used by the CLI (`orqen ...`) and the tests.
 *
 *  - review():   advances everything that does NOT need an agent (gates, unblocks) and lists the pending work.
 *  - analyze():  opens the analysis driven by an analyst (grilling) and returns the context.
 *  - lane():     records the chosen lane; for light/full it creates the branch + OpenSpec change.
 *  - take():     reserves a REC at an agent stage, prepares branch/tests/OpenSpec and returns the context.
 *  - complete(): validates the output (schema + OpenSpec), publishes to Jira/git/factory and moves the state.
 *                When closing ANALYSIS with the analyst's OK it creates the SIS and links it to the REC.
 *
 * Text posted to Jira, the SIS descriptions and the generated analysis.md stay in Spanish: they are read by people.
 */
import type { Config } from "./config.ts";
import { SCHEMAS } from "./schemas.ts";
import {
  LANES, type Lane, type State, type AgentState, GATES, isAgentState, isGate, nextStateAfterStage,
} from "./states.ts";
import { Factory } from "./factory.ts";
import { BOT_MARK, type Comment, type JiraApi } from "./jira.ts";
import { type Scenario, type OpenSpecApi, type Task, hoursOf } from "./openspec.ts";
import { reviewSql } from "./sql.ts";
import { type Rec, Store, newRec } from "./store.ts";
import type { Workspace } from "./workspace.ts";

const CMD = /^\s*\/(approve|reject)\b\s*([\s\S]*)/i;

/** `for` says who has to act: the analyst (NEW/ANALYSIS) or an unattended agent. */
export interface Pending { key: string; state: AgentState | "NEW"; for: "analyst" | "agent"; takenBy?: string }
export type CompleteResult = { ok: true; next: State } | { ok: false; errors: string[] };

export class Process {
  private fac: Factory;
  constructor(
    private cfg: Config, private jira: JiraApi, private store: Store,
    private ws: Workspace, private os: OpenSpecApi,
  ) { this.fac = new Factory(cfg.factoryDir); }

  // ================================================================ review
  async review(): Promise<Pending[]> {
    const pending: Pending[] = [];
    for (const key of await this.jira.searchKeys(this.cfg.jql)) {
      try {
        const rec = this.store.get(key) ?? newRec(key);
        if (isGate(rec.state)) await this.reviewGate(rec as Rec & { state: keyof typeof GATES });
        else if (rec.state === "BLOCKED") await this.reviewUnblock(rec);
        if (rec.state === "NEW") pending.push({ key, state: "NEW", for: "analyst" });
        else if (isAgentState(rec.state)) {
          const lock = this.activeLock(rec);
          pending.push({ key, state: rec.state, for: rec.state === "ANALYSIS" ? "analyst" : "agent", takenBy: lock?.agent });
        }
      } catch (e) {
        await this.block(key, `Error reviewing the REC: ${(e as Error).message}`, "process");
      }
    }
    return pending;
  }

  // ================================================================ analyze
  /** Opens (or resumes) the analysis of a REC. An analyst drives it; the agent does the grilling with them. */
  async analyze(key: string, agent = "agent", analyst = agent) {
    const rec = this.store.get(key) ?? newRec(key);
    if (rec.state === "WAITING_CLIENT")
      throw new Error(`${key} is waiting for client answers in Jira. When they reply it goes back to ANALYSIS (\`orqen pending\`).`);
    if (rec.state !== "NEW" && rec.state !== "ANALYSIS")
      throw new Error(`${key} already went through the analysis (state: ${rec.state}). If it must be redone, a rejection or an escalation sends it back to ANALYSIS.`);
    if (rec.state === "NEW") {
      rec.analyst = analyst;
      await this.jira.comment(key, `${analyst} inició el análisis de este REC.`);
      await this.move(rec, "ANALYSIS", "registered by analyst", agent);
    }
    rec.analyst = analyst;
    this.store.save(rec);
    return this.take(key, agent, true);
  }

  /** Records the lane. Light/full: prepares branch + OpenSpec change so the agent writes the spec. */
  async lane(key: string, lane: string, agent = "agent") {
    const rec = this.store.get(key);
    if (!rec || rec.state !== "ANALYSIS") throw new Error(`${key} is not in ANALYSIS (state: ${rec?.state ?? "unknown"}).`);
    const lock = this.activeLock(rec) ?? (rec.lock?.agent === agent ? rec.lock : undefined);
    if (!lock || lock.agent !== agent) throw new Error(`Run \`orqen analyze ${key}\` first`);
    if (!LANES.includes(lane as Lane)) throw new Error(`Invalid lane "${lane}". Options: ${LANES.join(", ")}`);
    rec.lane = lane as Lane;
    if (rec.lane === "direct") {
      this.store.save(rec);
      return { lane: rec.lane, openspec: undefined as undefined | { change: string; dir: string }, branch: undefined as string | undefined };
    }
    const issue = await this.jira.issue(key);
    rec.branch = this.ws.prepareBranch(key);
    if (!rec.change || !this.os.exists(rec.change)) {
      rec.change = changeName(key, issue.title, rec.round);
      this.os.newChange(rec.change, `${key}: ${issue.title}`);
    }
    this.store.save(rec);
    return { lane: rec.lane, branch: rec.branch, openspec: { change: rec.change, dir: `openspec/changes/${rec.change}` } };
  }

  // ================================================================ take
  async take(key: string, agent = "agent", fromAnalyze = false) {
    const rec = this.store.get(key);
    if (!rec || !isAgentState(rec.state))
      throw new Error(`${key} has no work for an agent (state: ${rec?.state ?? "unknown"}). Run \`orqen pending\`.`);
    if (rec.state === "ANALYSIS" && !fromAnalyze)
      throw new Error(`The analysis of ${key} is driven by an analyst: use /orqen:analyze ${key} (or \`orqen analyze ${key}\`).`);
    const lock = this.activeLock(rec);
    if (lock && lock.agent !== agent) throw new Error(`${key} was already taken by "${lock.agent}" since ${lock.since}.`);
    rec.lock = { agent, since: new Date().toISOString() };
    this.store.save(rec);

    const issue = await this.jira.issue(key);
    const state = rec.state;

    // ANALYSIS (light/full are created by `orqen lane`) and the fast lane (EXECUTION/VERIFICATION) do not prepare a branch here
    if (["DEVELOPMENT", "TESTING", "DELIVERY"].includes(state)) rec.branch = this.ws.prepareBranch(key);
    if (state === "TESTING") {
      rec.artifacts.test_result = this.ws.runTests();
    }
    if (state === "DELIVERY" && rec.change && !rec.artifacts.archive) {
      rec.artifacts.archive = this.os.archive(rec.change);
      this.ws.commit(key, `archiva change OpenSpec ${rec.change}`);
      this.attempt(() => this.ws.push(rec.branch));
    }
    this.store.save(rec);

    const comments = (await this.jira.comments(key)).map((c) => ({
      author: c.authorName, date: c.created, text: c.body, is_agent: c.body.startsWith(BOT_MARK),
    }));
    const openspec = rec.change ? {
      change: rec.change,
      dir: rec.artifacts.archive ? `openspec/changes/archive/${rec.artifacts.archive.archivedAs}` : `openspec/changes/${rec.change}`,
    } : undefined;

    return {
      rec,
      context: {
        key, state, round: rec.round, branch: rec.branch || undefined,
        analyst: rec.analyst, lane: rec.lane, factory: `orqen/work/${key}/round-${rec.round}`,
        issue, sis: rec.sis, comments,
        openspec,
        ...(["DEVELOPMENT", "TESTING"].includes(state) ? { tasks: this.tasksOf(rec) } : {}),
        ...(state === "TESTING" ? { scenarios: this.scenariosOf(rec) } : {}),
        test_result: state === "TESTING" ? rec.artifacts.test_result : undefined,
        previous_stages: Object.fromEntries(Object.entries(rec.artifacts).filter(([k]) => SCHEMAS[k as AgentState])),
        human_feedback: rec.feedback,
      },
    };
  }

  // ================================================================ pr
  /** Where the REC branch would go and whether it can be sent now (used by `orqen pr <KEY>` before writing the explanation). */
  prInfo(key: string) {
    const rec = this.store.get(key);
    if (!rec) throw new Error(`${key} is unknown to orqen.`);
    if (rec.route === "operational") throw new Error(`${key} is operational (no code): there is no branch to send.`);
    if (!rec.branch || !["TESTING", "CODE_REVIEW", "DELIVERY", "ACCEPTANCE", "CLOSED"].includes(rec.state))
      throw new Error(`${key} is in ${rec.state}: the PR to ${this.cfg.develBranch} is opened once development is done (TESTING or later).`);
    return {
      key, state: rec.state, branch: rec.branch, base: this.cfg.develBranch, lane: rec.lane, sis: rec.sis,
      analysis: `orqen/work/${key}/round-${rec.round}/analysis.md`,
      change: rec.change ? `openspec/changes/${rec.change}` : undefined,
      existing: rec.artifacts.devel_pr as string | undefined,
    };
  }

  /**
   * Sends the REC branch to the development branch: records the explanation (written by the agent), commits what is pending
   * on the branch (e.g. hand adjustments), pushes and opens the PR. If the PR already exists it only pushes the new commits.
   */
  async pr(key: string, body: string, title?: string, agent = "agent") {
    const info = this.prInfo(key);
    const rec = this.store.get(key)!;
    if (body.trim().length < 80) throw new Error("The explanation is too short: describe what changed, why and how to verify it.");
    const bodyFile = `orqen/work/${key}/round-${rec.round}/devel-pr.md`;
    this.fac.write(rec, "devel-pr.md", body.trim() + "\n");
    this.ws.commit(key, `explicación del PR a ${info.base}`, { branch: rec.branch });
    this.ws.push(rec.branch);
    if (info.existing) return { url: info.existing, created: false, base: info.base };
    const issue = await this.jira.issue(key);
    const out = this.ws.openPr({
      key, branch: rec.branch, base: info.base, body: bodyFile, change: rec.change,
      title: (title ?? rec.artifacts.ANALYSIS?.summary ?? issue.title).slice(0, 80),
    }, this.cfg.develPrCommand);
    const url = out.match(/https?:\/\/\S+/)?.[0];
    if (!url) throw new Error(`The PR was not opened. Output: ${out || "(none)"}`);
    rec.artifacts.devel_pr = url;
    this.store.save(rec);
    await this.commentWithSis(rec, `PR a *${info.base}* abierto desde la rama \`${rec.branch}\`: ${url}`);
    this.store.log(key, { ts: new Date().toISOString(), from: rec.state, to: rec.state, detail: `PR to ${info.base}: ${url}`, agent });
    return { url, created: true, base: info.base };
  }

  // ================================================================ complete
  async complete(key: string, raw: unknown, agent = "agent"): Promise<CompleteResult> {
    const rec = this.store.get(key);
    if (!rec || !isAgentState(rec.state)) return { ok: false, errors: [`${key} is not in an agent stage`] };
    // an expired lock stays valid while nobody else took the REC (the grilling can last longer than REC_LOCK_MIN)
    const lock = this.activeLock(rec) ?? (rec.lock?.agent === agent ? rec.lock : undefined);
    if (!lock) return { ok: false, errors: [`Run \`orqen ${rec.state === "ANALYSIS" ? "analyze" : "take"} ${key}\` first`] };
    if (lock.agent !== agent) return { ok: false, errors: [`${key} is taken by "${lock.agent}"`] };

    const state = rec.state;
    const parsed = SCHEMAS[state].safeParse(raw);
    if (!parsed.success)
      return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`) };
    const s: Record<string, any> = parsed.data;

    // --- validations against OpenSpec / repo (the agent fixes and completes again)
    const errors = this.validateAgainstOpenSpec(rec, state, s);
    if (errors.length) return { ok: false, errors };

    // --- counters and decision
    if (state === "ANALYSIS") {
      rec.route = s.route;
      if (s.ready) rec.lane = s.lane;
      if (s.open_questions.length && !s.ready) rec.questionRounds++;
    }
    if (state === "VERIFICATION") rec.testingAttempts++;
    if (state === "TESTING") {
      rec.testingAttempts++;
      s.approved = rec.artifacts.test_result?.ok === true && s.coverage_ok && s.scenarios.every((e: any) => e.covered);
    }
    rec.artifacts[state] = s;
    const next = nextStateAfterStage(state, s, rec);
    if (state === "VERIFICATION" && next === "ANALYSIS") {  // escalation: the new analysis creates a development SIS
      rec.route = "development"; delete rec.lane; delete rec.artifacts.sis_linked;
      if (rec.sis) { (rec.artifacts.previous_sis ??= []).push(rec.sis); delete rec.sis; }
    }
    if (state === "VERIFICATION" && next !== "EXECUTION") rec.testingAttempts = 0;

    if (state === "ANALYSIS" && s.ready) await this.closeAnalysis(rec, s);
    await this.publish(rec, state, s, next);
    rec.feedback = [];
    await this.move(rec, next, `stage ${state} completed`, agent);
    return { ok: true, next };
  }

  private validateAgainstOpenSpec(rec: Rec, state: AgentState, s: Record<string, any>): string[] {
    const err: string[] = [];
    if (state === "ANALYSIS" && s.ready && s.route === "development" && s.lane !== "direct") {
      if (rec.lane !== s.lane) err.push(`The analysis lane ("${s.lane}") does not match the recorded one (${rec.lane ?? "none"}): run \`orqen lane ${rec.key} ${s.lane}\` and write the spec`);
      else if (!rec.change) err.push(`The change is missing: run \`orqen lane ${rec.key} ${s.lane}\``);
      else {
        if (s.spec.change !== rec.change) err.push(`spec.change must be "${rec.change}"`);
        const v = this.os.validate(rec.change);
        if (!v.ok) err.push("openspec validate --strict failed:", ...v.problems.map((p) => "  " + p));
        if (!this.os.planningComplete(rec.change)) err.push("The change is missing artifacts (see `openspec status --change " + rec.change + "`)");
        const tasks = this.os.tasks(rec.change);
        if (!tasks.length) err.push("tasks.md has no tasks");
        const unestimated = tasks.filter((t) => t.hours === undefined);
        if (unestimated.length) err.push(`Each task must end with its estimate, e.g. "(4h)". Not estimated: ${unestimated.map((t) => t.description).join(" | ")}`);
      }
    }
    if (state === "ANALYSIS" && s.ready && s.lane === "direct" && rec.lane && rec.lane !== "direct" && rec.change)
      err.push(`You recorded the ${rec.lane} lane and a change already exists (${rec.change}); pick one or the other (if the decision changed run \`orqen lane ${rec.key} direct\` and do not use the change).`);
    if (state === "DEVELOPMENT" && s.completed && rec.change) {
      const pending = this.os.tasks(rec.change).filter((t) => !t.done);
      if (pending.length) err.push(`There are unticked tasks in tasks.md: ${pending.map((t) => t.description).join(" | ")}`);
    }
    if (state === "EXECUTION") {
      err.push(...reviewSql(s.sql_script ?? "", "sql_script"), ...reviewSql(s.rollback, "rollback"));
    }
    if (state === "TESTING") {
      const reported = new Set(s.scenarios.map((e: any) => norm(e.scenario)));
      const missing = this.scenariosOf(rec).filter((e) => !reported.has(norm(e.scenario)));
      if (missing.length) err.push(`Scenarios still to evaluate: ${missing.map((e) => `${e.requirement} › ${e.scenario}`).join(" | ")}`);
    }
    return err;
  }

  /** Tasks of the REC: those in tasks.md (light/full) or the analysis plan (direct). */
  private tasksOf(rec: Rec): Task[] {
    if (rec.change) return this.os.tasks(rec.change);
    return ((rec.artifacts.ANALYSIS?.plan ?? []) as string[]).map((p) => ({ description: p, done: false, hours: hoursOf(p) }));
  }

  /** What testing must cover: Scenarios of the spec deltas, or the acceptance criteria in the direct lane. */
  private scenariosOf(rec: Rec): Scenario[] {
    if (rec.change) return this.os.scenarios(rec.change);
    return ((rec.artifacts.ANALYSIS?.acceptance_criteria ?? []) as string[])
      .map((c) => ({ capability: "-", requirement: "Acceptance criterion", scenario: c }));
  }

  // ================================================================ analysis closing
  /** With the analyst's OK: estimate, record in orqen/work/, spec commit (if any) and SIS linked to the REC. */
  private async closeAnalysis(rec: Rec, s: Record<string, any>) {
    rec.artifacts.estimated_hours = rec.change
      ? this.os.tasks(rec.change).reduce((a, t) => a + (t.hours ?? 0), 0)
      : s.estimated_hours;
    await this.createSis(rec);
    this.recordAnalysis(rec, s);
    if (rec.change) this.ws.commit(rec.key, `spec OpenSpec ${rec.change}`);
  }

  private recordAnalysis(rec: Rec, s: Record<string, any>) {
    const md = (t: string, xs: string[]) => xs.length ? `## ${t}\n\n${xs.map((x) => `- ${x}`).join("\n")}\n\n` : "";
    this.fac.write(rec, "analysis.json", JSON.stringify(s, null, 2) + "\n");
    this.fac.write(rec, "analysis.md",
      `# ${rec.key} — análisis (ronda ${rec.round})\n\n` +
      `- **Analista:** ${rec.analyst ?? "?"}\n- **Vía:** ${s.route}\n- **Carril:** ${s.lane}\n- **Justificación del carril:** ${s.lane_rationale}\n` +
      `- **SIS:** ${rec.sis ?? "—"}\n` + (rec.change ? `- **OpenSpec change:** openspec/changes/${rec.change}/\n` : "") +
      (rec.artifacts.estimated_hours !== undefined ? `- **Estimación:** ${rec.artifacts.estimated_hours} h\n` : "") +
      `\n## Resumen\n\n${s.summary}\n\n` +
      md("Criterios de aceptación", s.acceptance_criteria) +
      (s.plan?.length ? `## Plan (carril directo)\n\n${s.plan.map((x: string, i: number) => `${i + 1}. ${x}`).join("\n")}\n\n` : "") +
      (s.decisions.length ? `## Decisiones del grilling\n\n${s.decisions.map((d: any) => `- **${d.question}** → ${d.answer}`).join("\n")}\n\n` : "") +
      md("Capacidades afectadas", s.affected_capabilities) + md("Riesgos", s.risks) +
      (s.spec ? md("Supuestos de la spec", s.spec.assumptions) : ""));
  }

  // ================================================================ publish
  private async publish(rec: Rec, state: AgentState, s: Record<string, any>, next: State) {
    const k = rec.key;
    switch (state) {
      case "ANALYSIS": {
        let t = `*Análisis*${rec.analyst ? ` (analista: ${rec.analyst})` : ""}\n${s.summary}\n\n*Tipo:* ${s.type}\n\n*Criterios de aceptación:*\n${bullets(s.acceptance_criteria)}`;
        if (s.risks.length) t += `\n\n*Riesgos:*\n${bullets(s.risks)}`;
        if (s.ready) {
          t += `\n\n*Carril:* ${s.route === "operational" ? "operativo (sin código)" : s.lane} — ${s.lane_rationale}`;
          if (rec.change) {
            const sc = this.os.scenarios(rec.change);
            t += `\n*Spec:* OpenSpec change \`${rec.change}\` (rama \`${rec.branch}\`), ${sc.length} escenario(s), ${rec.artifacts.estimated_hours} h estimadas.`;
          } else if (s.route === "development") t += `\n*Plan:*\n${bullets(s.plan ?? [], true)}` + (s.estimated_hours !== undefined ? `\n*Estimación:* ${s.estimated_hours} h` : "");
          t += `\n*SIS:* ${rec.sis}`;
        }
        if (next === "WAITING_CLIENT") t += `\n\n*Necesito que me confirmes lo siguiente para poder especificar:*\n${bullets(s.open_questions, true)}`;
        if (next === "BLOCKED") t += "\n\nSe agotaron las rondas de preguntas; derivo a una persona del equipo.";
        return this.jira.comment(k, t);
      }
      case "DEVELOPMENT":
        if (s.completed) {
          this.ws.commit(k, s.changes_summary.slice(0, 200));
          return this.commentWithSis(rec, `Desarrollo listo en la rama \`${rec.branch}\`.\n${s.changes_summary}\n\nTests agregados:\n${bullets(s.added_tests)}\nPaso a testing.`);
        }
        return this.commentWithSis(rec, `No pude completar el desarrollo: ${s.blocker}`);
      case "TESTING": {
        const rt = rec.artifacts.test_result;
        const table = s.scenarios.map((e: any) => `- ${e.covered ? "✔" : "✘"} ${e.requirement} › ${e.scenario}${e.test ? ` (${e.test})` : ""}`).join("\n");
        if (s.approved) {
          if (!rec.artifacts.pr) {
            this.attempt(() => this.ws.push(rec.branch));
            rec.artifacts.pr = this.attempt(() => this.ws.openPr({
              key: k, branch: rec.branch, change: rec.change, change_dir: rec.change ? `openspec/changes/${rec.change}` : `orqen/work/${k}/round-${rec.round}`,
              body: rec.change ? `openspec/changes/${rec.change}/proposal.md` : `orqen/work/${k}/round-${rec.round}/analysis.md`,
              title: rec.artifacts.ANALYSIS?.summary?.slice(0, 80) ?? rec.change,
            })) ?? "";
          }
          return this.commentWithSis(rec, `Tests OK y todos los escenarios cubiertos:\n${table}\n\nPR: ${rec.artifacts.pr || rec.branch}\nRevisión de código: comentá */approve* o */reject <motivo>*.`);
        }
        return this.commentWithSis(rec, `Testing no aprobado (intento ${rec.testingAttempts}). Suite: ${rt?.ok ? "OK" : "FALLA"}\n${table}\n\nDiagnóstico: ${s.failure_diagnosis}` +
          (next === "BLOCKED" ? "\nSe agotaron los intentos; derivo a una persona." : "\nVuelvo a desarrollo."));
      }
      case "EXECUTION": {
        this.fac.write(rec, "execution/summary.md", `# Propuesta operativa\n\n${s.summary}\n\n- Sistema: ${s.system}\n- Impacto: ${s.impact}\n`);
        if (s.sql_script) this.fac.write(rec, "execution/script.sql", s.sql_script);
        if (s.manual_steps?.length) this.fac.write(rec, "execution/steps.md", bullets(s.manual_steps, true));
        this.fac.write(rec, "execution/rollback.txt", s.rollback);
        this.fac.write(rec, "execution/verification.txt", s.verification);
        const t = `*Propuesta operativa (carril rápido, sin desarrollo)*\n${s.summary}\n\n*Sistema:* ${s.system}\n*Impacto:* ${s.impact}` +
          (s.estimated_rows !== undefined ? `\n*Filas estimadas:* ${s.estimated_rows}` : "") +
          (s.sql_script ? `\n\n*Script SQL:*\n{code:sql}\n${s.sql_script}\n{code}` : "") +
          (s.manual_steps?.length ? `\n\n*Pasos manuales:*\n${bullets(s.manual_steps, true)}` : "") +
          `\n\n*Rollback:*\n{code}\n${s.rollback}\n{code}\n\n*Verificación:*\n{code}\n${s.verification}\n{code}` +
          (s.risks.length ? `\n\n*Riesgos:*\n${bullets(s.risks)}` : "") +
          `\n\nPara autorizar la ejecución comentá */approve*, o */reject <motivo>* para que lo rehaga.`;
        return this.commentWithSis(rec, t);
      }
      case "VERIFICATION": {
        const t = `*Verificación*\n${s.evidence}\n\n`;
        if (next === "ACCEPTANCE")
          return this.commentWithSis(rec, t + `${s.client_message}\n\n*Cómo validarlo:*\n${bullets(s.validation_steps, true)}\n\n` +
            `Para dar conformidad comentá */approve*, o */reject <motivo>* si algo no está bien.`);
        if (next === "ANALYSIS")
          return this.jira.comment(k, t + "Se comprobó que la causa requiere un cambio de código: vuelve a análisis para que el analista elija el carril de desarrollo.");
        return this.jira.comment(k, t + (next === "BLOCKED"
          ? "No quedó resuelto y se agotaron los intentos; derivo a una persona."
          : "No quedó resuelto; preparo una nueva propuesta."));
      }
      case "DELIVERY":
        return this.jira.comment(k, `${s.client_message}\n\n*Cómo validarlo:*\n${bullets(s.validation_steps, true)}\n\n` +
          `Para dar conformidad comentá */approve*, o */reject <motivo>* si algo no está bien.`);
    }
  }

  // ================================================================ gates
  private async newHumanComments(rec: Rec): Promise<Comment[]> {
    const cs = await this.jira.comments(rec.key);
    const i = cs.findIndex((c) => c.id === rec.lastSeenComment);
    if (cs.length) rec.lastSeenComment = cs[cs.length - 1].id;
    return cs.slice(i + 1).filter((c) => !c.body.startsWith(BOT_MARK));
  }

  private approvers(s: State): string[] {
    const a = this.cfg.approvers;
    return ({ CODE_REVIEW: a.code, ACCEPTANCE: a.client, EXECUTION_APPROVAL: a.execution ?? [], APPLICATION: a.execution ?? [], BLOCKED: [...(a.analysis ?? []), ...a.code] } as Record<string, string[]>)[s] ?? [];
  }

  private async reviewGate(rec: Rec & { state: keyof typeof GATES }) {
    const gate = GATES[rec.state];
    const fresh = await this.newHumanComments(rec);
    if (gate.kind === "answer") {
      if (fresh.length) {
        rec.feedback.push(...fresh.map((c) => ({ from: c.authorName, text: c.body })));
        return this.move(rec, gate.approve, "client answered");
      }
      return this.store.save(rec);
    }
    const authorized = this.approvers(rec.state);
    for (const c of fresh) {
      const m = c.body.match(CMD);
      if (!m) { rec.feedback.push({ from: c.authorName, text: c.body }); continue; }
      if (authorized.length && !authorized.includes(c.author)) {
        await this.jira.comment(rec.key, `${c.authorName}: no estás habilitado para /${m[1]} en esta etapa.`);
        continue;
      }
      const action = m[1].toLowerCase() as "approve" | "reject", reason = m[2].trim();
      if (action === "reject") rec.feedback.push({ from: c.authorName, rejection: reason });
      if (action === "approve" && reason && rec.state === "APPLICATION")
        rec.feedback.push({ from: c.authorName, text: reason });  // result of the application
      if (rec.state === "CODE_REVIEW" && action === "reject") rec.testingAttempts = 0;
      if (rec.state === "EXECUTION_APPROVAL" && action === "approve")
        await this.jira.comment(rec.key, "Ejecución autorizada. Quien lo aplique, que lo haga tal como está propuesto y comente */approve <resultado>* si salió bien, o */reject <motivo>* si falló.");
      if (rec.state === "ACCEPTANCE" && action === "reject") {
        // new round: the previous change is already archived → the analyst re-analyzes (new lane, change and SIS)
        rec.round++; rec.change = ""; rec.questionRounds = 0; rec.testingAttempts = 0; delete rec.lane;
        delete rec.artifacts.archive; delete rec.artifacts.pr; delete rec.artifacts.sis_linked;
        if (rec.sis) { (rec.artifacts.previous_sis ??= []).push(rec.sis); delete rec.sis; }  // the new round gets its own SIS
      }
      return this.move(rec, gate[action === "approve" ? "approve" : "reject"], `/${action} by ${c.authorName} ${reason}`.trim());
    }
    this.store.save(rec);
  }

  private async reviewUnblock(rec: Rec) {
    const authorized = this.approvers("BLOCKED");
    for (const c of await this.newHumanComments(rec)) {
      const m = c.body.match(CMD);
      if (m && m[1].toLowerCase() === "approve" && (!authorized.length || authorized.includes(c.author))) {
        rec.testingAttempts = 0; rec.questionRounds = 0;
        if (m[2].trim()) rec.feedback.push({ from: c.authorName, text: m[2].trim() });
        return this.move(rec, rec.stateBeforeBlock ?? "ANALYSIS", `unblocked by ${c.authorName}`);
      }
      rec.feedback.push({ from: c.authorName, text: c.body });
    }
    this.store.save(rec);
  }

  // ================================================================ SIS
  /**
   * When the analysis closes: creates the SIS (another Jira project), links it to the REC and notifies both.
   * Idempotent and resumable: if it fails halfway (e.g. the link), retrying `complete` picks up where it left off.
   */
  private async createSis(rec: Rec) {
    const a = rec.artifacts.ANALYSIS ?? {};
    const operational = rec.route === "operational";
    if (!rec.sis) {
      const issue = await this.jira.issue(rec.key);
      const tasks = operational ? [] : this.tasksOf(rec);
      const sc = operational ? [] : this.scenariosOf(rec);
      const sis = await this.jira.createIssue({
        project: this.cfg.sis.project, type: operational ? this.cfg.sis.operationalType : this.cfg.sis.type,
        title: `[${rec.key}] ${issue.title}`, labels: [`origin-${rec.key.toLowerCase()}`, `lane-${operational ? "operational" : a.lane}`],
        description: operational
          ? `Resolución operativa del requerimiento ${rec.key} (sin desarrollo).\n\n*Resumen:* ${a.summary}\n*Justificación:* ${a.lane_rationale}\n\n` +
            `*Criterios de aceptación:*\n${bullets(a.acceptance_criteria ?? [])}\n\nEl script, el rollback y la verificación los propone la etapa EXECUTION y se publican en el REC.`
          : `Desarrollo del requerimiento ${rec.key}. *Carril:* ${a.lane} — ${a.lane_rationale}\n\n` +
            `*Resumen:* ${rec.artifacts.ANALYSIS?.spec?.summary ?? a.summary}\n\n` +
            `*Rama:* rec/${rec.key.toLowerCase()}\n` + (rec.change ? `*OpenSpec change:* openspec/changes/${rec.change}/\n` : `*Sin spec (carril directo):* orqen/work/${rec.key}/round-${rec.round}/analysis.md\n`) +
            `*Estimación:* ${rec.artifacts.estimated_hours ?? "?"} h\n\n` +
            `*${rec.change ? "Tareas" : "Plan"}:*\n${bullets(tasks.map((t) => t.description))}\n\n` +
            `*${rec.change ? "Escenarios de aceptación" : "Criterios de aceptación"}:*\n${bullets(sc.map((e) => rec.change ? `${e.requirement} › ${e.scenario}` : e.scenario))}`,
      });
      rec.sis = sis;
      this.store.save(rec);
    }
    if (!rec.artifacts.sis_linked) {
      await this.jira.link(rec.sis, rec.key, this.cfg.sis.link);
      await this.jira.comment(rec.key, `Análisis cerrado${rec.analyst ? ` con ${rec.analyst}` : ""}. Creé ${rec.sis} (carril ${operational ? "operativo" : a.lane}) para el seguimiento; el seguimiento técnico va por ahí y acá sigo informando los hitos.`);
      await this.jira.comment(rec.sis, `Creado a partir de ${rec.key} al cerrarse el análisis. Registro: orqen/work/${rec.key}/.`);
      rec.artifacts.sis_linked = true;
      this.store.save(rec);
    }
  }

  /** Comments on the REC and, if it exists, mirrors on the SIS. */
  private async commentWithSis(rec: Rec, text: string) {
    await this.jira.comment(rec.key, text);
    if (rec.sis) await this.attemptAsync(() => this.jira.comment(rec.sis!, text));
  }

  // ================================================================ utilities
  async block(key: string, reason: string, agent = "agent") {
    const rec = this.store.get(key) ?? newRec(key);
    if (rec.state === "BLOCKED") return;
    await this.jira.comment(key, `Necesito intervención humana: ${reason}\nCuando esté resuelto, comentá /approve <indicaciones> para reintentar.`);
    await this.move(rec, "BLOCKED", reason, agent);
  }

  release(key: string) {
    const rec = this.store.get(key);
    if (rec) { delete rec.lock; this.store.save(rec); }
  }

  private activeLock(rec: Rec) {
    if (!rec.lock) return undefined;
    const expired = Date.now() - Date.parse(rec.lock.since) > this.cfg.lockMinutes * 60_000;
    return expired ? undefined : rec.lock;
  }

  private async attemptAsync(fn: () => Promise<unknown>) {
    try { await fn(); } catch (e) { console.error(`[orqen] warning: ${(e as Error).message}`); }
  }

  private attempt<T>(fn: () => T): T | undefined {
    try { return fn(); } catch (e) { console.error(`[orqen] warning: ${(e as Error).message}`); return undefined; }
  }

  private async move(rec: Rec, to: State, detail: string, agent?: string) {
    const from = rec.state;
    if (to === "BLOCKED" && from !== "BLOCKED") rec.stateBeforeBlock = from;
    rec.state = to;
    delete rec.lock;
    if (isGate(to) || to === "BLOCKED") {  // when entering a gate, ignore earlier comments
      const cs = await this.jira.comments(rec.key);
      rec.lastSeenComment = cs.at(-1)?.id ?? "";
    }
    this.store.save(rec);
    this.store.log(rec.key, { ts: new Date().toISOString(), from, to, detail, agent });
    this.fac.record(rec, from, to, detail, agent);
    if (rec.branch) this.attempt(() => this.ws.commit(rec.key, `registro ${from} → ${to}`, { path: this.cfg.factoryDir, branch: rec.branch }));
    try {
      await this.jira.setStateLabel(rec.key, to);
      const t = this.cfg.jiraTransitions[to];
      if (t) await this.jira.transition(rec.key, t);
      if (rec.sis) {
        const ts = this.cfg.sis.transitions[to];
        if (ts) await this.jira.transition(rec.sis, ts);
      }
    } catch (e) {
      console.error(`[orqen] could not update label/transition in Jira: ${(e as Error).message}`);
    }
  }
}

export function changeName(key: string, title: string, round: number) {
  const slug = title.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter((w) => w.length > 2).slice(0, 4).join("-");
  return [key.toLowerCase(), slug, round > 1 ? `r${round}` : ""].filter(Boolean).join("-");
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
const bullets = (xs: string[], numbered = false) => xs.map((x) => `${numbered ? "#" : "*"} ${x}`).join("\n") || "_(ninguno)_";
