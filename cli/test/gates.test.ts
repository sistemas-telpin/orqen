/** Analysis with analyst, lanes, internal ticket, orqen/work/, gates, permissions, locks and blocks, with everything simulated. */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../src/workflow/config.ts";
import type { OpenSpecApi } from "../src/workflow/openspec.ts";
import { Process, changeName } from "../src/workflow/process.ts";
import { Store, newWorkItem } from "../src/workflow/store.ts";
import type { Workspace } from "../src/workflow/workspace.ts";
import { both, FakeTracker, testConnectors } from "./fakes.ts";

const fakeOs: OpenSpecApi = {
  newChange: (id) => id, exists: () => false, dir: (id) => id,
  validate: () => ({ ok: true, problems: [] }), planningComplete: () => true,
  tasks: () => [{ description: "t (2h)", done: true, hours: 2 }, { description: "u (3h)", done: true, hours: 3 }],
  scenarios: () => [{ capability: "c", requirement: "R", scenario: "E" }],
  archive: () => ({ archivedAs: "x", totals: {} }),
};
const failingTests: Workspace = {
  prepareBranch: () => "orqen/req-1", currentBranch: () => "orqen/req-1", commit: () => true, push: () => {}, openPr: () => "",
  runTests: () => ({ ok: false, output: "1 failed" }),
};

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "rec-g-"));
  const cfg = loadConfig({
    stateDir: join(dir, "state"), factoryDir: join(dir, "factory"), connectors: testConnectors(),
    approvers: { analysis: ["analyst"], code: ["senior"], client: ["client"] },
  });
  const jira = new FakeTracker({ "REQ-1": { title: "Algo" } });
  const store = new Store(cfg.stateDir);
  return { cfg, p: new Process(cfg, both(jira), store, failingTests, fakeOs), jira, est: () => store.get("REQ-1")! };
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

test("analyst: client questions, mandatory OK, direct lane, internal ticket and orqen/work/", async () => {
  const { p, jira, est, cfg } = setup();
  const pend = await p.review();
  assert.deepEqual(pend.map((x) => [x.key, x.state, x.for]), [["REQ-1", "NEW", "analyst"]]);
  await assert.rejects(p.take("REQ-1", "x"), /has no work/);

  await p.analyze("REQ-1", "codex", "Ana");
  assert.equal(est().state, "ANALYSIS");
  assert.equal(est().analyst, "Ana");
  assert.match(jira.coms["REQ-1"][0].body, /Ana started analyzing/);
  await assert.rejects(p.analyze("REQ-1", "claude", "Bea"), /already taken by "codex"/);
  await assert.rejects(p.take("REQ-1", "codex"), /driven by an analyst/);   // an agent does not analyze on its own

  assert.equal((await p.complete("REQ-1", ANALYSIS_QUESTIONS(["¿x?"]), "claude")).ok, false);   // another agent
  assert.equal((await p.complete("REQ-1", { summary: "corto" }, "codex")).ok, false);           // schema

  // without analyst OK / without lane / direct without plan: does not close
  let r = await p.complete("REQ-1", ANALYSIS_OK({ analyst_ok: false }), "codex");
  assert.match((r as any).errors.join(), /explicit OK/);
  r = await p.complete("REQ-1", ANALYSIS_OK({ lane: undefined }), "codex");
  assert.match((r as any).errors.join(), /choose the lane/);
  r = await p.complete("REQ-1", ANALYSIS_OK({ plan: undefined }), "codex");
  assert.match((r as any).errors.join(), /implementation plan/);
  assert.equal(jira.created.length, 0);                                 // nothing was created halfway

  // what only the client can answer → WAITING_CLIENT
  await p.complete("REQ-1", ANALYSIS_QUESTIONS(["¿Qué formato?"]), "codex");
  assert.equal(est().state, "WAITING_CLIENT");
  assert.match(jira.last("REQ-1"), /¿Qué formato\?/);
  await assert.rejects(p.analyze("REQ-1", "codex", "Ana"), /waiting for client answers/);
  await p.review();
  assert.equal(est().state, "WAITING_CLIENT");   // without an answer it does not advance
  jira.human("REQ-1", "client", "CSV");
  const pend2 = await p.review();
  assert.equal(est().state, "ANALYSIS");
  assert.deepEqual(pend2.map((x) => [x.key, x.for]), [["REQ-1", "analyst"]]);

  const { context } = await p.analyze("REQ-1", "codex", "Ana");
  assert.deepEqual(context.human_feedback, [{ from: "client", text: "CSV" }]);
  assert.equal(context.factory, "orqen/work/REQ-1/round-1");

  assert.deepEqual(await p.lane("REQ-1", "direct", "codex"), { lane: "direct", openspec: undefined, branch: undefined });
  assert.deepEqual(await p.complete("REQ-1", ANALYSIS_OK(), "codex"), { ok: true, next: "DEVELOPMENT" });

  // internal ticket created when closing, linked to the request, with the lane
  assert.equal(est().state, "DEVELOPMENT");
  assert.equal(est().lane, "direct");
  assert.equal(jira.created.length, 1);
  assert.equal(jira.created[0].key, "DEV-1");
  assert.match(jira.created[0].title, /^\[REQ-1\]/);
  assert.match(jira.created[0].description, /Lane:\* direct/);
  assert.deepEqual((jira.created[0] as any).labels, ["origin-req-1", "lane-direct"]);
  assert.deepEqual(jira.links, [["DEV-1", "REQ-1"]]);
  assert.equal(est().internal, "DEV-1");
  assert.match(jira.coms["REQ-1"].map((c) => c.body).join("\n"), /Track implementation in DEV-1/);

  // record in orqen/work/REQ-1
  const f = join(cfg.factoryDir, "REQ-1");
  const md = readFileSync(join(f, "round-1", "analysis.md"), "utf8");
  assert.match(md, /Analyst:\*\* Ana/);
  assert.match(md, /Lane:\*\* direct/);
  assert.match(md, /Internal ticket:\*\* DEV-1/);
  assert.match(md, /¿Qué formato\?\*\* → CSV/);
  assert.ok(existsSync(join(f, "round-1", "analysis.json")));
  const state = JSON.parse(readFileSync(join(f, "state.json"), "utf8"));
  assert.deepEqual([state.state, state.lane, state.internal, state.analyst], ["DEVELOPMENT", "direct", "DEV-1", "Ana"]);
  assert.match(readFileSync(join(f, "log.md"), "utf8"), /ANALYSIS → DEVELOPMENT/);
});

