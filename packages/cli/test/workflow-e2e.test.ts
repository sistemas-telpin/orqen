/**
 * End-to-end workflow using real OpenSpec and Git with a fake Jira client.
 * The test writes the artifacts and JSON that an agent would produce.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { TEMPLATES_DIR } from "orqen-kit";
import { cargarConfig } from "../src/workflow/config.ts";
import { OpenSpecCli } from "../src/workflow/openspec.ts";
import { Proceso } from "../src/workflow/workflow.ts";
import { Store } from "../src/workflow/store.ts";
import { GitWorkspace } from "../src/workflow/workspace.ts";
import { FakeJira } from "./fakes.ts";

const OPENSPEC = fileURLToPath(new URL(`../node_modules/.bin/openspec${process.platform === "win32" ? ".cmd" : ""}`, import.meta.url));

function repoTemporal() {
  const dir = mkdtempSync(join(tmpdir(), "rec-e2e-"));
  const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@t"); git("config", "user.name", "t");
  mkdirSync(join(dir, "openspec", "specs"), { recursive: true });
  mkdirSync(join(dir, "openspec", "changes", "archive"), { recursive: true });
  cpSync(join(TEMPLATES_DIR, "openspec", "config.yaml"), join(dir, "openspec", "config.yaml"));
  writeFileSync(join(dir, "openspec", "specs", ".gitkeep"), "");
  writeFileSync(join(dir, "openspec", "changes", "archive", ".gitkeep"), "");
  writeFileSync(join(dir, "export.mjs"), "export const exportar = () => '';\n");
  writeFileSync(join(dir, "test.mjs"), "import {exportar} from './export.mjs'; if (exportar([{n:1}]) !== 'n\\n1') process.exit(1);\n");
  git("add", "-A"); git("commit", "-qm", "init");
  return { dir, git };
}

test("runs the full request workflow with OpenSpec", { skip: !existsSync(OPENSPEC) && "OpenSpec unavailable" }, async () => {
  const { dir, git } = repoTemporal();
  const cfg = cargarConfig({
    repoPath: dir, estadoDir: join(dir, "..", `estado-${Date.now()}`), openspecCmd: OPENSPEC,
    comandoTests: "node test.mjs", comandoPr: "", jql: "x",
    aprobadores: { analisis: ["analista"], codigo: ["senior"], cliente: ["cliente"] }, transicionesJira: {},
  });
  const jira = new FakeJira({ "REC-7": { titulo: "Exportar facturas a CSV" } });
  const os = new OpenSpecCli(OPENSPEC, dir);
  const p = new Proceso(cfg, jira, new Store(cfg.estadoDir), new GitWorkspace(cfg), os);
  const estado = () => new Store(cfg.estadoDir).get("REC-7")!.estado;

  // ---- Analyst-led analysis
  assert.deepEqual((await p.revisar()).map((x) => [x.key, x.estado, x.para]), [["REC-7", "NUEVO", "analista"]]);
  await p.analizar("REC-7", "analista-bot", "Ana");
  assert.equal(git("rev-parse", "--abbrev-ref", "HEAD").trim(), "main");   // The interview leaves the branch unchanged.

  // The full lane prepares a branch and OpenSpec change.
  const c = await p.carril("REC-7", "completo", "analista-bot");
  const cambio = c.openspec!.cambio;
  assert.equal(cambio, "rec-7-exportar-facturas-csv");
  assert.equal(git("rev-parse", "--abbrev-ref", "HEAD").trim(), "rec/rec-7");
  const cdir = join(dir, "openspec", "changes", cambio);
  const analisis = {
    resumen: "Accounting needs CSV invoice exports for reconciliation.", tipo: "funcionalidad",
    criterios_aceptacion: ["Given invoices, when I export them, then the CSV contains a header"],
    capacidades_afectadas: ["invoice-export"], preguntas_abiertas: [], riesgos: [], listo: true,
    decisiones: [{ pregunta: "CSV only?", respuesta: "Yes, Excel is out of scope" }],
    analista_ok: true, via: "desarrollo", carril: "completo", justificacion_carril: "The new capability defines an export contract for accounting.",
    especificacion: { cambio, resumen: "Export invoices as CSV for accounting.", supuestos: [] },
  };

  // OpenSpec rejects missing artifacts before Jira issue creation.
  let r = await p.completar("REC-7", analisis, "analista-bot");
  assert.equal(r.ok, false);
  assert.equal(jira.creados.length, 0);

  writeFileSync(join(cdir, "proposal.md"), `# Proposal\n\n## Why\n\nREC-7: Accounting reconciles invoices manually.\n\n## What Changes\n\nExport invoices as CSV. Excel is out of scope.\n\n## Capabilities\n\n### New Capabilities\n- \`invoice-export\`: export invoices as CSV\n\n### Modified Capabilities\n\n## Impact\n\nexport.mjs\n`);
  mkdirSync(join(cdir, "specs", "invoice-export"), { recursive: true });
  writeFileSync(join(cdir, "specs", "invoice-export", "spec.md"), `# Spec Delta\n\n## Purpose\nSupport CSV export for invoice reconciliation.\n\n## ADDED Requirements\n\n### Requirement: Export as CSV\nThe system SHALL generate a CSV with a header and one row per invoice.\n\n#### Scenario: Invoice export with a header\n- **WHEN** a user exports a list of invoices\n- **THEN** the CSV contains a header and one row per invoice\n`);
  writeFileSync(join(cdir, "design.md"), "# Design\n\n## Context\nPure function.\n\n## Goals / Non-Goals\n**Goals:** CSV.\n\n## Decisions\nNo dependencies.\n\n## Risks / Trade-offs\nNone.\n");
  writeFileSync(join(cdir, "tasks.md"), "# Tasks\n\n## 1. Export\n\n- [ ] 1.1 Implement the export\n- [ ] 1.2 Test the scenario (1h)\n");

  r = await p.completar("REC-7", analisis, "analista-bot");
  assert.equal(r.ok, false);
  assert.match((r as any).errores.join(), /Missing estimates/);   // Task 1.1 has no hour estimate.
  assert.equal(jira.creados.length, 0);

  writeFileSync(join(cdir, "tasks.md"), "# Tasks\n\n## 1. Export\n\n- [ ] 1.1 Implement the export (2h)\n- [ ] 1.2 Test the scenario (1h)\n");
  r = await p.completar("REC-7", analisis, "analista-bot");
  assert.deepEqual(r, { ok: true, siguiente: "DESARROLLO" });   // Analyst approval closes the analysis after the spec validates.
  assert.equal(estado(), "DESARROLLO");
  assert.match(jira.coms["REC-7"].map((x) => x.cuerpo).join("\n"), /3 estimated hours/);
  assert.match(git("log", "--format=%s"), /spec OpenSpec/);

  // ---- The work record is committed and the working tree is clean.
  const tracked = git("ls-files", "orqen/work/REC-7").split("\n");
  assert.ok(tracked.includes("orqen/work/REC-7/round-1/analysis.md"));
  assert.ok(tracked.includes("orqen/work/REC-7/history.md"));
  assert.ok(tracked.includes("orqen/work/REC-7/status.json"));
  assert.equal(git("status", "--porcelain", "--untracked-files=no").trim(), "");
  assert.match(readFileSync(join(dir, "orqen", "work", "REC-7", "round-1", "analysis.md"), "utf8"), /Excel is out of scope/);
  assert.equal(JSON.parse(readFileSync(join(dir, "orqen", "work", "REC-7", "status.json"), "utf8")).estado, "DESARROLLO");

  // ---- Closing analysis creates and links the SIS.
  assert.equal(jira.creados.length, 1);
  assert.equal(jira.creados[0].key, "SIS-1");
  assert.equal(jira.creados[0].proyecto, "SIS");
  assert.match(jira.creados[0].titulo, /^\[REC-7\]/);
  assert.deepEqual(jira.links, [["SIS-1", "REC-7", "Relates"]]);
  assert.equal(new Store(cfg.estadoDir).get("REC-7")!.sis, "SIS-1");
  assert.match(jira.coms["REC-7"].map((c) => c.cuerpo).join("\n"), /Track implementation in SIS-1/);

  // ---- DESARROLLO
  await p.tomar("REC-7");
  writeFileSync(join(dir, "export.mjs"), "export const exportar = (fs) => ['n', ...fs.map(f => f.n)].join('\\n');\n");
  const dev = { completado: true, resumen_cambios: "Implemented CSV export", archivos_modificados: ["export.mjs"], tests_agregados: ["test.mjs"] };
  r = await p.completar("REC-7", dev);
  assert.match((r as any).errores.join(), /Unchecked tasks/);
  writeFileSync(join(cdir, "tasks.md"), readFileSync(join(cdir, "tasks.md"), "utf8").replaceAll("- [ ]", "- [x]"));
  r = await p.completar("REC-7", dev);
  assert.deepEqual(r, { ok: true, siguiente: "TESTING" });
  assert.match(jira.ultimo("SIS-1"), /Development complete/);   // The milestone is posted to the SIS.

  // ---- Testing runs the real suite.
  const t = await p.tomar("REC-7");
  assert.equal(t.contexto.resultado_tests.ok, true);
  assert.equal(t.contexto.escenarios!.length, 1);
  r = await p.completar("REC-7", { escenarios: [], diagnostico_fallas: "", sugerencias: [], cobertura_ok: true });
  assert.match((r as any).errores.join(), /Scenarios still need coverage checks/);
  r = await p.completar("REC-7", {
    escenarios: [{ requisito: "Export as CSV", escenario: "Invoice export with a header", cubierto: true, test: "test.mjs" }],
    diagnostico_fallas: "", sugerencias: [], cobertura_ok: true,
  });
  assert.deepEqual(r, { ok: true, siguiente: "REVISION_CODIGO" });

  jira.humano("REC-7", "senior", "/aprobar");
  await p.revisar();
  assert.equal(estado(), "ENTREGA");

  // ---- Claiming delivery archives the change and merges the spec.
  await p.tomar("REC-7");
  assert.ok(existsSync(join(dir, "openspec", "specs", "invoice-export", "spec.md")));
  assert.ok(!existsSync(cdir));
  r = await p.completar("REC-7", { notas_release: "n", mensaje_cliente: "You can now export invoices as CSV from the module.", pasos_validacion: ["Exportar"] });
  assert.deepEqual(r, { ok: true, siguiente: "CONFORMIDAD" });

  // ---- A customer rejection starts a second round with a new change.
  jira.humano("REC-7", "cliente", "/rechazar falta el total");
  await p.revisar();
  const rec = new Store(cfg.estadoDir).get("REC-7")!;
  assert.equal(rec.estado, "ANALISIS");
  assert.equal(rec.ronda, 2);
  assert.equal(rec.cambio, "");
  assert.equal(rec.sis, undefined);                          // Round two gets a new SIS.
  assert.deepEqual(rec.artefactos.sis_previos, ["SIS-1"]);
  assert.deepEqual(rec.feedback, [{ de: "cliente", rechazo: "falta el total" }]);
});
