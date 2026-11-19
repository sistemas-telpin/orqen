/** The interactive tutorial's practice: local tickets, the chat with the client and the client played by an LLM. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LocalTracker } from "../src/connectors/local.ts";
import { parseTeamComment, readClientChat, replyToClient } from "../src/commands/client-chat.ts";

const CLI = join(import.meta.dirname, "..", "dist", "index.js");
const run = (cwd: string, args: string[], env: Record<string, string> = {}, input?: string) =>
  execFileSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8", input, env: { ...process.env, ...env, NO_COLOR: "1" }, stdio: ["pipe", "pipe", "pipe"] });

test("local tickets: pending, comments with the orqen mark, state label and closing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orqen-local-"));
  const t = new LocalTracker({ kind: "local", dir, prefix: "TUT", transitions: {} });
  t.write({ key: "TUT-1", title: "Filtro", description: "Quiero filtrar", reportedBy: "Ana", status: "Abierto", labels: [], created: "", comments: [] });
  assert.deepEqual(await t.pending(), ["TUT-1"]);
  await t.comment("TUT-1", "Mateo started analyzing this request.");
  t.addComment("TUT-1", "ana", "Ana Pérez", "Gracias");
  await replyToClient(t, "TUT-1", "¿Las fechas incluyen los extremos?", "Mateo");
  const chat = await readClientChat(t, "TUT-1");
  assert.deepEqual(chat.messages.map((m) => [m.from, m.author, m.text]), [
    ["client", "Ana", "Quiero filtrar"],
    ["team", "orqen", "Mateo started analyzing this request."],
    ["client", "Ana Pérez", "Gracias"],
    ["team", "Mateo", "¿Las fechas incluyen los extremos?"],
  ]);
  await t.setStateLabel("TUT-1", "CLOSED");
  assert.deepEqual(await t.pending(), []);
  assert.deepEqual(parseTeamComment("[orqen] **Ana María:** hola\nchau"), { author: "Ana María", text: "hola\nchau" });
});

test("orqen practice: creates the project, the request arrives, the team answers and the client (fake LLM) replies once", { skip: process.platform === "win32" && "the fake client is a shell script" }, () => {
  const app = mkdtempSync(join(tmpdir(), "orqen-practice-"));
  const env = { ORQEN_APP_DIR: app, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "t@t" };
  const created = JSON.parse(run(app, ["practice", "create", "--no-openspec", "--json"], env));
  const dir = join(app, "practica", "facturas-demo");
  assert.equal(created.dir, dir);
  assert.equal(created.created, true);
  assert.ok(existsSync(join(dir, "orqen", "config.yaml")));
  assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" }).trim(), "", "everything committed");
  assert.match(execFileSync("git", ["ls-remote", "--heads", "origin"], { cwd: dir, encoding: "utf8" }), /refs\/heads\/desarrollo/);
  assert.match(readFileSync(join(dir, "orqen", ".env"), "utf8"), /CODE_REVIEW_GATE=ticket/);
  // idempotent
  assert.equal(JSON.parse(run(app, ["practice", "create", "--json"], env)).created, false);

  assert.equal(JSON.parse(run(dir, ["practice", "request", "1", "--json"], env)).key, "TUT-1");
  const board = JSON.parse(run(dir, ["list", "requests", "--json"], env));
  assert.equal(board[0].key, "TUT-1");

  const fake = join(app, "cliente.sh");
  writeFileSync(fake, "#!/bin/sh\ncat > /dev/null\necho '/approve Sí, las dos incluidas.'\n");
  chmodSync(fake, 0o755);
  const client = { ...env, ORQEN_PRACTICE_CLIENT_CMD: fake };
  // nothing from the team yet: the client does not answer
  assert.equal(JSON.parse(run(dir, ["practice", "client", "TUT-1", "--json"], client)).replied, false);
  run(dir, ["comment", "TUT-1", "-", "--person", "Mateo"], env, "¿Las fechas incluyen los extremos?");
  const r = JSON.parse(run(dir, ["practice", "client", "TUT-1", "--json"], client));
  assert.equal(r.replied, true);
  assert.equal(r.text, "Sí, las dos incluidas.", "no /approve before the delivery");
  assert.equal(JSON.parse(run(dir, ["practice", "client", "TUT-1", "--json"], client)).replied, false, "already answered");
  const chat = JSON.parse(run(dir, ["comments", "TUT-1", "--json"], env));
  assert.deepEqual(chat.messages.slice(1).map((m: { from: string; author: string }) => `${m.from}:${m.author}`), ["team:Mateo", "client:Ana Pérez"]);
});