test("light lane: requires `orqen lane` and the change must match", async () => {
  const { p, jira, est } = setup();
  await p.analyze("REQ-1", "codex", "Ana");
  const spec = { change: "req-1-algo", summary: "Resumen de la propuesta.", assumptions: ["s"] };
  const light = (over = {}) => ANALYSIS_OK({ lane: "light", plan: undefined, estimated_hours: undefined, spec, ...over });

  let r = await p.complete("REQ-1", light({ spec: undefined }), "codex");
  assert.match((r as any).errors.join(), /need the spec/);
  r = await p.complete("REQ-1", light(), "codex");                       // did not run `orqen lane`
  assert.match((r as any).errors.join(), /orqen lane REQ-1 light/);
  await assert.rejects(p.lane("REQ-1", "gigante", "codex"), /Invalid lane/);

  assert.deepEqual(await p.lane("REQ-1", "light", "codex"),
    { lane: "light", branch: "orqen/req-1", openspec: { change: "req-1-algo", dir: "openspec/changes/req-1-algo" } });
  r = await p.complete("REQ-1", light({ spec: { ...spec, change: "otro" } }), "codex");
  assert.match((r as any).errors.join(), /must be "req-1-algo"/);

  assert.deepEqual(await p.complete("REQ-1", light(), "codex"), { ok: true, next: "DEVELOPMENT" });
  assert.equal(est().change, "req-1-algo");
  assert.equal(est().artifacts.estimated_hours, 5);                      // 2h + 3h from tasks.md
  assert.match(jira.created[0].description, /OpenSpec change:\* openspec\/changes\/req-1-algo/);
  assert.match(jira.created[0].description, /Estimate:\* 5 h/);
});

