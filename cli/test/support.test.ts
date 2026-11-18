/** SUPPORT stage (optional): the support person answers the client or escalates to the analyst. */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../src/workflow/config.ts";
import type { OpenSpecApi } from "../src/workflow/openspec.ts";
import { Process } from "../src/workflow/process.ts";
import { Store } from "../src/workflow/store.ts";
import type { Workspace } from "../src/workflow/workspace.ts";
import { both, FakeTracker, testConnectors } from "./fakes.ts";

const fakeOs: OpenSpecApi = {
  newChange: (id) => id, exists: () => false, dir: (id) => id,
  validate: () => ({ ok: true, problems: [] }), planningComplete: () => true,
  tasks: () => [], scenarios: () => [], archive: () => ({ archivedAs: "x", totals: {} }),
};
const ws: Workspace = {
  prepareBranch: () => "orqen/req-1", currentBranch: () => "orqen/req-1", commit: () => true, push: () => {}, openPr: () => "",
  runTests: () => ({ ok: true, output: "" }),
};

function setup(supportStage = true) {
  const dir = mkdtempSync(join(tmpdir(), "rec-s-"));
  const cfg = loadConfig({
    stateDir: join(dir, "state"), factoryDir: join(dir, "factory"), connectors: testConnectors(), supportStage,
    approvers: { analysis: ["analyst"], code: ["senior"], client: ["client"] },
  });
  const jira = new FakeTracker({ "REQ-1": { title: "No puedo exportar" } });
  const store = new Store(cfg.stateDir);
  return { cfg, dir, p: new Process(cfg, both(jira), store, ws, fakeOs), jira, est: () => store.get("REQ-1")! };
}

const RESOLVED = (over: Record<string, unknown> = {}) => ({
  summary: "El cliente no encuentra el botón de exportar.", checked: ["issue y comentarios", "pedidos similares"],
  outcome: "resolved", client_response: "El botón está en Reportes > Exportar; le dejamos los pasos.", support_ok: true, ...over,
});
const ESCALATE = (over: Record<string, unknown> = {}) => ({
  summary: "El cliente pide exportar a un formato nuevo.", checked: ["issue y comentarios"],
  outcome: "escalate", escalation_summary: "No existe el formato pedido: hay que definir alcance con el cliente.", support_ok: true, ...over,
});

test("support off: NEW is listed for the analyst, but `support` still works on a particular request", async () => {
  const { p, est } = setup(false);
  assert.deepEqual((await p.review()).map((x) => [x.state, x.for]), [["NEW", "analyst"]]);
  await p.support("REQ-1", "codex", "Sofi");
  assert.equal(est().state, "SUPPORT");
  assert.deepEqual((await p.review()).map((x) => [x.state, x.for]), [["SUPPORT", "support"]]);
  assert.deepEqual(await p.complete("REQ-1", RESOLVED(), "codex"), { ok: true, next: "ACCEPTANCE" });
});

test("support on: NEW is for support, the person leads, an agent cannot take it", async () => {
  const { p, jira, est } = setup();
  assert.deepEqual((await p.review()).map((x) => [x.state, x.for]), [["NEW", "support"]]);
  await assert.rejects(p.take("REQ-1", "x"), /has no work/);

  const { context } = await p.support("REQ-1", "codex", "Sofi");
  assert.equal(est().state, "SUPPORT");
  assert.equal(est().supporter, "Sofi");
  assert.equal(context.supporter, "Sofi");
  assert.match(jira.coms["REQ-1"][0].body, /Sofi \(support\) is handling/);
  await assert.rejects(p.take("REQ-1", "codex"), /driven by a person/);
  await assert.rejects(p.support("REQ-1", "claude", "Beto"), /already taken by "codex"/);
  assert.deepEqual((await p.review()).map((x) => [x.state, x.for, x.takenBy]), [["SUPPORT", "support", "codex"]]);
});

