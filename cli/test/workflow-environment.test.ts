/** The workflow manages environments using orqen/config.yaml. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../src/workflow/config.ts";
import type { OpenSpecApi } from "../src/workflow/openspec.ts";
import { Process } from "../src/workflow/process.ts";
import { Store } from "../src/workflow/store.ts";
import { GitWorkspace, type Workspace } from "../src/workflow/workspace.ts";
import { FakeJira } from "./fakes.ts";

const fakeOs: OpenSpecApi = {
  newChange: (id) => id, exists: () => true, dir: (id) => id,
  validate: () => ({ ok: true, problems: [] }), planningComplete: () => true,
  tasks: () => [], scenarios: () => [], archive: () => ({ archivedAs: "x", totals: {} }),
};

test("development manages its environment and testing starts apps, runs the suite, and tears down", async () => {
  const pasos: string[] = [];
  const ws: Workspace = {
    prepareBranch: () => "rec/rec-1", commit: () => true, push: () => {}, openPr: () => "",
    startEnvironment: (apps) => { pasos.push(`levantar(${apps ? "apps" : "servicios"})`); return { ok: true, detail: "Entorno ready.", variables: { DATABASE_URL: "x" }, commands: { unitarios: "orqen env test unitarios" } }; },
    stopEnvironment: () => { pasos.push("bajar"); },
    runTests: () => { pasos.push("tests"); return { ok: true, output: "" }; },
  };
  const dir = mkdtempSync(join(tmpdir(), "orqen-ent-"));
  const cfg = loadConfig({ repoPath: dir, stateDir: join(dir, "estado"), factoryDir: join(dir, "factory"), jql: "x", jiraTransitions: {}, approvers: { analysis: [], code: [], client: [] } });
  const p = new Process(cfg, new FakeJira({ "REC-1": { title: "Ajuste" } }), new Store(cfg.stateDir), ws, fakeOs);
  await p.review();
  await p.analyze("REC-1", "a", "Ana");
  await p.complete("REC-1", {
    summary: "Adjust rounding for the invoice total.", type: "bug", acceptance_criteria: ["c"], affected_capabilities: [], open_questions: [],
    risks: [], ready: true, analyst_ok: true, route: "development", lane: "direct", lane_rationale: "Un solo componente, bajo riesgo.", plan: ["Ajustar (1h)"], estimated_hours: 1,
  }, "a");
  assert.deepEqual(pasos, [], "analysis starts no services");

  const dev = await p.take("REC-1", "impl");
  assert.deepEqual(pasos, ["levantar(servicios)"]);
  assert.equal((dev.context as any).environment.ok, true);
  assert.equal((dev.context as any).environment.commands.unitarios, "orqen env test unitarios");
  assert.deepEqual(await p.complete("REC-1", { completed: true, changes_summary: "x", modified_files: [], added_tests: [] }, "impl"), { ok: true, next: "TESTING" });
  assert.deepEqual(pasos, ["levantar(servicios)", "bajar"]);

  await p.take("REC-1", "qa");
  assert.deepEqual(pasos, ["levantar(servicios)", "bajar", "levantar(apps)", "tests", "bajar"]);
});

test("GitWorkspace runs configured tests with environment variables and skips Docker without services", () => {
  const dir = mkdtempSync(join(tmpdir(), "orqen-ws-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  writeFileSync(join(dir, "docker-compose.orqen.yml"), "name: x\nservices: {}\n");
  const cfg = loadConfig({
    repoPath: dir, stateDir: join(dir, "estado"),
    environment: {
      compose: "docker-compose.orqen.yml", variables: { SALUDO: "hola" },
      preparar: [`node -e "require('fs').writeFileSync('preparado.txt', process.env.SALUDO)"`],
      migrar: [`node -e "require('fs').writeFileSync('migrado.txt', '1')"`], seed: [],
      tests: { unitarios: `node -e "process.exit(process.env.SALUDO === 'hola' ? 0 : 1)"`, e2e: `node -e "console.log('e2e failed'); process.exit(1)"`, visual: null },
    },
  });
  const ws = new GitWorkspace(cfg);
  const e = ws.startEnvironment(true);
  assert.equal(e.ok, true, e.detail);
  assert.match(e.detail, /dependencies installed, migrations applied/);
  assert.doesNotMatch(e.detail, /servicios/);
  assert.equal(readFileSync(join(dir, "preparado.txt"), "utf8"), "hola");
  assert.ok(existsSync(join(dir, "migrado.txt")));
  assert.deepEqual(e.commands, { unitarios: "orqen env test unitarios", e2e: "orqen env test e2e" });

  const r = ws.runTests();
  assert.equal(r.ok, false);
  assert.match(r.output, /tests unitarios: .* → OK/);
  assert.match(r.output, /tests e2e: .* → FAILED[\s\S]*e2e failed/);
  ws.stopEnvironment();   // Teardown needs no Docker when there are no services.

  // The agent context identifies the failed step.
  const roto = new GitWorkspace({ ...cfg, environment: { ...cfg.environment!, preparar: [`node -e "console.error('network unavailable'); process.exit(1)"`] } });
  const f = roto.startEnvironment(false);
  assert.equal(f.ok, false);
  assert.match(f.detail, /Failed/);
  assert.match(f.output!, /network unavailable/);
});
