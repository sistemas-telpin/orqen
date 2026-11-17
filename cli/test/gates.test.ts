/** Analysis with analyst, lanes, SIS, orqen/work/, gates, permissions, locks and blocks, with everything simulated. */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../scripts/config.ts";
import type { OpenSpecApi } from "../scripts/openspec.ts";
import { Process, changeName } from "../scripts/process.ts";
import { Store } from "../scripts/store.ts";
import type { Workspace } from "../scripts/workspace.ts";
import { FakeJira } from "./fakes.ts";

const fakeOs: OpenSpecApi = {
  newChange: (id) => id, exists: () => false, dir: (id) => id,
  validate: () => ({ ok: true, problems: [] }), planningComplete: () => true,
  tasks: () => [{ description: "t (2h)", done: true, hours: 2 }, { description: "u (3h)", done: true, hours: 3 }],
  scenarios: () => [{ capability: "c", requirement: "R", scenario: "E" }],
  archive: () => ({ archivedAs: "x", totals: {} }),
};
const failingTests: Workspace = {
  prepareBranch: () => "rec/rec-1", commit: () => true, push: () => {}, openPr: () => "",
  runTests: () => ({ ok: false, output: "1 failed" }),
};

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "rec-g-"));
  const cfg = loadConfig({
    stateDir: join(dir, "state"), factoryDir: join(dir, "factory"), jql: "x", jiraTransitions: {},
    approvers: { analysis: ["analyst"], code: ["senior"], client: ["client"] },
  });
  const jira = new FakeJira({ "REC-1": { title: "Algo" } });
  const store = new Store(cfg.stateDir);
  return { cfg, p: new Process(cfg, jira, store, failingTests, fakeOs), jira, est: () => store.get("REC-1")! };
}

const BASE = {
  summary: "Resumen suficientemente largo del pedido.", type: "change", acceptance_criteria: ["c"],
  affected_capabilities: [], risks: [],
};
const ANALYSIS_QUESTIONS = (questions: string[]) => ({ ...BASE, open_questions: questions, ready: false });
/** Analysis closed with the analyst's OK, direct lane. */
const ANALYSIS_OK = (over: Record<string, unknown> = {}) => ({
  ...BASE, open_questions: [], ready: true, analyst_ok: true, route: "development", lane: "direct",
  lane_rationale: "Cambio acotado en un solo componente.", plan: ["Hacer el cambio (2h)"], estimated_hours: 2,
  decisions: [{ question: "¿Qué formato?", answer: "CSV" }], ...over,
});

test("analyst: client questions, mandatory OK, direct lane, SIS and orqen/work/", async () => {
  const { p, jira, est, cfg } = setup();
  const pend = await p.review();
  assert.deepEqual(pend.map((x) => [x.key, x.state, x.for]), [["REC-1", "NEW", "analyst"]]);
  await assert.rejects(p.take("REC-1", "x"), /has no work/);

  await p.analyze("REC-1", "codex", "Ana");
  assert.equal(est().state, "ANALYSIS");
  assert.equal(est().analyst, "Ana");
  assert.match(jira.coms["REC-1"][0].body, /Ana inició el análisis/);
  await assert.rejects(p.analyze("REC-1", "claude", "Bea"), /already taken by "codex"/);
  await assert.rejects(p.take("REC-1", "codex"), /driven by an analyst/);   // an agent does not analyze on its own

  assert.equal((await p.complete("REC-1", ANALYSIS_QUESTIONS(["¿x?"]), "claude")).ok, false);   // another agent
  assert.equal((await p.complete("REC-1", { summary: "corto" }, "codex")).ok, false);           // schema

  // without analyst OK / without lane / direct without plan: does not close
  let r = await p.complete("REC-1", ANALYSIS_OK({ analyst_ok: false }), "codex");
  assert.match((r as any).errors.join(), /explicit OK/);
  r = await p.complete("REC-1", ANALYSIS_OK({ lane: undefined }), "codex");
  assert.match((r as any).errors.join(), /choose the lane/);
  r = await p.complete("REC-1", ANALYSIS_OK({ plan: undefined }), "codex");
  assert.match((r as any).errors.join(), /implementation plan/);
  assert.equal(jira.created.length, 0);                                 // nothing was created halfway

  // what only the client can answer → WAITING_CLIENT
  await p.complete("REC-1", ANALYSIS_QUESTIONS(["¿Qué formato?"]), "codex");
  assert.equal(est().state, "WAITING_CLIENT");
  assert.match(jira.last("REC-1"), /¿Qué formato\?/);
  await assert.rejects(p.analyze("REC-1", "codex", "Ana"), /waiting for client answers/);
  await p.review();
  assert.equal(est().state, "WAITING_CLIENT");   // without an answer it does not advance
  jira.human("REC-1", "client", "CSV");
  const pend2 = await p.review();
  assert.equal(est().state, "ANALYSIS");
  assert.deepEqual(pend2.map((x) => [x.key, x.for]), [["REC-1", "analyst"]]);

  const { context } = await p.analyze("REC-1", "codex", "Ana");
  assert.deepEqual(context.human_feedback, [{ from: "client", text: "CSV" }]);
  assert.equal(context.factory, "orqen/work/REC-1/round-1");

  assert.deepEqual(await p.lane("REC-1", "direct", "codex"), { lane: "direct", openspec: undefined, branch: undefined });
  assert.deepEqual(await p.complete("REC-1", ANALYSIS_OK(), "codex"), { ok: true, next: "DEVELOPMENT" });

  // SIS created when closing, linked to the REC, with the lane
  assert.equal(est().state, "DEVELOPMENT");
  assert.equal(est().lane, "direct");
  assert.equal(jira.created.length, 1);
  assert.equal(jira.created[0].key, "SIS-1");
  assert.match(jira.created[0].title, /^\[REC-1\]/);
  assert.match(jira.created[0].description, /Carril:\* direct/);
  assert.deepEqual((jira.created[0] as any).labels, ["origin-rec-1", "lane-direct"]);
  assert.deepEqual(jira.links, [["SIS-1", "REC-1", "Relates"]]);
  assert.equal(est().sis, "SIS-1");
  assert.match(jira.coms["REC-1"].map((c) => c.body).join("\n"), /Creé SIS-1/);

  // record in orqen/work/REC-1
  const f = join(cfg.factoryDir, "REC-1");
  const md = readFileSync(join(f, "round-1", "analysis.md"), "utf8");
  assert.match(md, /Analista:\*\* Ana/);
  assert.match(md, /Carril:\*\* direct/);
  assert.match(md, /SIS:\*\* SIS-1/);
  assert.match(md, /¿Qué formato\?\*\* → CSV/);
  assert.ok(existsSync(join(f, "round-1", "analysis.json")));
  const state = JSON.parse(readFileSync(join(f, "state.json"), "utf8"));
  assert.deepEqual([state.state, state.lane, state.sis, state.analyst], ["DEVELOPMENT", "direct", "SIS-1", "Ana"]);
  assert.match(readFileSync(join(f, "log.md"), "utf8"), /ANALYSIS → DEVELOPMENT/);
});

