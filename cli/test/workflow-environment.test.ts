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
    prepareBranch: () => "rec/rec-1", currentBranch: () => "rec/rec-1", commit: () => true, push: () => {}, openPr: () => "",
    startEnvironment: async (all) => { pasos.push(`start(${all ? "all" : "always"})`); return { ok: true, detail: "Entorno ready.", variables: { DATABASE_URL: "x" }, commands: { unitarios: "orqen env test unitarios" } }; },
    stopEnvironment: () => { pasos.push("stop"); },
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
  assert.deepEqual(pasos, ["start(always)"]);
  assert.equal((dev.context as any).environment.ok, true);
  assert.equal((dev.context as any).environment.commands.unitarios, "orqen env test unitarios");
  assert.deepEqual(await p.complete("REC-1", { completed: true, changes_summary: "x", modified_files: [], added_tests: [] }, "impl"), { ok: true, next: "TESTING" });
  assert.deepEqual(pasos, ["start(always)", "stop"]);

  await p.take("REC-1", "qa");
  assert.deepEqual(pasos, ["start(always)", "stop", "start(all)", "tests", "stop"]);
});

test("GitWorkspace starts real processes without Docker, runs tests with the variables, and stops them", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orqen-ws-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  const port = 41000 + Math.floor(Math.random() * 2000);
  // A real HTTP "backend" that takes a moment to start and reads a variable from the environment.
  writeFileSync(join(dir, "server.mjs"), `
import { createServer } from "node:http";
setTimeout(() => createServer((q, r) => r.end(process.env.SALUDO)).listen(${port}, () => console.log("listening")), 600);
`);
  const cfg = loadConfig({
    repoPath: dir, stateDir: join(dir, "estado"),
    environment: {
      procesos: [
        { nombre: "api", comando: "node server.mjs", ruta: ".", puerto: port, cuando: "siempre", espera_seg: 20 },
        { nombre: "front", comando: `node -e "setInterval(()=>{}, 1000); console.log('front ready')"`, ruta: ".", listo_si: "front ready", cuando: "e2e", espera_seg: 20 },
      ],
      variables: { SALUDO: "hola" },
      preparar: [`node -e "require('fs').writeFileSync('preparado.txt', process.env.SALUDO)"`],
      migrar: [`node -e "require('fs').writeFileSync('migrado.txt', '1')"`], seed: [],
      tests: {
        unitarios: `node -e "fetch('http://127.0.0.1:${port}').then(r=>r.text()).then(t=>process.exit(t==='hola'?0:1))"`,
        e2e: `node -e "console.log('e2e failed'); process.exit(1)"`, visual: null,
      },
    },
  });
  const ws = new GitWorkspace(cfg);
  const e = await ws.startEnvironment(false);
  try {
    assert.equal(e.ok, true, `${e.detail}\n${e.output ?? ""}`);
    assert.match(e.detail, /dependencies installed; processes: api \(:\d+\); migrations applied/);
    assert.doesNotMatch(e.detail, /front/, "the frontend only runs for e2e");
    assert.equal(readFileSync(join(dir, "preparado.txt"), "utf8"), "hola");
    assert.ok(existsSync(join(dir, "migrado.txt")));
    assert.deepEqual(e.commands, { unitarios: "orqen env test unitarios", e2e: "orqen env test e2e" });

    const r = ws.runTests();
    assert.equal(r.ok, false);
    assert.match(r.output, /tests unitarios: .* → OK/);
    assert.match(r.output, /tests e2e: .* → FAILED[\s\S]*e2e failed/);

    const all = await ws.startEnvironment(true);
    assert.match(all.detail, /api \(already running\), front/);
  } finally {
    ws.stopEnvironment();
  }
  const { puertoAbierto } = await import("../src/lib/processes.ts");
  let open = true;
  for (let i = 0; i < 20 && open; i++) { open = await puertoAbierto(port); if (open) await new Promise((r) => setTimeout(r, 200)); }
  assert.equal(open, false, "the backend was stopped");

  // A process that does not start is reported with its log.
  const roto = new GitWorkspace({ ...cfg, environment: { ...cfg.environment!, preparar: [], migrar: [], procesos: [{ nombre: "api", comando: `node -e "console.error('DATABASE_URL missing'); process.exit(1)"`, ruta: ".", puerto: port, cuando: "siempre", espera_seg: 10 }] } });
  const f = await roto.startEnvironment(false);
  assert.equal(f.ok, false);
  assert.match(f.detail, /api exited before it was ready/);
  assert.match(f.output!, /DATABASE_URL missing/);
});
