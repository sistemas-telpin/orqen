/** Test analysis, lanes, work records, permissions, locks, and gates with fakes. */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { cargarConfig } from "../src/workflow/config.ts";
import type { OpenSpecApi } from "../src/workflow/openspec.ts";
import { Proceso, nombreCambio } from "../src/workflow/workflow.ts";
import { Store } from "../src/workflow/store.ts";
import type { Workspace } from "../src/workflow/workspace.ts";
import { FakeJira } from "./fakes.ts";

const fakeOs: OpenSpecApi = {
  nuevoCambio: (id) => id, existe: () => false, dir: (id) => id,
  validar: () => ({ ok: true, problemas: [] }), planificacionCompleta: () => true,
  tareas: () => [{ descripcion: "t (2h)", hecha: true, horas: 2 }, { descripcion: "u (3h)", hecha: true, horas: 3 }],
  escenarios: () => [{ capacidad: "c", requisito: "R", escenario: "E" }],
  archivar: () => ({ archivadoComo: "x", totales: {} }),
};
const testsFallan: Workspace = {
  prepararRama: () => "rec/rec-1", commit: () => true, push: () => {}, abrirPr: () => "",
  correrTests: () => ({ ok: false, salida: "1 failed" }),
};

function armar() {
  const dir = mkdtempSync(join(tmpdir(), "rec-g-"));
  const cfg = cargarConfig({
    repoPath: dir, estadoDir: join(dir, "state"), factoryDir: join(dir, "orqen", "work"), jql: "x", transicionesJira: {},
    aprobadores: { analisis: ["analista"], codigo: ["senior"], cliente: ["cliente"] },
  });
  const jira = new FakeJira({ "REC-1": { titulo: "Algo" } });
  const store = new Store(cfg.estadoDir);
  return { cfg, p: new Proceso(cfg, jira, store, testsFallan, fakeOs), jira, est: () => store.get("REC-1")! };
}

const BASE = {
  resumen: "A sufficiently detailed request summary.", tipo: "cambio", criterios_aceptacion: ["c"],
  capacidades_afectadas: [], riesgos: [],
};
const ANALISIS_PREGUNTAS = (preguntas: string[]) => ({ ...BASE, preguntas_abiertas: preguntas, listo: false });
/** Approved direct-lane analysis fixture. */
const ANALISIS_OK = (over: Record<string, unknown> = {}) => ({
  ...BASE, preguntas_abiertas: [], listo: true, analista_ok: true, via: "desarrollo", carril: "directo",
  justificacion_carril: "Small change within a single component.", plan: ["Implement the change (2h)"], estimacion_horas: 2,
  decisiones: [{ pregunta: "Which format?", respuesta: "CSV" }], ...over,
});

