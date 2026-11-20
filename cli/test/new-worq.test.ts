/** `orqen new_worq`: no client request; the issue is created in the connector in use, the worq is born in DEVELOPMENT and closes when its PR is merged. */
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
import { FakeTracker, testConnectors } from "./fakes.ts";

const os: OpenSpecApi = {
  newChange: (id) => id, exists: () => false, dir: (id) => id, validate: () => ({ ok: true, problems: [] }), planningComplete: () => true,
  tasks: () => [], scenarios: () => [], archive: () => ({ archivedAs: "x", totals: {} }),
};

const BRIEF = {
  description: "Limpiar el módulo de reportes: quitar el código muerto y dejar un solo punto de entrada.",
  acceptance_criteria: ["Dado el módulo de reportes, cuando se importa, entonces expone una sola función pública."],
  plan: ["Quitar el código muerto (1h)", "Unificar el punto de entrada (1h)"], estimated_hours: 2,
};

function setup(pr: { state: "OPEN" | "MERGED" } = { state: "OPEN" }, withIssues = true) {
  const dir = mkdtempSync(join(tmpdir(), "orqen-int-"));
  const cfg = loadConfig({
    stateDir: join(dir, "state"), factoryDir: join(dir, "worqs"), connectors: testConnectors(withIssues), codeReviewGate: "ticket",
    approvers: { analysis: [], code: [], client: [] },
  });
  const ws: Workspace = {
    prepareBranch: () => "orqen/dev-1", currentBranch: () => "orqen/dev-1", commit: () => true, push: () => {}, openPr: () => "https://example.test/pr/1",
    runTests: () => ({ ok: true, output: "ok" }),
    prState: () => ({ state: pr.state, mergedAt: pr.state === "MERGED" ? "2026-11-20T12:00:00Z" : undefined, mergedBy: pr.state === "MERGED" ? "marta" : undefined }),
  };
  const jira = new FakeTracker({ "REQ-1": { title: "Un pedido real" } }, "DEV");
  const tracker = new FakeTracker({});   // the issues connector (DEV-n)
  const store = new Store(cfg.stateDir);
  const connectors = withIssues ? { requests: jira, issues: tracker } : { requests: jira };
  return { cfg, jira, tracker, store, flow: new Process(cfg, connectors, store, ws, os), pr, dir };
}

test("a worq of the team creates its issue in the connector and is born in DEVELOPMENT, with no client request", async () => {
  const { cfg, jira, tracker, store, flow } = setup();
  const r = await flow.newWorq("Limpiar el módulo de reportes", BRIEF, "Ana");
  assert.deepEqual([r.key, r.state], ["DEV-1", "DEVELOPMENT"]);
  const item = store.get("DEV-1")!;
  assert.deepEqual([item.origin, item.lane, item.route, item.issue, item.analyst], ["internal", "direct", "development", undefined, "Ana"]);
  assert.equal(item.lock, undefined);
  assert.deepEqual(jira.coms, { "REQ-1": [] }, "nothing is written on the client's tracker");
  assert.equal(tracker.created.length, 1, "the issue is created in the connector");
  assert.match(tracker.created[0].description, /Acceptance criteria[\s\S]*una sola función pública[\s\S]*Plan/);
  const dir = join(cfg.factoryDir, "DEV-1");
  for (const f of ["round-1/brief.md", "round-1/analysis.md", "state.json"]) assert.ok(existsSync(join(dir, f)), f);
  assert.match(readFileSync(join(dir, "round-1", "analysis.md"), "utf8"), /Quitar el código muerto/);
  assert.equal(tracker.created[0].title, "Limpiar el módulo de reportes");
  assert.equal(JSON.parse(readFileSync(join(dir, "state.json"), "utf8")).origin, "internal");

  // it shows on the board for the developer, with the implement command
  const b = (await flow.board()).find((x) => x.key === "DEV-1")!;
  assert.deepEqual([b.role, b.next[0].command], ["developer", "/orqen:implement DEV-1"]);
  assert.equal(flow.worq(item).internal, true);
  // the second one gets the next number
  assert.equal((await flow.newWorq("Otra tarea interna", BRIEF, "Ana")).key, "DEV-2");
});

test("an invalid brief creates nothing", async () => {
  const { cfg, store, flow } = setup();
  await assert.rejects(flow.newWorq("Algo sin criterios", { description: "x", plan: ["a (1h)"] }, "Ana"), /brief is not valid[\s\S]*acceptance_criteria/);
  await assert.rejects(flow.newWorq("abc", BRIEF, "Ana"), /title/);
  assert.equal(store.get("DEV-1"), undefined);
  assert.equal(existsSync(join(cfg.factoryDir, "DEV-1")), false);
  assert.equal((await flow.newWorq("Ahora sí con criterios", BRIEF, "Ana")).key, "DEV-1", "the failed attempt did not use the number");
});

