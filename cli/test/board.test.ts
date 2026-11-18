/** The 9 steps: `orqen list` (roles and next command), QA on the full lane and the senior's decision. */
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../src/workflow/config.ts";
import type { OpenSpecApi } from "../src/workflow/openspec.ts";
import { Process } from "../src/workflow/process.ts";
import { Store, newWorkItem, type WorkItem } from "../src/workflow/store.ts";
import type { PrReview, Workspace } from "../src/workflow/workspace.ts";
import { FLOW_COMMANDS } from "../src/workflow/board.ts";
import { both, FakeTracker, testConnectors } from "./fakes.ts";

const os: OpenSpecApi = {
  newChange: (id) => id, exists: () => true, dir: (id) => id, validate: () => ({ ok: true, problems: [] }), planningComplete: () => true,
  tasks: () => [], scenarios: () => [], archive: () => ({ archivedAs: "x", totals: {} }),
};

function setup(gate: "github" | "ticket" = "ticket", supportStage = false) {
  const dir = mkdtempSync(join(tmpdir(), "orqen-board-"));
  const cfg = loadConfig({
    stateDir: join(dir, "state"), factoryDir: join(dir, "factory"), connectors: testConnectors(),
    approvers: { analysis: [], code: [], client: [] }, codeReviewGate: gate, supportStage,
  });
  const t = new FakeTracker({ "REQ-1": { title: "Uno" }, "REQ-2": { title: "Dos" } });
  const store = new Store(cfg.stateDir);
  const pr = { head: "c2", reviews: [] as PrReview[], posted: [] as string[] };
  const ws: Workspace = {
    prepareBranch: () => "orqen/req-1", currentBranch: () => "orqen/req-1", commit: () => true, push: () => {}, openPr: () => "",
    runTests: () => ({ ok: true, output: "" }),
    prReviews: () => ({ head: pr.head, reviews: pr.reviews }),
    reviewPr: (_url, action, body) => {
      pr.posted.push(`${action}: ${body}`);
      pr.reviews.push({ id: `r${pr.reviews.length + 1}`, author: "seni", state: action === "approve" ? "APPROVED" : "CHANGES_REQUESTED", commit: pr.head, body });
    },
  };
  const put = (over: Partial<WorkItem>) => store.save({ ...newWorkItem("REQ-1"), route: "development", ...over });
  return { p: new Process(cfg, both(t), store, ws, os), t, store, pr, put, get: () => store.get("REQ-1")! };
}

const REPORT = "Escenarios: alta, baja y modificación, cada uno con su test e2e; la corrida pasó en verde.";