test("testing that fails 3 times blocks; /approve retries (direct lane: criteria as scenarios)", async () => {
  const { p, jira, est } = setup();
  await p.analyze("REQ-1", "codex", "Ana");
  await p.complete("REQ-1", ANALYSIS_OK(), "codex");
  const dev = { completed: true, changes_summary: "x", modified_files: [], added_tests: [] };
  const qa = { scenarios: [{ requirement: "Acceptance criterion", scenario: "c", covered: true }], failure_diagnosis: "falla", suggestions: [], coverage_ok: true };
  for (let i = 0; i < 3; i++) {
    await p.take("REQ-1"); await p.complete("REQ-1", dev);   // direct: there is no tasks.md to tick
    const t = await p.take("REQ-1");
    assert.deepEqual(t.context.scenarios, [{ capability: "-", requirement: "Acceptance criterion", scenario: "c" }]);
    await p.complete("REQ-1", qa);
  }
  assert.equal(est().state, "BLOCKED");
  jira.human("REQ-1", "intruder", "/approve");
  await p.review();
  assert.equal(est().state, "BLOCKED");
  jira.human("REQ-1", "senior", "/approve revisá el mock");
  await p.review();
  assert.equal(est().state, "TESTING");
  assert.equal(est().testingAttempts, 0);
});

test("testing requires evaluating each criterion and milestones are mirrored on the internal ticket", async () => {
  const { p, jira, est } = setup();
  await p.analyze("REQ-1", "codex", "Ana");
  await p.complete("REQ-1", ANALYSIS_OK(), "codex");
  await p.take("REQ-1");
  await p.complete("REQ-1", { completed: true, changes_summary: "x", modified_files: [], added_tests: [] });
  await p.take("REQ-1");
  const r = await p.complete("REQ-1", { scenarios: [], failure_diagnosis: "", suggestions: [], coverage_ok: true });
  assert.match((r as any).errors.join(), /Scenarios still to evaluate/);
  assert.equal(est().state, "TESTING");
  assert.ok(jira.coms["DEV-1"].length >= 1);   // technical milestones are mirrored on the internal ticket
});

test("change name", () => {
  assert.equal(changeName("REQ-123", "Exportación de facturas a CSV mensual", 1), "req-123-exportacion-facturas-csv-mensual");
  assert.equal(changeName("REQ-123", "Exportación", 2), "req-123-exportacion-r2");
});

test("testing approved goes to CODE_REVIEW without pushing or opening a PR", async () => {
  const { jira, cfg } = setup();
  const calls: string[] = [];
  const ws: Workspace = {
    ...failingTests, runTests: () => ({ ok: true, output: "ok" }),
    push: () => { calls.push("push"); }, openPr: () => { calls.push("pr"); return "https://example.test/pr/1"; },
  };
  const store = new Store(cfg.stateDir);
  const flow = new Process(cfg, both(jira), store, ws, fakeOs);
  store.save({ ...newWorkItem("REQ-1"), state: "TESTING", branch: "orqen/req-1", change: "c" });
  await flow.take("REQ-1");
  const r = await flow.complete("REQ-1", {
    scenarios: [{ requirement: "R", scenario: "E", covered: true, test: "a.test.ts::e" }],
    failure_diagnosis: "", suggestions: [], coverage_ok: true,
  });
  assert.deepEqual(r, { ok: true, next: "CODE_REVIEW" });
  assert.deepEqual(calls, []);
  assert.match(jira.last("REQ-1"), /is opened with \/orqen:pr/);
});