test("worq of the team: implement, testing, PR and senior review, and it closes when the PR is merged (no delivery, no client)", async () => {
  const pr: { state: "OPEN" | "MERGED" } = { state: "OPEN" };
  const { jira, tracker, store, flow } = setup(pr);
  await flow.newWorq("Limpiar el módulo de reportes", BRIEF, "Ana");

  await flow.take("DEV-1", "implementer");
  assert.deepEqual(await flow.complete("DEV-1", { completed: true, changes_summary: "Listo.", modified_files: ["a.ts"], added_tests: ["a.test.ts"] }, "implementer"), { ok: true, next: "TESTING" });
  await flow.take("DEV-1", "tester");
  const t = await flow.complete("DEV-1", {
    scenarios: [{ requirement: "Acceptance criterion", scenario: BRIEF.acceptance_criteria[0], covered: true, test: "a.test.ts::unica" }],
    failure_diagnosis: "", suggestions: [], coverage_ok: true,
  }, "tester");
  assert.deepEqual(t, { ok: true, next: "CODE_REVIEW" }, "direct lane: no QA");

  const body = "## Qué cambió\nSe quitó el código muerto del módulo de reportes.\n\n## Cómo verificarlo\nCorrer la suite del módulo y revisar el punto de entrada único.";
  assert.equal((await flow.pr("DEV-1", body)).created, true);
  assert.equal((await flow.decide("DEV-1", "approve", "", "Seni")).state, "DELIVERY");
  const wait = flow.boardItem(store.get("DEV-1")!);
  assert.match(wait.next[0].command, /^merge https:\/\/example.test\/pr\/1/);
  assert.doesNotMatch(wait.next.map((n) => n.command).join(" "), /approve/, "nothing to deliver");
  await assert.rejects(flow.take("DEV-1", "delivery"), /worq started by the team: there is no delivery to a client/);

  await flow.review();
  assert.equal(store.get("DEV-1")!.state, "DELIVERY", "still waiting for the merge");
  pr.state = "MERGED";   // a person merges it by hand
  await flow.review();
  assert.equal(store.get("DEV-1")!.state, "CLOSED");
  assert.deepEqual(tracker.finished, [["DEV-1", "completed"]], "its issue is closed with the worq");
  assert.ok(!(await flow.board()).some((x) => x.key === "DEV-1"), "closed: it leaves the board");
  assert.deepEqual(jira.coms, { "REQ-1": [] }, "the client's tracker was never touched");
});

test("a worq of the team also closes when a person confirms the merge by hand, and can be cancelled", async () => {
  const { store, flow } = setup();
  await flow.newWorq("Limpiar el módulo de reportes", BRIEF, "Ana");
  await flow.newWorq("Otra tarea interna más", BRIEF, "Ana");
  store.save({ ...store.get("DEV-1")!, state: "DELIVERY", branch: "orqen/dev-1", artifacts: { ...store.get("DEV-1")!.artifacts, devel_pr: "https://example.test/pr/1" } });
  await flow.confirmMerge("DEV-1", "Marta");
  assert.equal(store.get("DEV-1")!.state, "CLOSED");
  const c = await flow.cancel("DEV-2", "Ya no hace falta, lo cubre otra tarea", "Ana");
  assert.equal(c.state, "CANCELLED");
});

test("another machine with no record finds the worq by its issue label and reads it from the issues connector", async () => {
  const a = setup();
  await a.flow.newWorq("Limpiar el módulo de reportes", BRIEF, "Ana");
  assert.ok(a.tracker.issues["DEV-1"].labels!.includes("orqen-worq"), "the issue carries the worq label");
  a.tracker.issues["DEV-1"].labels!.push("orqen-state-development");   // the state label orqen mirrors on the issue

  // machine B: same connectors, its own empty state and no snapshot of the branch
  const dir = mkdtempSync(join(tmpdir(), "orqen-int-b-"));
  const cfg = loadConfig({
    stateDir: join(dir, "state"), factoryDir: join(dir, "worqs"), connectors: testConnectors(), codeReviewGate: "ticket",
    approvers: { analysis: [], code: [], client: [] },
  });
  const ws: Workspace = { prepareBranch: () => "x", currentBranch: () => "x", commit: () => true, push: () => {}, openPr: () => "", runTests: () => ({ ok: true, output: "" }) };
  const b = new Process(cfg, { requests: a.jira, issues: a.tracker }, new Store(cfg.stateDir), ws, os);
  const item = (await b.board()).find((x) => x.key === "DEV-1");
  assert.ok(item, "it is listed on machine B");
  assert.deepEqual([item.state, item.recovered, item.title], ["DEVELOPMENT", "label", "Limpiar el módulo de reportes"], "read from the issues connector");
  assert.match(item.next[0].command, /git fetch origin orqen\/dev-1/);
  assert.equal((await b.peek("DEV-1"))?.origin, "internal", "known as a worq of the team");
  assert.deepEqual(a.jira.coms, { "REQ-1": [] }, "the requests connector is not touched");
});

test("without an issues connector the issue is created in the requests one", async () => {
  const { jira, flow } = setup({ state: "OPEN" }, false);
  const r = await flow.newWorq("Limpiar el módulo de reportes", BRIEF, "Ana");
  assert.equal(r.key, "DEV-1");
  assert.equal(jira.created.length, 1);
  assert.equal(r.url, "https://tickets.example.test/DEV-1");
});
