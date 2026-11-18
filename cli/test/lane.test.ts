/** Operational route (route=operational): SQL script / restart without OpenSpec or branch. Everything simulated. */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../src/workflow/config.ts";
import type { OpenSpecApi } from "../src/workflow/openspec.ts";
import { Process } from "../src/workflow/process.ts";
import { reviewSql } from "../src/workflow/sql.ts";
import { Store } from "../src/workflow/store.ts";
import type { Workspace } from "../src/workflow/workspace.ts";
import { both, FakeTracker, testConnectors } from "./fakes.ts";

const fakeOs: OpenSpecApi = {
  newChange: (id) => id, exists: () => true, dir: (id) => id,
  validate: () => ({ ok: true, problems: [] }), planningComplete: () => true,
  tasks: () => [], scenarios: () => [], archive: () => ({ archivedAs: "x", totals: {} }),
};

function setup(over: Partial<Parameters<typeof loadConfig>[0]> = {}) {
  let branches = 0;
  const ws: Workspace = {
    prepareBranch: () => { branches++; return "orqen/req-1"; }, currentBranch: () => "orqen/req-1", commit: () => true, push: () => {}, openPr: () => "",
    runTests: () => ({ ok: true, output: "" }),
  };
  const dir = mkdtempSync(join(tmpdir(), "rec-c-"));
  const cfg = loadConfig({
    stateDir: join(dir, "state"), factoryDir: join(dir, "factory"), connectors: testConnectors(),
    approvers: { analysis: ["analyst"], code: ["senior"], client: ["client"], execution: ["dba"] },
    ...over,
  });
  const jira = new FakeTracker({ "REQ-1": { title: "Facturas duplicadas" } });
  const store = new Store(cfg.stateDir);
  return { cfg, jira, branches: () => branches, est: () => store.get("REQ-1")!, p: new Process(cfg, both(jira), store, ws, fakeOs) };
}

const ANALYSIS = (route = "operational", over: Record<string, unknown> = {}) => ({
  summary: "Hay facturas duplicadas que se corrigen con un script.", type: "bug", acceptance_criteria: ["c"],
  affected_capabilities: [], open_questions: [], risks: [], ready: true, analyst_ok: true, route, lane: "direct",
  lane_rationale: "Se corrige con datos, sin tocar código.", plan: ["Ajustar el módulo (1h)"], ...over,
});
const EXEC = (over: Record<string, unknown> = {}) => ({
  summary: "Eliminar las facturas duplicadas del período.", system: "SQL Server PROD", impact: "Borra 12 filas de facturas",
  estimated_rows: 12, sql_script: "DELETE FROM facturas WHERE id IN (SELECT id_dup FROM dup);",
  rollback: "Restaurar desde la tabla facturas_bak_REC1", verification: "SELECT COUNT(*) FROM facturas_dup", risks: [], ...over,
});
const VERIF = (over: Record<string, unknown> = {}) => ({
  verified: true, evidence: "COUNT = 0", client_message: "Ya no hay facturas duplicadas en el período.",
  validation_steps: ["Revisar el listado de facturas"], ...over,
});

async function untilExecution() {
  const t = setup();
  await t.p.review();
  await t.p.analyze("REQ-1", "analyst-bot", "Ana");
  assert.deepEqual(await t.p.complete("REQ-1", ANALYSIS("operational"), "analyst-bot"), { ok: true, next: "EXECUTION" });
  return t;
}

test("full operational route: issue when the analysis closes, no branch, with human approval and application", async () => {
  const { p, jira, est, branches, cfg } = await untilExecution();
  assert.equal(est().state, "EXECUTION");                     // the analyst's OK replaces the analysis gate
  assert.equal(jira.created.length, 1);                       // the issue is born when the analysis closes, here too
  assert.deepEqual(jira.links, [["DEV-1", "REQ-1"]]);

  await p.take("REQ-1");
  assert.equal(branches(), 0);                                // does not touch git

  assert.deepEqual(await p.complete("REQ-1", EXEC()), { ok: true, next: "EXECUTION_APPROVAL" });
  assert.ok(existsSync(join(cfg.factoryDir, "REQ-1", "round-1", "execution", "script.sql")));
  assert.ok(existsSync(join(cfg.factoryDir, "REQ-1", "round-1", "analysis.md")));
  assert.match(jira.last("REQ-1"), /SQL script/);

  jira.human("REQ-1", "pm", "/approve");                      // not an execution approver
  await p.review();
  assert.equal(est().state, "EXECUTION_APPROVAL");
  jira.human("REQ-1", "dba", "/approve");
  await p.review();
  assert.equal(est().state, "APPLICATION");
  assert.equal(jira.created.length, 1);                       // no second issue when authorizing

  jira.human("REQ-1", "dba", "/approve se borraron 12 filas");
  await p.review();
  assert.equal(est().state, "VERIFICATION");
  const { context } = await p.take("REQ-1");
  assert.deepEqual(context.human_feedback, [{ from: "dba", text: "se borraron 12 filas" }]);

  assert.deepEqual(await p.complete("REQ-1", VERIF()), { ok: true, next: "ACCEPTANCE" });
  jira.human("REQ-1", "client", "/approve");
  await p.review();
  assert.equal(est().state, "CLOSED");
});