test("analysis handles customer replies, explicit approval, and direct-lane records", async () => {
  const { p, jira, est, cfg } = armar();
  const pend = await p.revisar();
  assert.deepEqual(pend.map((x) => [x.key, x.estado, x.para]), [["REC-1", "NUEVO", "analista"]]);
  await assert.rejects(p.tomar("REC-1", "x"), /has no work/);

  await p.analizar("REC-1", "codex", "Ana");
  assert.equal(est().estado, "ANALISIS");
  assert.equal(est().analista, "Ana");
  assert.match(jira.coms["REC-1"][0].cuerpo, /Ana started analyzing/);
  await assert.rejects(p.analizar("REC-1", "claude", "Bea"), /already claimed by "codex"/);
  await assert.rejects(p.tomar("REC-1", "codex"), /requires an analyst/);   // An analyst must start analysis.

  assert.equal((await p.completar("REC-1", ANALISIS_PREGUNTAS(["Question?"]), "claude")).ok, false);   // Different agent.
  assert.equal((await p.completar("REC-1", { resumen: "corto" }, "codex")).ok, false);          // Invalid schema.

  // Closing analysis requires approval, a lane, and a plan for direct development.
  let r = await p.completar("REC-1", ANALISIS_OK({ analista_ok: false }), "codex");
  assert.match((r as any).errores.join(), /explicit analyst approval/);
  r = await p.completar("REC-1", ANALISIS_OK({ carril: undefined }), "codex");
  assert.match((r as any).errores.join(), /Choose a lane/);
  r = await p.completar("REC-1", ANALISIS_OK({ plan: undefined }), "codex");
  assert.match((r as any).errores.join(), /implementation plan/);
  assert.equal(jira.creados.length, 0);                                 // No partial Jira issue was created.

  // A question for the customer moves the request to ESPERA_CLIENTE.
  await p.completar("REC-1", ANALISIS_PREGUNTAS(["Which format?"]), "codex");
  assert.equal(est().estado, "ESPERA_CLIENTE");
  assert.match(jira.ultimo("REC-1"), /Which format\?/);
  await assert.rejects(p.analizar("REC-1", "codex", "Ana"), /waiting for a customer reply/);
  await p.revisar();
  assert.equal(est().estado, "ESPERA_CLIENTE");   // Wait for a customer reply.
  jira.humano("REC-1", "cliente", "CSV");
  const pend2 = await p.revisar();
  assert.equal(est().estado, "ANALISIS");
  assert.deepEqual(pend2.map((x) => [x.key, x.para]), [["REC-1", "analista"]]);

  const { contexto } = await p.analizar("REC-1", "codex", "Ana");
  assert.deepEqual(contexto.feedback_humano, [{ de: "cliente", texto: "CSV" }]);
  assert.equal(contexto.factory, "orqen/work/REC-1/round-1");

  assert.deepEqual(await p.carril("REC-1", "directo", "codex"), { carril: "directo", openspec: undefined, rama: undefined });
  assert.deepEqual(await p.completar("REC-1", ANALISIS_OK(), "codex"), { ok: true, siguiente: "DESARROLLO" });

  // Approval creates and links the implementation issue.
  assert.equal(est().estado, "DESARROLLO");
  assert.equal(est().carril, "directo");
  assert.equal(jira.creados.length, 1);
  assert.equal(jira.creados[0].key, "SIS-1");
  assert.match(jira.creados[0].titulo, /^\[REC-1\]/);
  assert.match(jira.creados[0].descripcion, /Lane:\* directo/);
  assert.deepEqual((jira.creados[0] as any).labels, ["origen-rec-1", "carril-directo"]);
  assert.deepEqual(jira.links, [["SIS-1", "REC-1", "Relates"]]);
  assert.equal(est().sis, "SIS-1");
  assert.match(jira.coms["REC-1"].map((c) => c.cuerpo).join("\n"), /Track implementation in SIS-1/);

  // Work record under orqen/work/REC-1.
  const f = join(cfg.factoryDir, "REC-1");
  const md = readFileSync(join(f, "round-1", "analysis.md"), "utf8");
  assert.match(md, /Analyst:\*\* Ana/);
  assert.match(md, /Lane:\*\* directo/);
  assert.match(md, /SIS:\*\* SIS-1/);
  assert.match(md, /Which format\?\*\* → CSV/);
  assert.ok(existsSync(join(f, "round-1", "analysis.json")));
  const estado = JSON.parse(readFileSync(join(f, "status.json"), "utf8"));
  assert.deepEqual([estado.estado, estado.carril, estado.sis, estado.analista], ["DESARROLLO", "directo", "SIS-1", "Ana"]);
  assert.match(readFileSync(join(f, "history.md"), "utf8"), /ANALISIS → DESARROLLO/);
});

test("the lightweight lane requires a matching registered OpenSpec change", async () => {
  const { p, jira, est } = armar();
  await p.analizar("REC-1", "codex", "Ana");
  const spec = { cambio: "rec-1-algo", resumen: "Resumen de la propuesta.", supuestos: ["s"] };
  const liviano = (over = {}) => ANALISIS_OK({ carril: "liviano", plan: undefined, estimacion_horas: undefined, especificacion: spec, ...over });

  let r = await p.completar("REC-1", liviano({ especificacion: undefined }), "codex");
  assert.match((r as any).errores.join(), /require a spec/);
  r = await p.completar("REC-1", liviano(), "codex");                    // The lane was not registered.
  assert.match((r as any).errores.join(), /orqen lane REC-1 liviano/);
  await assert.rejects(p.carril("REC-1", "gigante", "codex"), /Invalid lane/);

  assert.deepEqual(await p.carril("REC-1", "liviano", "codex"),
    { carril: "liviano", rama: "rec/rec-1", openspec: { cambio: "rec-1-algo", dir: "openspec/changes/rec-1-algo" } });
  r = await p.completar("REC-1", liviano({ especificacion: { ...spec, cambio: "otro" } }), "codex");
  assert.match((r as any).errores.join(), /must be "rec-1-algo"/);

  assert.deepEqual(await p.completar("REC-1", liviano(), "codex"), { ok: true, siguiente: "DESARROLLO" });
  assert.equal(est().cambio, "rec-1-algo");
  assert.equal(est().artefactos.estimacion_horas, 5);                    // Two plus three hours from tasks.md.
  assert.match(jira.creados[0].descripcion, /OpenSpec change:\* openspec\/changes\/rec-1-algo/);
  assert.match(jira.creados[0].descripcion, /Estimate:\* 5 h/);
});

