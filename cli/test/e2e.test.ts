/**
 * Full walkthrough of a request with REAL OpenSpec, REAL git and simulated tickets.
 * The "agent" is this test: it writes the files and the JSON outputs an LLM would write.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CLI_DIR, loadConfig } from "../src/workflow/config.ts";
import { OpenSpecCli } from "../src/workflow/openspec.ts";
import { Process } from "../src/workflow/process.ts";
import { Store } from "../src/workflow/store.ts";
import { GitWorkspace } from "../src/workflow/workspace.ts";
import { both, FakeTracker, testConnectors } from "./fakes.ts";

const OPENSPEC = join(CLI_DIR, "node_modules", ".bin", process.platform === "win32" ? "openspec.cmd" : "openspec");

function tempRepo() {
  const dir = mkdtempSync(join(tmpdir(), "rec-e2e-"));
  const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@t"); git("config", "user.name", "t");
  mkdirSync(join(dir, "openspec", "specs"), { recursive: true });
  mkdirSync(join(dir, "openspec", "changes", "archive"), { recursive: true });
  cpSync(join(CLI_DIR, "..", "template", "openspec", "config.yaml"), join(dir, "openspec", "config.yaml"));
  writeFileSync(join(dir, "openspec", "specs", ".gitkeep"), "");
  writeFileSync(join(dir, "openspec", "changes", "archive", ".gitkeep"), "");
  writeFileSync(join(dir, "export.mjs"), "export const exportCsv = () => '';\n");
  writeFileSync(join(dir, "test.mjs"), "import {exportCsv} from './export.mjs'; if (exportCsv([{n:1}]) !== 'n\\n1') process.exit(1);\n");
  git("add", "-A"); git("commit", "-qm", "init");
  const remote = `${dir}-remote.git`;
  execFileSync("git", ["init", "--bare", "-q", remote]);
  git("remote", "add", "origin", remote);
  git("push", "-q", "-u", "origin", "main");
  return { dir, git, remote };
}

test("full request with real OpenSpec", { skip: !existsSync(OPENSPEC) && "openspec missing" }, async () => {
  const { dir, git, remote } = tempRepo();
  const cfg = loadConfig({
    repoPath: dir, stateDir: join(dir, "..", `state-${Date.now()}`), openspecCmd: OPENSPEC,
    testCommand: "node test.mjs", connectors: testConnectors(), codeReviewGate: "ticket",
    approvers: { analysis: ["analyst"], code: ["senior"], client: ["client"] },
  });
  const jira = new FakeTracker({ "REQ-7": { title: "Exportar facturas a CSV" } });
  const os = new OpenSpecCli(OPENSPEC, dir);
  const p = new Process(cfg, both(jira), new Store(cfg.stateDir), new GitWorkspace(cfg), os);
  const state = () => new Store(cfg.stateDir).get("REQ-7")!.state;

  // ---- ANALYSIS driven by the analyst
  assert.deepEqual((await p.review()).map((x) => [x.key, x.state, x.for]), [["REQ-7", "NEW", "analyst"]]);
  await p.analyze("REQ-7", "analyst-bot", "Ana");
  assert.equal(git("rev-parse", "--abbrev-ref", "HEAD").trim(), "main");   // the grilling does not touch the branch

  // full lane: `orqen lane` creates branch + OpenSpec change
  const c = await p.lane("REQ-7", "full", "analyst-bot");
  const change = c.openspec!.change;
  assert.equal(change, "req-7-exportar-facturas-csv");
  assert.equal(git("rev-parse", "--abbrev-ref", "HEAD").trim(), "orqen/req-7");
  const cdir = join(dir, "openspec", "changes", change);
  const analysis = {
    summary: "El área contable necesita exportar facturas a CSV para conciliar.", type: "feature",
    acceptance_criteria: ["Dado facturas, cuando exporto, entonces obtengo CSV con encabezado"],
    affected_capabilities: ["facturacion-exportacion"], open_questions: [], risks: [], ready: true,
    decisions: [{ question: "¿Solo CSV?", answer: "Sí, Excel queda fuera" }],
    analyst_ok: true, route: "development", lane: "full", lane_rationale: "Capacidad nueva con contrato hacia contabilidad.",
    spec: { change, summary: "Exportación de facturas a CSV.", assumptions: [] },
  };

  // without artifacts → rejected by OpenSpec; nothing was created in Jira
  let r = await p.complete("REQ-7", analysis, "analyst-bot");
  assert.equal(r.ok, false);
  assert.equal(jira.created.length, 0);

  writeFileSync(join(cdir, "proposal.md"), `# Proposal\n\n## Why\n\nREQ-7: el área contable concilia a mano.\n\n## What Changes\n\nExportar facturas a CSV. Fuera de alcance: Excel.\n\n## Capabilities\n\n### New Capabilities\n- \`facturacion-exportacion\`: exportar facturas a CSV\n\n### Modified Capabilities\n\n## Impact\n\nexport.mjs\n`);
  mkdirSync(join(cdir, "specs", "facturacion-exportacion"), { recursive: true });
  writeFileSync(join(cdir, "specs", "facturacion-exportacion", "spec.md"), `# Spec Delta\n\n## Purpose\nPermitir exportar facturas a CSV para la conciliación contable del cliente.\n\n## ADDED Requirements\n\n### Requirement: Exportar a CSV\nEl sistema SHALL generar un CSV con encabezado y una fila por factura.\n\n#### Scenario: Facturas con encabezado\n- **WHEN** se exporta una lista de facturas\n- **THEN** el CSV tiene encabezado y una fila por factura\n`);
  writeFileSync(join(cdir, "design.md"), "# Design\n\n## Context\nFunción pura.\n\n## Goals / Non-Goals\n**Goals:** CSV.\n\n## Decisions\nSin dependencias.\n\n## Risks / Trade-offs\nNinguno.\n");
  writeFileSync(join(cdir, "tasks.md"), "# Tasks\n\n## 1. Exportación\n\n- [ ] 1.1 Implementar exportar\n- [ ] 1.2 Test del escenario (1h)\n");

  r = await p.complete("REQ-7", analysis, "analyst-bot");
  assert.equal(r.ok, false);
  assert.match((r as any).errors.join(), /estimate/);   // (Nh) is missing in 1.1
  assert.equal(jira.created.length, 0);

  writeFileSync(join(cdir, "tasks.md"), "# Tasks\n\n## 1. Exportación\n\n- [ ] 1.1 Implementar exportar (2h)\n- [ ] 1.2 Test del escenario (1h)\n");
  r = await p.complete("REQ-7", analysis, "analyst-bot");
  assert.deepEqual(r, { ok: true, next: "DEVELOPMENT" });   // the analyst's OK replaces the analysis and spec gates
  assert.equal(state(), "DEVELOPMENT");
  assert.match(jira.coms["REQ-7"].map((x) => x.body).join("\n"), /3 estimated hours/);
  assert.match(git("log", "--format=%s"), /spec OpenSpec/);

  // ---- orqen/work/REQ-7 was committed on the branch and the tree is clean (branches can be switched)
  const tracked = git("ls-files", "orqen/work/REQ-7").split("\n");
  assert.ok(tracked.includes("orqen/work/REQ-7/round-1/analysis.md"));
  assert.ok(tracked.includes("orqen/work/REQ-7/log.md"));
  assert.ok(tracked.includes("orqen/work/REQ-7/state.json"));
  assert.equal(git("status", "--porcelain", "--untracked-files=no").trim(), "");
  assert.match(readFileSync(join(dir, "orqen", "work", "REQ-7", "round-1", "analysis.md"), "utf8"), /Excel queda fuera/);
  assert.equal(JSON.parse(readFileSync(join(dir, "orqen", "work", "REQ-7", "state.json"), "utf8")).state, "DEVELOPMENT");

  // ---- when the analysis closes the internal ticket is born, linked to the request
  assert.equal(jira.created.length, 1);
  assert.equal(jira.created[0].key, "DEV-1");
  assert.match(jira.created[0].title, /^\[REQ-7\]/);
  assert.deepEqual(jira.links, [["DEV-1", "REQ-7"]]);
  assert.equal(new Store(cfg.stateDir).get("REQ-7")!.internal, "DEV-1");
  assert.match(jira.coms["REQ-7"].map((c) => c.body).join("\n"), /Track implementation in DEV-1/);

  // ---- DEVELOPMENT
  await p.take("REQ-7");
  writeFileSync(join(dir, "export.mjs"), "export const exportCsv = (fs) => ['n', ...fs.map(f => f.n)].join('\\n');\n");
  const dev = { completed: true, changes_summary: "Implementé exportCsv()", modified_files: ["export.mjs"], added_tests: ["test.mjs"] };
  r = await p.complete("REQ-7", dev);
  assert.match((r as any).errors.join(), /unticked/);
  writeFileSync(join(cdir, "tasks.md"), readFileSync(join(cdir, "tasks.md"), "utf8").replaceAll("- [ ]", "- [x]"));
  r = await p.complete("REQ-7", dev);
  assert.deepEqual(r, { ok: true, next: "TESTING" });
  assert.match(jira.last("DEV-1"), /Development complete/);   // the technical milestone is mirrored on the internal ticket

  // ---- TESTING (real tests pass)
  const t = await p.take("REQ-7");
  assert.equal(t.context.test_result.ok, true);
  assert.equal(t.context.scenarios!.length, 1);
  r = await p.complete("REQ-7", { scenarios: [], failure_diagnosis: "", suggestions: [], coverage_ok: true });
  assert.match((r as any).errors.join(), /Scenarios still to evaluate/);
  r = await p.complete("REQ-7", {
    scenarios: [{ requirement: "Exportar a CSV", scenario: "Facturas con encabezado", covered: true, test: "test.mjs" }],
    failure_diagnosis: "", suggestions: [], coverage_ok: true,
  });
  assert.deepEqual(r, { ok: true, next: "CODE_REVIEW" });

  // full lane: the senior's /approve waits for QA (step 7)
  jira.human("REQ-7", "senior", "/approve");
  await p.review();
  assert.equal(state(), "CODE_REVIEW");
  assert.match(jira.last("REQ-7"), /QA has not approved/);
  const st = new Store(cfg.stateDir), it = st.get("REQ-7")!;
  it.artifacts.devel_pr = "https://github.example.test/acme/repo/pull/7";
  st.save(it);
  await p.qaReview("REQ-7", "Facturas con encabezado → test.mjs: verifica el encabezado y una fila por factura. Corrida en verde.", "approve", "Quique");
  jira.human("REQ-7", "senior", "/approve");
  await p.review();
  assert.equal(state(), "DELIVERY");

  // ---- DELIVERY: take archives the change → spec merged into openspec/specs
  await p.take("REQ-7");
  assert.ok(existsSync(join(dir, "openspec", "specs", "facturacion-exportacion", "spec.md")));
  assert.ok(!existsSync(cdir));
  assert.equal(execFileSync("git", ["--git-dir", remote, "branch", "--list", "orqen/req-7"], { encoding: "utf8" }).trim(), "orqen/req-7");
  r = await p.complete("REQ-7", { release_notes: "n", client_message: "Ya podés exportar facturas a CSV desde el módulo.", validation_steps: ["Exportar"] });
  assert.deepEqual(r, { ok: true, next: "ACCEPTANCE" });

  // ---- client rejects → round 2 with a new change
  jira.human("REQ-7", "client", "/reject falta el total");
  await p.review();
  const rec = new Store(cfg.stateDir).get("REQ-7")!;
  assert.equal(rec.state, "ANALYSIS");
  assert.equal(rec.round, 2);
  assert.equal(rec.change, "");
  assert.equal(rec.internal, undefined);                          // round 2 will get a new internal ticket
  assert.deepEqual(rec.artifacts.previous_internal, ["DEV-1"]);
  assert.deepEqual(rec.feedback, [{ from: "client", rejection: "falta el total" }]);
});
