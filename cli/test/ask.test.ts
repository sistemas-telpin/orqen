/** `orqen ask` / `orqen conversation` (SIS-6022): the conversation file, what a transition commits and the WAITING_CLIENT warning. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { IGNORAR_GIT } from "../src/lib/kit.ts";
import { loadConfig } from "../src/workflow/config.ts";
import { Factory } from "../src/workflow/factory.ts";
import type { OpenSpecApi } from "../src/workflow/openspec.ts";
import { Process } from "../src/workflow/process.ts";
import { Store, newWorkItem } from "../src/workflow/store.ts";
import { GitWorkspace, type Workspace } from "../src/workflow/workspace.ts";
import { both, FakeTracker, testConnectors } from "./fakes.ts";

const os: OpenSpecApi = {
  newChange: (id) => id, exists: () => false, dir: (id) => id, validate: () => ({ ok: true, problems: [] }), planningComplete: () => true,
  tasks: () => [], scenarios: () => [], archive: () => ({ archivedAs: "x", totals: {} }),
};
const ws: Workspace = {
  prepareBranch: () => "orqen/req-1", currentBranch: () => "orqen/req-1", commit: () => true, push: () => {}, openPr: () => "",
  runTests: () => ({ ok: true, output: "" }),
};

function setup(state: "ACCEPTANCE" | "WAITING_CLIENT" | "DEVELOPMENT") {
  const dir = mkdtempSync(join(tmpdir(), "orqen-ask-"));
  const cfg = loadConfig({ stateDir: join(dir, "state"), factoryDir: join(dir, "worqs"), connectors: testConnectors(false), approvers: { analysis: [], code: [], client: [] } });
  const jira = new FakeTracker({ "REQ-1": { title: "Algo", reportedBy: "ana" } });
  const store = new Store(cfg.stateDir);
  store.save({ ...newWorkItem("REQ-1"), state, branch: "orqen/req-1" });
  const file = join(cfg.factoryDir, "REQ-1", "conversation.json");
  return { flow: new Process(cfg, both(jira, false), store, ws, os), store, jira, file };
}

test("conversation.json is written only by `ask` and `conversation`, never by reading comments for the flow", async () => {
  const { flow, jira, file } = setup("ACCEPTANCE");
  jira.human("REQ-1", "client", "un comentario cualquiera");
  await flow.review();   // reads the comments of the gate
  await flow.board();
  assert.equal(existsSync(file), false, "list / review must not touch the checkout");

  const r = await flow.ask("REQ-1", "  ¿Cuál es el formato?  ");
  assert.deepEqual(r, {});
  assert.match(jira.last("REQ-1"), /Question for ana:\n\n¿Cuál es el formato\?$/);
  const saved = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(saved.request, "REQ-1");
  assert.equal(saved.comments.at(-1).body.endsWith("¿Cuál es el formato?"), true);

  jira.human("REQ-1", "client", "En Excel.");
  assert.equal((await flow.conversation("REQ-1")).at(-1)!.body, "En Excel.");
  assert.equal(JSON.parse(readFileSync(file, "utf8")).comments.at(-1).body, "En Excel.");
  await assert.rejects(flow.ask("REQ-1", "   "), /question for the requester is required/);
  await assert.rejects(flow.ask("NOPE-1", "hola"), /unknown to orqen on this machine/);
});

test("asking while the worq waits for the client warns that their next comment counts as the answer", async () => {
  const waiting = setup("WAITING_CLIENT");
  const r = await waiting.flow.ask("REQ-1", "Una pregunta aparte");
  assert.match(r.warning!, /waiting for the client's answers[\s\S]*back to ANALYSIS/);
  assert.equal(waiting.store.get("REQ-1")!.state, "WAITING_CLIENT", "the ask itself does not move it");
  waiting.jira.human("REQ-1", "client", "Respuesta");
  await waiting.flow.review();
  assert.equal(waiting.store.get("REQ-1")!.state, "ANALYSIS");   // the warning is true
  assert.deepEqual(await setup("DEVELOPMENT").flow.ask("REQ-1", "Otra pregunta"), {});
});

test("a transition commits only its own worq folder, and never conversation.json (replies of the client)", () => {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), "orqen-commit-")));
  const git = (...a: string[]) => execFileSync("git", a, { cwd: base, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.name", "t");
  git("config", "user.email", "t@t");
  writeFileSync(join(base, "a.txt"), "a");
  git("add", "-A");
  git("commit", "-qm", "init");
  git("checkout", "-q", "-b", "orqen/req-1");
  const cfg = loadConfig({ repoPath: base, stateDir: join(base, "orqen", "state"), factoryDir: join(base, "orqen", "worqs"), connectors: testConnectors(false), approvers: { code: [], client: [] } });
  const fac = new Factory(cfg.factoryDir);
  const reply = [{ id: "1", author: "c", authorName: "Cliente", body: "Mi DNI es 12345678", created: "" }];
  fac.conversation("REQ-2", reply);   // another worq, only in this checkout because someone asked there
  fac.conversation("REQ-1", reply);   // its own conversation
  mkdirSync(join(cfg.factoryDir, "REQ-1"), { recursive: true });
  writeFileSync(join(cfg.factoryDir, "REQ-1", "state.json"), "{}");
  assert.equal(new GitWorkspace(cfg).commit("REQ-1", "registro", { path: join(cfg.factoryDir, "REQ-1"), branch: "orqen/req-1" }), true);
  assert.equal(git("show", "--name-only", "--format=", "HEAD"), "orqen/worqs/REQ-1/state.json");
  assert.match(git("status", "--short", "--untracked-files=all"), /orqen\/worqs\/REQ-1\/conversation\.json[\s\S]*orqen\/worqs\/REQ-2\/conversation\.json/);   // still there, untouched
});

test("installs ignore conversation.json in git", () => {
  assert.ok(IGNORAR_GIT.includes("orqen/worqs/*/conversation.json"));
});