test("review: records the code review in CODE_REVIEW with an open PR, numbered per round, commented on the internal ticket", async () => {
  const { jira, cfg } = setup();
  jira.coms["DEV-9"] = [];
  const commits: unknown[] = [];
  const ws: Workspace = { ...failingTests, commit: (_k, msg, opts) => { commits.push([msg, opts?.branch]); return true; } };
  const store = new Store(cfg.stateDir);
  const flow = new Process(cfg, both(jira), store, ws, fakeOs);
  const report = "## Veredicto\nRechazar: falta validar el rango de fechas.\n\n## Hallazgos\n#1 bloqueante · src/export.ts:42 · Solución: validar antes de consultar.";
  const rec = { ...newWorkItem("REQ-1"), branch: "orqen/req-1", internal: "DEV-9" };

  store.save({ ...rec, state: "TESTING" });
  await assert.rejects(flow.codeReview("REQ-1", report, "reject"), /recorded in CODE_REVIEW/);
  store.save({ ...rec, state: "CODE_REVIEW" });
  await assert.rejects(flow.codeReview("REQ-1", report, "reject"), /no PR to desarrollo yet/);
  store.save({ ...rec, state: "CODE_REVIEW", artifacts: { devel_pr: "https://example.test/pr/7" } });
  await assert.rejects(flow.codeReview("REQ-1", report, "maybe"), /Invalid verdict/);
  await assert.rejects(flow.codeReview("REQ-1", "corto", "reject"), /too short/);

  const r1 = await flow.codeReview("REQ-1", report, "reject");
  assert.deepEqual([r1.n, r1.path, r1.commentedOn], [1, "orqen/work/REQ-1/round-1/code-review-1.md", "DEV-9"]);
  assert.match(readFileSync(join(cfg.factoryDir, "REQ-1", "round-1", "code-review-1.md"), "utf8"), /rango de fechas/);
  assert.match(jira.last("DEV-9"), /Code review #1.*verdict: \*Reject\*/);
  assert.deepEqual(commits, [["code review #1", "orqen/req-1"]]);

  const r2 = await flow.codeReview("REQ-1", report.replace("Rechazar", "Aprobable"), "approve");   // second pass: does not overwrite
  assert.equal(r2.n, 2);
  assert.ok(existsSync(join(cfg.factoryDir, "REQ-1", "round-1", "code-review-1.md")));
  assert.equal(store.get("REQ-1")!.state, "CODE_REVIEW");   // does not move the state
});

test("CODE_REVIEW decided by the review on the GitHub PR: stale, unauthorized and handled reviews do not count", async () => {
  const { jira, cfg } = setup();
  assert.equal(cfg.codeReviewGate, "github");   // default
  jira.issues["DEV-9"] = { title: "internal ticket" }; jira.coms["DEV-9"] = [];
  let snap: { head: string; reviews: Array<{ id: string; author: string; state: string; commit: string; body: string }> } = { head: "h1", reviews: [] };
  let fail = false;
  const ws: Workspace = { ...failingTests, prReviews: () => { if (fail) throw new Error("gh down"); return snap; } };
  const store = new Store(cfg.stateDir);
  const flow = new Process({ ...cfg, githubReviewers: ["senior"] }, both(jira), store, ws, fakeOs);
  const rec = { ...newWorkItem("REQ-1"), state: "CODE_REVIEW" as const, branch: "orqen/req-1", internal: "DEV-9" };
  const state = () => store.get("REQ-1")!.state;
  const rv = (id: string, author: string, state: string, commit = "h1", body = "") => ({ id, author, state, commit, body });

  store.save({ ...rec });                       // no PR yet: it waits
  await flow.review();
  assert.equal(state(), "CODE_REVIEW");

  store.save({ ...rec, artifacts: { devel_pr: "https://example.test/pr/7" } });
  fail = true; await flow.review(); assert.equal(state(), "CODE_REVIEW");   // gh fails: waits, does not block
  fail = false;
  snap = { head: "h1", reviews: [rv("1", "intruso", "APPROVED"), rv("2", "senior", "APPROVED", "h0"), rv("3", "senior", "COMMENTED")] };
  await flow.review(); assert.equal(state(), "CODE_REVIEW");   // not authorized / stale head / not decisive

  snap = { head: "h1", reviews: [rv("4", "senior", "CHANGES_REQUESTED", "h1", "Validar el rango de fechas")] };
  await flow.review();
  assert.equal(state(), "DEVELOPMENT");
  assert.deepEqual(store.get("REQ-1")!.feedback, [{ from: "senior", rejection: "Validar el rango de fechas" }]);
  assert.match(jira.last("DEV-9"), /Changes requested on the PR by senior/);

  // back in CODE_REVIEW on the same head: the already handled review is not applied again; a new approval is
  store.save({ ...store.get("REQ-1")!, state: "CODE_REVIEW" });
  await flow.review(); assert.equal(state(), "CODE_REVIEW");
  snap = { head: "h2", reviews: [rv("4", "senior", "CHANGES_REQUESTED", "h1"), rv("5", "senior", "APPROVED", "h2")] };
  await flow.review();
  assert.equal(state(), "DELIVERY");
  assert.match(jira.last("DEV-9"), /PR approved by senior/);
});

test("CODE_REVIEW: changes requested win over approvals and an empty APPROVERS_CODE accepts any reviewer", async () => {
  const { jira, cfg } = setup();
  jira.issues["DEV-9"] = { title: "internal ticket" }; jira.coms["DEV-9"] = [];
  const reviews = [
    { id: "1", author: "ana", state: "APPROVED", commit: "h", body: "" },
    { id: "2", author: "beto", state: "CHANGES_REQUESTED", commit: "h", body: "" },
  ];
  const ws: Workspace = { ...failingTests, prReviews: () => ({ head: "h", reviews }) };
  const store = new Store(cfg.stateDir);
  const flow = new Process({ ...cfg, githubReviewers: [] }, both(jira), store, ws, fakeOs);
  store.save({ ...newWorkItem("REQ-1"), state: "CODE_REVIEW", branch: "orqen/req-1", internal: "DEV-9", artifacts: { devel_pr: "https://example.test/pr/7" } });
  await flow.review();
  assert.equal(store.get("REQ-1")!.state, "DEVELOPMENT");
  assert.match(store.get("REQ-1")!.feedback[0].rejection!, /Changes requested on the PR/);   // empty body: points to the PR
});

test("pr: sends the branch to the devel branch, records the explanation and is idempotent", async () => {
  const { p, jira, cfg } = setup();
  jira.issues["DEV-9"] = { title: "internal ticket" };
  jira.coms["DEV-9"] = [];
  const calls: string[] = [];
  let cmd = "", branch = "main";
  const ws: Workspace = {
    ...failingTests, currentBranch: () => branch,
    commit: () => { calls.push("commit"); return true; }, push: () => { calls.push("push"); },
    openPr: (vars, c) => { cmd = `${c}|${vars.base}|${vars.body}`; calls.push("pr"); return "https://example.test/pr/7"; },
  };
  const store = new Store(cfg.stateDir);
  const flow = new Process(cfg, both(jira), store, ws, fakeOs);
  const rec = newWorkItem("REQ-1");
  store.save({ ...rec, state: "DEVELOPMENT", branch: "orqen/req-1" });
  assert.throws(() => flow.prInfo("REQ-1"), /once development is done/);
  store.save({ ...rec, state: "CODE_REVIEW", branch: "orqen/req-1", internal: "DEV-9" });
  assert.equal(flow.prInfo("REQ-1").base, "desarrollo");
  await assert.rejects(flow.pr("REQ-1", "corto"), /too short/);

  const body = "## Qué cambió\nSe agregó la exportación a CSV.\n\n## Cómo verificarlo\nProbar la pantalla de reportes y descargar el archivo.";
  // on another branch: fails before writing, committing or pushing anything
  await assert.rejects(flow.pr("REQ-1", body), /not on the request branch "orqen\/req-1"/);
  assert.deepEqual(calls, []);
  assert.equal(existsSync(join(cfg.factoryDir, "REQ-1", "round-1", "devel-pr.md")), false);

  branch = "orqen/req-1";
  const r = await flow.pr("REQ-1", body);
  assert.deepEqual([r.created, r.url, r.base], [true, "https://example.test/pr/7", "desarrollo"]);
  assert.deepEqual(calls, ["commit", "push", "pr"]);
  assert.ok(cmd.endsWith("|desarrollo|orqen/work/REQ-1/round-1/devel-pr.md"));
  assert.match(readFileSync(join(cfg.factoryDir, "REQ-1", "round-1", "devel-pr.md"), "utf8"), /exportación a CSV/);
  assert.match(jira.last("REQ-1"), /PR to \*desarrollo\*/);
  assert.match(jira.last("DEV-9"), /PR to \*desarrollo\*/);

  const again = await flow.pr("REQ-1", body);   // the PR already exists: only pushes
  assert.equal(again.created, false);
  assert.deepEqual(calls, ["commit", "push", "pr", "commit", "push"]);
});

test("analysis cannot advance when not ready or while customer questions remain", async () => {
  for (const output of [ANALYSIS_OK({ ready: false, analyst_ok: false }), ANALYSIS_OK({ open_questions: ["Which format?"] })]) {
    const { p, est, jira } = setup();
    await p.analyze("REQ-1", "agent", "Analyst");
    const result = await p.complete("REQ-1", output, "agent");
    assert.equal(result.ok, false);
    assert.equal(est().state, "ANALYSIS");
    assert.equal(jira.created.length, 0);
  }
});