test("three test failures block the request and approval retries direct-lane testing", async () => {
  const { p, jira, est } = armar();
  await p.analizar("REC-1", "codex", "Ana");
  await p.completar("REC-1", ANALISIS_OK(), "codex");
  const dev = { completado: true, resumen_cambios: "x", archivos_modificados: [], tests_agregados: [] };
  const qa = { escenarios: [{ requisito: "Acceptance criterion", escenario: "c", cubierto: true }], diagnostico_fallas: "falla", sugerencias: [], cobertura_ok: true };
  for (let i = 0; i < 3; i++) {
    await p.tomar("REC-1"); await p.completar("REC-1", dev);   // The direct lane has no tasks.md.
    const t = await p.tomar("REC-1");
    assert.deepEqual(t.contexto.escenarios, [{ capacidad: "-", requisito: "Acceptance criterion", escenario: "c" }]);
    await p.completar("REC-1", qa);
  }
  assert.equal(est().estado, "BLOQUEADO");
  jira.humano("REC-1", "intruso", "/aprobar");
  await p.revisar();
  assert.equal(est().estado, "BLOQUEADO");
  jira.humano("REC-1", "senior", "/aprobar review the mock");
  await p.revisar();
  assert.equal(est().estado, "TESTING");
  assert.equal(est().intentosTesting, 0);
});

test("testing requires coverage for every criterion and mirrors milestones to the SIS", async () => {
  const { p, jira, est } = armar();
  await p.analizar("REC-1", "codex", "Ana");
  await p.completar("REC-1", ANALISIS_OK(), "codex");
  await p.tomar("REC-1");
  await p.completar("REC-1", { completado: true, resumen_cambios: "x", archivos_modificados: [], tests_agregados: [] });
  await p.tomar("REC-1");
  const r = await p.completar("REC-1", { escenarios: [], diagnostico_fallas: "", sugerencias: [], cobertura_ok: true });
  assert.match((r as any).errores.join(), /Scenarios still need coverage checks/);
  assert.equal(est().estado, "TESTING");
  assert.ok(jira.coms["SIS-1"].length >= 1);   // Implementation milestones are copied to the SIS.
});

test("continues writing existing work records at their previous paths", async () => {
  const { cfg, p, jira } = armar();
  const request = join(cfg.factoryDir, "REC-1");
  const round = join(request, "ronda-1");
  mkdirSync(round, { recursive: true });
  writeFileSync(join(round, "analisis.md"), "# Existing analysis\n");
  writeFileSync(join(request, "bitacora.md"), "# Existing history\n");

  const { contexto } = await p.analizar("REC-1", "agent", "Ana");
  assert.equal(contexto.factory, "orqen/work/REC-1/ronda-1");
  assert.equal((await p.completar("REC-1", ANALISIS_OK(), "agent")).ok, true);
  assert.match(jira.creados[0].descripcion, /ronda-1\/analisis\.md/);
  assert.match(readFileSync(join(round, "analisis.md"), "utf8"), /^# REC-1/);
  assert.match(readFileSync(join(request, "bitacora.md"), "utf8"), /^# Existing history/);
  assert.ok(!existsSync(join(request, "round-1")));
});

test("builds a stable OpenSpec change name", () => {
  assert.equal(nombreCambio("REC-123", "Monthly invoice export to CSV", 1), "rec-123-monthly-invoice-export-csv");
  assert.equal(nombreCambio("REC-123", "Résumé export", 2), "rec-123-resume-export-r2");
});
