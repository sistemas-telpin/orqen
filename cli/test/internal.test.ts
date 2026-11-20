/** `orqen new` (internal development): no request and no issue, born in DEVELOPMENT, closed when its PR is merged. */
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

const os: OpenSpecApi = {
  newChange: (id) => id, exists: () => false, dir: (id) => id, validate: () => ({ ok: true, problems: [] }), planningComplete: () => true,
  tasks: () => [], scenarios: () => [], archive: () => ({ archivedAs: "x", totals: {} }),
};

const BRIEF = {
  description: "Limpiar el módulo de reportes: quitar el código muerto y dejar un solo punto de entrada.",
  acceptance_criteria: ["Dado el módulo de reportes, cuando se importa, entonces expone una sola función pública."],
  plan: ["Quitar el código muerto (1h)", "Unificar el punto de entrada (1h)"], estimated_hours: 2,
};

function setup(pr: { state: "OPEN" | "MERGED" } = { state: "OPEN" }) {
  const dir = mkdtempSync(join(tmpdir(), "orqen-int-"));
  const cfg = loadConfig({
    stateDir: join(dir, "state"), factoryDir: join(dir, "worqs"), connectors: testConnectors(), codeReviewGate: "ticket",
    approvers: { analysis: [], code: [], client: [] },
  });
  const ws: Workspace = {
    prepareBranch: () => "orqen/int-1", currentBranch: () => "orqen/int-1", commit: () => true, push: () => {}, openPr: () => "https://example.test/pr/1",
    runTests: () => ({ ok: true, output: "ok" }),
    prState: () => ({ state: pr.state, mergedAt: pr.state === "MERGED" ? "2026-11-20T12:00:00Z" : undefined, mergedBy: pr.state === "MERGED" ? "marta" : undefined }),
  };
  const jira = new FakeTracker({ "REQ-1": { title: "Un pedido real" } });
  const store = new Store(cfg.stateDir);
  return { cfg, jira, store, flow: new Process(cfg, both(jira, false), store, ws, os), pr, dir };
}

test("an internal development is born in DEVELOPMENT with no request, no issue and no call to the tickets systems", async () => {
  const { cfg, jira, store, flow } = setup();
  const r = await flow.newInternal("Limpiar el módulo de reportes", BRIEF, "Ana");
  assert.deepEqual([r.key, r.state], ["INT-1", "DEVELOPMENT"]);
  const item = store.get("INT-1")!;
  assert.deepEqual([item.origin, item.lane, item.route, item.issue, item.analyst], ["internal", "direct", "development", undefined, "Ana"]);
  assert.equal(item.lock, undefined);
  assert.deepEqual(jira.coms, { "REQ-1": [] }, "nothing is written on the client's tracker");
  const dir = join(cfg.factoryDir, "INT-1");
  for (const f of ["ticket.json", "round-1/brief.md", "round-1/analysis.md", "state.json"]) assert.ok(existsSync(join(dir, f)), f);
  assert.match(readFileSync(join(dir, "round-1", "analysis.md"), "utf8"), /Quitar el código muerto/);
  assert.equal(JSON.parse(readFileSync(join(dir, "ticket.json"), "utf8")).title, "Limpiar el módulo de reportes");
  assert.equal(JSON.parse(readFileSync(join(dir, "state.json"), "utf8")).origin, "internal");

  // it shows on the board for the developer, with the implement command
  const b = (await flow.board()).find((x) => x.key === "INT-1")!;
  assert.deepEqual([b.role, b.next[0].command], ["developer", "/orqen:implement INT-1"]);
  assert.equal(flow.worq(item).internal, true);
  // the second one gets the next number
  assert.equal((await flow.newInternal("Otra tarea interna", BRIEF, "Ana")).key, "INT-2");
});

test("an invalid brief creates nothing", async () => {
  const { cfg, store, flow } = setup();
  await assert.rejects(flow.newInternal("Algo sin criterios", { description: "x", plan: ["a (1h)"] }, "Ana"), /brief is not valid[\s\S]*acceptance_criteria/);
  await assert.rejects(flow.newInternal("abc", BRIEF, "Ana"), /title/);
  assert.equal(store.get("INT-1"), undefined);
  assert.equal(existsSync(join(cfg.factoryDir, "INT-1")), false);
  assert.equal((await flow.newInternal("Ahora sí con criterios", BRIEF, "Ana")).key, "INT-1", "the failed attempt did not use the number");
});

test("internal development: implement, testing, PR and senior review, and it closes when the PR is merged (no delivery, no client)", async () => {
  const pr: { state: "OPEN" | "MERGED" } = { state: "OPEN" };
  const { jira, store, flow, cfg } = setup(pr);
  await flow.newInternal("Limpiar el módulo de reportes", BRIEF, "Ana");

  await flow.take("INT-1", "implementer");
  assert.deepEqual(await flow.complete("INT-1", { completed: true, changes_summary: "Listo.", modified_files: ["a.ts"], added_tests: ["a.test.ts"] }, "implementer"), { ok: true, next: "TESTING" });
  await flow.take("INT-1", "tester");
  const t = await flow.complete("INT-1", {
    scenarios: [{ requirement: "Acceptance criterion", scenario: BRIEF.acceptance_criteria[0], covered: true, test: "a.test.ts::unica" }],
    failure_diagnosis: "", suggestions: [], coverage_ok: true,
  }, "tester");
  assert.deepEqual(t, { ok: true, next: "CODE_REVIEW" }, "direct lane: no QA");

  const body = "## Qué cambió\nSe quitó el código muerto del módulo de reportes.\n\n## Cómo verificarlo\nCorrer la suite del módulo y revisar el punto de entrada único.";
  assert.equal((await flow.pr("INT-1", body)).created, true);
  assert.equal((await flow.decide("INT-1", "approve", "", "Seni")).state, "DELIVERY");
  const wait = flow.boardItem(store.get("INT-1")!);
  assert.match(wait.next[0].command, /^merge https:\/\/example.test\/pr\/1/);
  assert.doesNotMatch(wait.next.map((n) => n.command).join(" "), /approve/, "nothing to deliver");
  await assert.rejects(flow.take("INT-1", "delivery"), /internal development: there is no delivery to a client/);

  await flow.review();
  assert.equal(store.get("INT-1")!.state, "DELIVERY", "still waiting for the merge");
  pr.state = "MERGED";   // a person merges it by hand
  await flow.review();
  assert.equal(store.get("INT-1")!.state, "CLOSED");
  assert.equal(JSON.parse(readFileSync(join(cfg.factoryDir, "INT-1", "ticket.json"), "utf8")).status, "Cerrado");
  assert.ok(!(await flow.board()).some((x) => x.key === "INT-1"), "closed: it leaves the board");
  assert.deepEqual(jira.coms, { "REQ-1": [] }, "the client's tracker was never touched");
});

test("an internal development also closes when a person confirms the merge by hand, and can be cancelled", async () => {
  const { store, flow } = setup();
  await flow.newInternal("Limpiar el módulo de reportes", BRIEF, "Ana");
  await flow.newInternal("Otra tarea interna más", BRIEF, "Ana");
  store.save({ ...store.get("INT-1")!, state: "DELIVERY", branch: "orqen/int-1", artifacts: { ...store.get("INT-1")!.artifacts, devel_pr: "https://example.test/pr/1" } });
  await flow.confirmMerge("INT-1", "Marta");
  assert.equal(store.get("INT-1")!.state, "CLOSED");
  const c = await flow.cancel("INT-2", "Ya no hace falta, lo cubre otra tarea", "Ana");
  assert.equal(c.state, "CANCELLED");
});