test("light lane: requires `orqen lane` and the change must match", async () => {
  const { p, jira, est } = setup();
  await p.analyze("REC-1", "codex", "Ana");
  const spec = { change: "rec-1-algo", summary: "Resumen de la propuesta.", assumptions: ["s"] };
  const light = (over = {}) => ANALYSIS_OK({ lane: "light", plan: undefined, estimated_hours: undefined, spec, ...over });

  let r = await p.complete("REC-1", light({ spec: undefined }), "codex");
  assert.match((r as any).errors.join(), /need the spec/);
  r = await p.complete("REC-1", light(), "codex");                       // did not run `orqen lane`
  assert.match((r as any).errors.join(), /orqen lane REC-1 light/);
  await assert.rejects(p.lane("REC-1", "gigante", "codex"), /Invalid lane/);

  assert.deepEqual(await p.lane("REC-1", "light", "codex"),
    { lane: "light", branch: "rec/rec-1", openspec: { change: "rec-1-algo", dir: "openspec/changes/rec-1-algo" } });
  r = await p.complete("REC-1", light({ spec: { ...spec, change: "otro" } }), "codex");
  assert.match((r as any).errors.join(), /must be "rec-1-algo"/);

  assert.deepEqual(await p.complete("REC-1", light(), "codex"), { ok: true, next: "DEVELOPMENT" });
  assert.equal(est().change, "rec-1-algo");
  assert.equal(est().artifacts.estimated_hours, 5);                      // 2h + 3h from tasks.md
  assert.match(jira.created[0].description, /OpenSpec change:\* openspec\/changes\/rec-1-algo/);
  assert.match(jira.created[0].description, /Estimación:\* 5 h/);
});

test("testing that fails 3 times blocks; /approve retries (direct lane: criteria as scenarios)", async () => {
  const { p, jira, est } = setup();
  await p.analyze("REC-1", "codex", "Ana");
  await p.complete("REC-1", ANALYSIS_OK(), "codex");
  const dev = { completed: true, changes_summary: "x", modified_files: [], added_tests: [] };
  const qa = { scenarios: [{ requirement: "Acceptance criterion", scenario: "c", covered: true }], failure_diagnosis: "falla", suggestions: [], coverage_ok: true };
  for (let i = 0; i < 3; i++) {
    await p.take("REC-1"); await p.complete("REC-1", dev);   // direct: there is no tasks.md to tick
    const t = await p.take("REC-1");
    assert.deepEqual(t.context.scenarios, [{ capability: "-", requirement: "Acceptance criterion", scenario: "c" }]);
    await p.complete("REC-1", qa);
  }
  assert.equal(est().state, "BLOCKED");
  jira.human("REC-1", "intruder", "/approve");
  await p.review();
  assert.equal(est().state, "BLOCKED");
  jira.human("REC-1", "senior", "/approve revisá el mock");
  await p.review();
  assert.equal(est().state, "TESTING");
  assert.equal(est().testingAttempts, 0);
});

test("testing requires evaluating each criterion and milestones are mirrored on the SIS", async () => {
  const { p, jira, est } = setup();
  await p.analyze("REC-1", "codex", "Ana");
  await p.complete("REC-1", ANALYSIS_OK(), "codex");
  await p.take("REC-1");
  await p.complete("REC-1", { completed: true, changes_summary: "x", modified_files: [], added_tests: [] });
  await p.take("REC-1");
  const r = await p.complete("REC-1", { scenarios: [], failure_diagnosis: "", suggestions: [], coverage_ok: true });
  assert.match((r as any).errors.join(), /Scenarios still to evaluate/);
  assert.equal(est().state, "TESTING");
  assert.ok(jira.coms["SIS-1"].length >= 1);   // technical milestones are mirrored on the SIS
});

test("change name", () => {
  assert.equal(changeName("REC-123", "Exportación de facturas a CSV mensual", 1), "rec-123-exportacion-facturas-csv-mensual");
  assert.equal(changeName("REC-123", "Exportación", 2), "rec-123-exportacion-r2");
});