test("SQL guards: DROP, DELETE without WHERE, trivial WHERE, no rollback", async () => {
  const { p, est } = await untilExecution();
  await p.take("REQ-1");
  for (const sql of ["DROP TABLE facturas;", "DELETE FROM facturas;", "UPDATE facturas SET x = 1;", "DELETE FROM t WHERE 1=1;", "TRUNCATE TABLE t"]) {
    const r = await p.complete("REQ-1", EXEC({ sql_script: sql }));
    assert.equal(r.ok, false, sql);
  }
  assert.equal((await p.complete("REQ-1", EXEC({ rollback: "" }))).ok, false);
  assert.equal((await p.complete("REQ-1", EXEC({ sql_script: undefined }))).ok, false);   // neither script nor steps
  assert.equal((await p.complete("REQ-1", EXEC({ sql_script: undefined, manual_steps: ["Reiniciar el servicio X"] }))).ok, true);
  assert.equal(est().state, "EXECUTION_APPROVAL");
  assert.deepEqual(reviewSql("-- DELETE FROM t\nSELECT 'DROP TABLE x'; UPDATE t SET a=1 WHERE id=3;"), []);
});

test("failed verification goes back to EXECUTION; requires_development goes back to ANALYSIS with a new issue", async () => {
  const { p, jira, est } = await untilExecution();
  await p.take("REQ-1");
  await p.complete("REQ-1", EXEC());
  jira.human("REQ-1", "dba", "/approve"); await p.review();
  jira.human("REQ-1", "dba", "/approve listo"); await p.review();

  await p.take("REQ-1");
  assert.deepEqual(await p.complete("REQ-1", VERIF({ verified: false, evidence: "COUNT = 4", client_message: "", validation_steps: [] })),
    { ok: true, next: "EXECUTION" });

  await p.take("REQ-1");
  await p.complete("REQ-1", EXEC());
  jira.human("REQ-1", "dba", "/approve"); await p.review();
  jira.human("REQ-1", "dba", "/approve listo"); await p.review();
  await p.take("REQ-1");
  assert.deepEqual(await p.complete("REQ-1", VERIF({ verified: false, requires_development: true, evidence: "Reaparecen: bug en el alta" })),
    { ok: true, next: "ANALYSIS" });
  assert.equal(est().route, "development");
  assert.equal(est().issue, undefined);
  assert.deepEqual(est().artifacts.previous_issues, ["DEV-1"]);

  // the analyst re-analyzes, now with a development lane → a development issue is born
  await p.analyze("REQ-1", "analyst-bot", "Ana");
  assert.deepEqual(await p.complete("REQ-1", ANALYSIS("development", { analyst_ok: true }), "analyst-bot"), { ok: true, next: "DEVELOPMENT" });
  assert.equal(est().issue, "DEV-2");
  assert.equal(jira.created[1].route, "development");
});

test("the operational route only allows the direct lane and uses the operational issue type", async () => {
  const t = setup();
  await t.p.analyze("REQ-1", "bot", "Ana");
  const r = await t.p.complete("REQ-1", ANALYSIS("operational", { lane: "light" }), "bot");
  assert.match((r as any).errors.join(), /has no spec/);
  assert.equal(t.jira.created.length, 0);
  await t.p.complete("REQ-1", ANALYSIS("operational"), "bot");
  assert.equal(t.jira.created.length, 1);
  assert.equal(t.jira.created[0].route, "operational");
  assert.deepEqual((t.jira.created[0] as any).labels, ["origin-req-1", "lane-operational"]);
  assert.equal(t.est().issue, "DEV-1");
});
