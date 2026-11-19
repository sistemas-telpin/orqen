/** A request this machine has no record of: recovered from the snapshot in the repository, or (to show it) from the ticket's state label. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../src/workflow/config.ts";
import type { OpenSpecApi } from "../src/workflow/openspec.ts";
import { Process } from "../src/workflow/process.ts";
import { Store } from "../src/workflow/store.ts";
import { GitWorkspace, type Workspace } from "../src/workflow/workspace.ts";
import { both, FakeTracker, testConnectors } from "./fakes.ts";

const os: OpenSpecApi = {
  newChange: (id) => id, exists: () => false, dir: (id) => id, validate: () => ({ ok: true, problems: [] }), planningComplete: () => true,
  tasks: () => [], scenarios: () => [], archive: () => ({ archivedAs: "x", totals: {} }),
};
const noWs: Workspace = {
  prepareBranch: () => "orqen/req-1", currentBranch: () => "orqen/req-1", commit: () => true, push: () => {}, openPr: () => "",
  runTests: () => ({ ok: true, output: "" }),
};
const SNAPSHOT = {
  _note: "x", key: "REQ-1", state: "DEVELOPMENT", round: 2, route: "development", lane: "direct", analyst: "Ana", branch: "orqen/req-1", change: "",
  testingAttempts: 1, questionRounds: 1, lastSeenComment: "42", artifacts: { ANALYSIS: { summary: "Resumen largo del pedido." }, estimated_hours: 3 },
  feedback: [{ from: "client", rejection: "falta X" }], lock: { agent: "someone", since: "2026-01-01T00:00:00Z" }, updated: "2026-11-19T10:00:00Z",
};

function machine(ws: Workspace, labels: string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), "orqen-rec-"));
  const cfg = loadConfig({ stateDir: join(dir, "state"), factoryDir: join(dir, "work"), connectors: testConnectors(false), approvers: { analysis: [], code: [], client: [] } });
  const jira = new FakeTracker({ "REQ-1": { title: "Exportar", labels } });
  const store = new Store(cfg.stateDir);
  return { flow: new Process(cfg, both(jira, false), store, ws, os), store, jira };
}

test("a request this machine does not know is recovered from the snapshot in the repository, and saved here", async () => {
  const { flow, store } = machine({ ...noWs, snapshotOf: (k) => (k === "REQ-1" ? { snapshot: SNAPSHOT, source: "origin/orqen/req-1:orqen/worqs/REQ-1/state.json" } : undefined) });
  assert.equal(store.get("REQ-1"), undefined);
  const b = (await flow.board())[0];
  assert.deepEqual([b.key, b.state, b.lane, b.recovered], ["REQ-1", "DEVELOPMENT", "direct", undefined]);   // full record: not the label fallback
  const saved = store.get("REQ-1")!;
  assert.equal(saved.round, 2);
  assert.equal(saved.testingAttempts, 1);
  assert.equal(saved.lastSeenComment, "42");   // comments already handled are not replayed
  assert.deepEqual(saved.feedback, [{ from: "client", rejection: "falta X" }]);
  assert.equal(saved.artifacts.estimated_hours, 3);
  assert.equal(saved.lock, undefined, "the lock of another machine is not inherited");
  assert.equal((saved as any)._note, undefined);
  assert.match(store.events("REQ-1").at(-1)!.detail, /record recovered from origin\/orqen\/req-1:orqen\/worqs\/REQ-1\/state\.json/);
  // from now on it is local: no more reading of the repository
  let reads = 0;
  const again = machine({ ...noWs, snapshotOf: () => { reads++; return undefined; } });
  again.store.save(saved);
  await again.flow.board();
  assert.equal(reads, 0);
  // the short projections of earlier versions (no artifacts) are not enough to continue from
  const old = machine({ ...noWs, snapshotOf: () => ({ snapshot: { key: "REQ-1", state: "DEVELOPMENT", round: 1 }, source: "x" }) });
  assert.equal(old.flow.item("REQ-1"), undefined);
});

test("without a record or a snapshot, the list shows the state from the ticket's label, read only, and says what to do", async () => {
  const { flow, store } = machine(noWs, ["orqen", "orqen-state-code_review"]);
  const b = (await flow.board())[0];
  assert.deepEqual([b.key, b.state, b.recovered], ["REQ-1", "CODE_REVIEW", "label"]);
  assert.match(b.next[0].command, /^git fetch origin orqen\/req-1$/);
  assert.equal(store.get("REQ-1"), undefined, "nothing is saved from a label: it is only shown");
  assert.equal((await flow.peek("REQ-1"))?.state, "CODE_REVIEW");   // what `orqen status` shows
  assert.equal(await machine(noWs).flow.peek("REQ-1"), undefined);
  assert.equal((await flow.review()).length, 0, "and it is not offered as work to an agent");
  // acting on it needs the full record
  await assert.rejects(flow.take("REQ-1", "implementer"), /has no work for an agent[\s\S]*git fetch origin orqen\/req-1[\s\S]*orqen\/worqs\/REQ-1\/state\.json/);
  // an unknown or unlabeled request is a new one, as before
  assert.equal((await machine(noWs).flow.board())[0].state, "NEW");
  assert.equal((await machine(noWs, ["orqen-state-bogus"]).flow.board())[0].state, "NEW");
});

test("GitWorkspace.snapshotOf reads the newest orqen/worqs/<KEY>/state.json from the working tree or the request branch", () => {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), "orqen-snap-")));
  const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: base, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git("init", "-q", "-b", "main");
  writeFileSync(join(base, "a.txt"), "a");
  git("add", "-A");
  git("commit", "-qm", "init");
  const cfg = loadConfig({ repoPath: base, stateDir: join(base, "orqen", "state"), factoryDir: join(base, "orqen", "worqs"), connectors: testConnectors(false), approvers: { code: [], client: [] } });
  const ws = new GitWorkspace(cfg);
  assert.equal(ws.snapshotOf("REQ-1"), undefined);
  assert.equal(ws.snapshotOf("../etc"), undefined);

  // a teammate's request branch, committed with its snapshot (this checkout has nothing)
  git("checkout", "-q", "-b", "orqen/req-1");
  mkdirSync(join(base, "orqen", "worqs", "REQ-1"), { recursive: true });
  writeFileSync(join(base, "orqen", "worqs", "REQ-1", "state.json"), JSON.stringify({ ...SNAPSHOT, state: "TESTING", updated: "2026-11-19T10:00:00Z" }));
  git("add", "-A");
  git("commit", "-qm", "snapshot");
  git("checkout", "-q", "main");
  assert.equal(existsSync(join(base, "orqen", "worqs", "REQ-1")), false);
  const fromBranch = ws.snapshotOf("REQ-1")!;
  assert.equal(fromBranch.source, "orqen/req-1:orqen/worqs/REQ-1/state.json");
  assert.equal((fromBranch.snapshot as any).state, "TESTING");

  // a newer one in the working tree wins
  mkdirSync(join(base, "orqen", "worqs", "REQ-1"), { recursive: true });
  writeFileSync(join(base, "orqen", "worqs", "REQ-1", "state.json"), JSON.stringify({ ...SNAPSHOT, state: "CODE_REVIEW", updated: "2026-11-19T12:00:00Z" }));
  const fromTree = ws.snapshotOf("REQ-1")!;
  assert.equal(fromTree.source, "orqen/worqs/REQ-1/state.json");
  assert.equal((fromTree.snapshot as any).state, "CODE_REVIEW");
});

test("the snapshot orqen commits with the request is the whole record (without the lock) and recovers it elsewhere", async () => {
  const { Factory } = await import("../src/workflow/factory.ts");
  const dir = mkdtempSync(join(tmpdir(), "orqen-fac-"));
  const item = { ...SNAPSHOT, key: "REQ-1", state: "TESTING" } as any;
  new Factory(dir).record(item, "DEVELOPMENT", "TESTING", "done", "agent");
  const written = JSON.parse(readFileSync(join(dir, "REQ-1", "state.json"), "utf8"));
  assert.equal(written.state, "TESTING");
  assert.equal(written.lock, undefined);
  assert.deepEqual(written.artifacts, SNAPSHOT.artifacts);
  assert.equal(written.lastSeenComment, "42");
  const { flow } = machine({ ...noWs, snapshotOf: () => ({ snapshot: written, source: "snapshot" }) });
  assert.equal(flow.item("REQ-1")!.state, "TESTING");
});
