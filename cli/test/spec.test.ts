/** orqen spec: one neutral model for any SDD tool (OpenSpec, Spec Kit), read from a folder or from a branch. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DirSource, GitSource, parseTasks, providerFor } from "../src/sdd/index.ts";
import { openspec } from "../src/sdd/openspec.ts";
import { speckit } from "../src/sdd/speckit.ts";
import { analysisView } from "../src/commands/spec.ts";
import { newWorkItem } from "../src/workflow/store.ts";

const CLI = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const ID = "ov-buscar-cliente-documento";

function project(files: Record<string, string>) {
  const repo = mkdtempSync(join(tmpdir(), "orqen-spec-"));
  for (const [p, c] of Object.entries(files)) { mkdirSync(dirname(join(repo, p)), { recursive: true }); writeFileSync(join(repo, p), c); }
  const git = (...a: string[]) => execFileSync("git", a, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git("init", "-qb", "main"); git("config", "user.name", "t"); git("config", "user.email", "t@t");
  return { repo, git };
}

const OPENSPEC = {
  [`openspec/changes/${ID}/proposal.md`]: "# Proposal\n\n## Why\nThe sales team needs to find a client by document.\n",
  [`openspec/changes/${ID}/design.md`]: "# Design\n\nExact search by DNI or CUIT.\n",
  [`openspec/changes/${ID}/verification.md`]: "# Verificación del cambio\n\n## Verificado\n- Compila\n",
  [`openspec/changes/${ID}/tasks.md`]: "## 1. Backend\n- [x] 1.1 Implement exact search\n- [X] 1.2 Compile Java\n\n## 2. DB\n- [x] 2.1 Fixture\n\n## 3. E2E\n- [x] 3.1 Bruno cases\n- [x] 3.2 Encoding\n- [ ] 3.3 Run the scenarios on the test DB\n",
  [`openspec/changes/${ID}/specs/clientes/busqueda/spec.md`]: "## ADDED Requirements\n### Requirement: Search by document\n#### Scenario: One client\n",
  "openspec/changes/archive/2026-10-01-old-thing/proposal.md": "# Old\n",
};

test("spec: OpenSpec change → tasks with progress, specs per capability, proposal, design and any other file", () => {
  const { repo } = project(OPENSPEC);
  const src = new DirSource(repo);
  assert.equal(providerFor(src).id, "openspec");
  const v = openspec.read(src, ID)!;
  assert.equal(v.title, "ov buscar cliente documento");
  assert.equal(v.status, "active");
  assert.deepEqual(v.progress, { done: 5, total: 6 });
  assert.deepEqual(v.sections.map((s) => s.title), ["Tasks", "Specs", "Proposal", "Design", "Verification"]);
  const tasks = v.sections[0];
  assert.deepEqual(tasks.groups!.map((g) => [g.title, g.items.length]), [["1. Backend", 2], ["2. DB", 1], ["3. E2E", 3]]);
  assert.equal(v.sections[1].specs![0].name, "clientes/busqueda");
  const list = openspec.list(src);
  assert.deepEqual(list.map((c) => [c.id, c.status]), [[ID, "active"], ["old-thing", "archived"]]);
  assert.equal(openspec.read(src, "old-thing")!.status, "archived");
});

test("spec: a request's branch is read through git when its worktree is not here", () => {
  const { repo, git } = project(OPENSPEC);
  git("checkout", "-qb", "orqen/req-1"); git("add", "-A"); git("commit", "-qm", "spec");
  git("checkout", "-q", "--orphan", "other"); rmSync(join(repo, "openspec"), { recursive: true, force: true });
  const v = openspec.read(new GitSource(repo, "orqen/req-1"), ID)!;
  assert.deepEqual(v.progress, { done: 5, total: 6 });
  assert.equal(v.source, "branch orqen/req-1");
  assert.equal(openspec.read(new DirSource(repo), ID), undefined);
});

test("spec: Spec Kit fits the same model; the provider can be forced", () => {
  const { repo } = project({
    ".specify/memory/constitution.md": "# Constitution\n",
    "specs/001-login/spec.md": "# Feature Specification: Login with SSO\n",
    "specs/001-login/plan.md": "# Plan\n",
    "specs/001-login/tasks.md": "## Phase 1\n- [X] T001 Setup\n- [ ] T002 [P] Login form\n",
    "specs/001-login/contracts/api.yaml": "openapi: 3.0.0\n",
  });
  const src = new DirSource(repo);
  assert.equal(providerFor(src).id, "spec-kit");
  const v = speckit.read(src, "001-login")!;
  assert.equal(v.title, "Login with SSO");
  assert.deepEqual(v.progress, { done: 1, total: 2 });
  assert.deepEqual(v.sections.map((s) => s.title), ["Tasks", "Spec", "Plan", "Contracts"]);
  assert.equal(providerFor(src, "openspec").id, "openspec");
  assert.throws(() => providerFor(src, "nope"), /Unknown SDD provider/);
  assert.deepEqual(parseTasks("- [ ] lone\n"), [{ title: "", items: [{ text: "lone", done: false }] }]);
});

test("spec: a direct-lane request shows its analysis plan in the same shape", () => {
  const it = { ...newWorkItem("REQ-9"), state: "TESTING" as const, lane: "direct" as const, title: "CSV export",
    artifacts: { ANALYSIS: { summary: "Accounting needs a CSV export of invoices.", acceptance_criteria: ["Header row"], plan: ["Write exportCsv", "Test it"], risks: [], open_questions: [], lane: "direct", lane_rationale: "small" } } };
  const v = analysisView(it)!;
  assert.equal(v.provider, "orqen");
  assert.deepEqual(v.progress, { done: 2, total: 2 });
  assert.match(v.sections[1].markdown!, /## Acceptance criteria\n\n- Header row/);
});

test("spec: orqen spec --json for a request (by its key or its issue) and the list", () => {
  const { repo, git } = project(OPENSPEC);
  git("add", "-A"); git("commit", "-qm", "x");
  const state = join(repo, "state"); mkdirSync(state);
  writeFileSync(join(state, "REQ-1.json"), JSON.stringify({ ...newWorkItem("REQ-1"), state: "DEVELOPMENT", change: ID, branch: "orqen/req-1", issue: "DEV-5" }));
  const env = { ...process.env, ORQEN_STATE_DIR: state, NO_COLOR: "1" };
  const run = (...a: string[]) => JSON.parse(execFileSync(process.execPath, [CLI, "spec", ...a, "--json"], { cwd: repo, env, encoding: "utf8" }));
  const one = run("dev-5");
  assert.equal(one.spec.key, "REQ-1");
  assert.deepEqual(one.spec.progress, { done: 5, total: 6 });
  assert.equal(run().changes[0].id, ID);
  assert.equal(run("NOPE-1").spec, null);
});