test("list requests: role and next command of each step", async () => {
  const { p, put } = setup();
  let b = await p.board();
  assert.deepEqual(b.map((x) => [x.key, x.role, x.next[0].command]), [["REQ-1", "analyst", "/orqen:analyze REQ-1"], ["REQ-2", "analyst", "/orqen:analyze REQ-2"]]);
  assert.equal(b[0].next[1].command, "/orqen:support REQ-1");

  put({ state: "DEVELOPMENT", issue: "DEV-9", lane: "full", feedback: [{ from: "seni", rejection: "falta validar" }] });
  b = await p.board();
  const one = b.find((x) => x.key === "REQ-1")!;
  assert.equal(one.role, "developer");
  assert.equal(one.work, "DEV-9");
  assert.equal(one.next[0].command, "/orqen:implement DEV-9");
  assert.match(one.returned!, /falta validar/);

  put({ state: "CODE_REVIEW", issue: "DEV-9", lane: "full" });
  assert.equal((await p.board()).find((x) => x.key === "REQ-1")!.next[0].command, "/orqen:pr DEV-9");
  put({ state: "QA_REVIEW", issue: "DEV-9", lane: "full", artifacts: { devel_pr: "https://gh/pr/1" } });
  const qa = (await p.board()).find((x) => x.key === "REQ-1")!;
  assert.deepEqual([qa.role, qa.qa, qa.next[0].command], ["qa", "pending", "/orqen:review DEV-9"]);
  put({ state: "CODE_REVIEW", issue: "DEV-9", lane: "full", artifacts: { devel_pr: "https://gh/pr/1" } });
  const after = (await p.board()).find((x) => x.key === "REQ-1")!;
  assert.deepEqual([after.role, after.qa, after.next[0].command], ["senior", "approved", "/orqen:approve DEV-9"]);
  put({ state: "CODE_REVIEW", issue: "DEV-9", lane: "light", artifacts: { devel_pr: "https://gh/pr/1" } });
  const sr = (await p.board()).find((x) => x.key === "REQ-1")!;
  assert.deepEqual([sr.role, sr.qa, sr.next[0].command], ["senior", undefined, "/orqen:approve DEV-9"]);

  put({ state: "CLOSED" });
  assert.equal((await p.board()).some((x) => x.key === "REQ-1"), false);
  assert.equal((await p.board(true)).some((x) => x.key === "REQ-1"), true);
  assert.deepEqual(FLOW_COMMANDS.map((c) => c.step), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

test("with SUPPORT_STAGE on, new requests go to support first", async () => {
  const { p } = setup("ticket", true);
  const b = await p.board();
  assert.deepEqual([b[0].role, b[0].next[0].command], ["support", "/orqen:support REQ-1"]);
});

test("QA: only the full lane, in QA_REVIEW; approve lets the senior decide, reject goes back to development", async () => {
  const { p, put, get, t } = setup();
  put({ state: "CODE_REVIEW", lane: "light", artifacts: { devel_pr: "https://gh/pr/1" } });
  await assert.rejects(p.qaReview("REQ-1", "approve", "", REPORT, "Quique"), /not waiting for QA/);
  put({ state: "QA_REVIEW", lane: "full", artifacts: { devel_pr: "https://gh/pr/1" } });
  await assert.rejects(p.decide("REQ-1", "approve", "", "Seni"), /the senior decides in CODE_REVIEW/);
  await assert.rejects(p.qaReview("REQ-1", "reject", "corto", REPORT, "Quique"), /what development must fix/);

  await p.qaReview("REQ-1", "approve", "", REPORT, "Quique");
  assert.equal(get().state, "CODE_REVIEW");
  assert.match(t.last("REQ-1"), /QA review #1\*: approved by Quique/);
  assert.equal((await p.board()).find((x) => x.key === "REQ-1")!.role, "senior");

  // the senior asks for changes: back to development; it goes through QA again after testing
  await p.decide("REQ-1", "changes", "Falta el caso de baja lógica.", "Seni");
  assert.equal(get().state, "DEVELOPMENT");
  assert.match(get().feedback.at(-1)!.rejection!, /baja lógica/);

  put({ state: "QA_REVIEW", lane: "full", artifacts: { devel_pr: "https://gh/pr/1" } });
  await p.qaReview("REQ-1", "reject", "Falta el escenario de error.", REPORT, "Quique");
  assert.equal(get().state, "DEVELOPMENT");
  assert.equal(get().feedback.at(-1)!.from, "Quique");
});

test("senior with the ticket gate: approve moves to delivery", async () => {
  const { p, put, get } = setup();
  put({ state: "CODE_REVIEW", lane: "direct", artifacts: { devel_pr: "https://gh/pr/1" } });
  await assert.rejects(p.decide("REQ-1", "changes", "", "Seni"), /Say which changes/);
  await p.decide("REQ-1", "approve", "", "Seni");
  assert.equal(get().state, "DELIVERY");
  const b = (await p.board()).find((x) => x.key === "REQ-1")!;
  assert.deepEqual([b.role, b.next[0].command], ["senior", "/orqen:approve REQ-1"]);
});

test("senior with the GitHub gate: the review goes on the PR and only counts on the last commit", async () => {
  const { p, put, get, pr } = setup("github");
  put({ state: "CODE_REVIEW", lane: "full", artifacts: { devel_pr: "https://gh/pr/1" } });
  // an approval on an older commit does not count
  pr.reviews.push({ id: "old", author: "seni", state: "APPROVED", commit: "c1", body: "" });
  const q = await p.prQueue();
  assert.deepEqual([q[0].review?.status, q[0].qa], ["stale", "approved"]);
  await p.review();
  assert.equal(get().state, "CODE_REVIEW");

  await p.decide("REQ-1", "approve", "", "Seni");
  assert.match(pr.posted[0], /^approve: Approved by Seni/);
  assert.equal(get().state, "DELIVERY");
});