test("support resolves: needs the person's OK and the reply; goes to ACCEPTANCE with no issue; the client confirms", async () => {
  const { p, jira, est, dir, cfg } = setup();
  await p.support("REQ-1", "codex", "Sofi");

  for (const [bad, msg] of [
    [RESOLVED({ support_ok: false }), /support_ok/],
    [RESOLVED({ client_response: "ok" }), /client_response/],
    [RESOLVED({ checked: [] }), /checked/],
  ] as const) {
    const r = await p.complete("REQ-1", bad, "codex");
    assert.equal(r.ok, false);
    assert.match(JSON.stringify(r), msg);
  }
  assert.equal(est().state, "SUPPORT");

  const r = await p.complete("REQ-1", RESOLVED(), "codex");
  assert.deepEqual(r, { ok: true, next: "ACCEPTANCE" });
  assert.equal(est().issue, undefined);
  assert.equal(jira.created.length, 0);
  assert.match(jira.last("REQ-1"), /Reportes > Exportar/);
  assert.match(jira.last("REQ-1"), /Answered by support \(Sofi\)/);
  const md = readFileSync(join(cfg.factoryDir, "REQ-1", "round-1", "support.md"), "utf8");
  assert.match(md, /Outcome:\*\* resolved/);
  assert.ok(existsSync(join(cfg.factoryDir, "REQ-1", "round-1", "support.json")));

  jira.human("REQ-1", "client", "/approve");
  await p.review();
  assert.equal(est().state, "CLOSED");
  assert.ok(dir);
});

test("support resolves but the client rejects: new analysis round with the analyst", async () => {
  const { p, jira, est } = setup();
  await p.support("REQ-1", "codex", "Sofi");
  await p.complete("REQ-1", RESOLVED(), "codex");
  jira.human("REQ-1", "client", "/reject sigue sin aparecer el botón");
  await p.review();
  assert.equal(est().state, "ANALYSIS");
  assert.equal(est().round, 2);
  const { context } = await p.analyze("REQ-1", "codex", "Ana");
  assert.equal(context.human_feedback[0].rejection, "sigue sin aparecer el botón");
});

test("support escalates: the analyst continues with what support found", async () => {
  const { p, jira, est } = setup();
  await p.support("REQ-1", "codex", "Sofi");
  assert.match(JSON.stringify(await p.complete("REQ-1", ESCALATE({ escalation_summary: "corto" }), "codex")), /escalation_summary/);

  const r = await p.complete("REQ-1", ESCALATE({ client_response: "Estamos revisando su pedido, le escribimos pronto." }), "codex");
  assert.deepEqual(r, { ok: true, next: "ANALYSIS" });
  assert.match(jira.last("REQ-1"), /Estamos revisando/);
  assert.match(jira.last("REQ-1"), /Escalated to analysis/);
  assert.equal(est().supporter, "Sofi");

  assert.deepEqual((await p.review()).map((x) => [x.state, x.for]), [["ANALYSIS", "analyst"]]);
  await assert.rejects(p.support("REQ-1", "codex", "Sofi"), /escalated to the analyst/);
  const { context } = await p.analyze("REQ-1", "claude", "Ana");
  assert.equal(est().state, "ANALYSIS");
  assert.equal(context.previous_stages.SUPPORT.outcome, "escalate");
  assert.match(context.previous_stages.SUPPORT.escalation_summary, /definir alcance/);
});

test("an analyst can take a NEW request directly, or one in SUPPORT that nobody is working", async () => {
  const a = setup();
  await a.p.analyze("REQ-1", "claude", "Ana");
  assert.equal(a.est().state, "ANALYSIS");

  const b = setup();
  await b.p.support("REQ-1", "codex", "Sofi");
  await assert.rejects(b.p.analyze("REQ-1", "claude", "Ana"), /already taken by "codex"/);
  b.p.release("REQ-1");
  await b.p.analyze("REQ-1", "claude", "Ana");
  assert.equal(b.est().state, "ANALYSIS");
  assert.equal(b.est().analyst, "Ana");
});

test("denied support and analysis claims preserve the responsible person and lock", async () => {
  const { p, est } = setup();
  await p.support("REQ-1", "owner", "Original support");
  const support = structuredClone(est());
  await assert.rejects(p.support("REQ-1", "other", "Replacement support"), /already taken/);
  assert.deepEqual(est(), support);
  await assert.rejects(p.analyze("REQ-1", "other", "Replacement analyst"), /already taken/);
  assert.deepEqual(est(), support);
  p.release("REQ-1");
  await p.analyze("REQ-1", "owner", "Original analyst");
  const analysis = structuredClone(est());
  await assert.rejects(p.analyze("REQ-1", "other", "Replacement analyst"), /already taken/);
  assert.deepEqual(est(), analysis);
});
