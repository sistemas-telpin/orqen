/** Operational workflow tests with simulated SQL, approvals, and Jira. */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { cargarConfig } from "../src/workflow/config.ts";
import type { OpenSpecApi } from "../src/workflow/openspec.ts";
import { Proceso } from "../src/workflow/workflow.ts";
import { revisarSql } from "../src/workflow/sql.ts";
import { Store } from "../src/workflow/store.ts";
import type { Workspace } from "../src/workflow/workspace.ts";
import { FakeJira } from "./fakes.ts";

const fakeOs: OpenSpecApi = {
  nuevoCambio: (id) => id, existe: () => true, dir: (id) => id,
  validar: () => ({ ok: true, problemas: [] }), planificacionCompleta: () => true,
  tareas: () => [], escenarios: () => [], archivar: () => ({ archivadoComo: "x", totales: {} }),
};

function armar(over: Partial<Parameters<typeof cargarConfig>[0]> = {}) {
  let ramas = 0;
  const ws: Workspace = {
    prepararRama: () => { ramas++; return "rec/rec-1"; }, commit: () => true, push: () => {}, abrirPr: () => "",
    correrTests: () => ({ ok: true, salida: "" }),
  };
  const dir = mkdtempSync(join(tmpdir(), "rec-c-"));
  const cfg = cargarConfig({
    estadoDir: join(dir, "estado"), factoryDir: join(dir, "factory"), jql: "x", transicionesJira: {},
    aprobadores: { analisis: ["analista"], codigo: ["senior"], cliente: ["cliente"], ejecucion: ["dba"] },
    ...over,
  });
  const jira = new FakeJira({ "REC-1": { titulo: "Facturas duplicadas" } });
  const store = new Store(cfg.estadoDir);
  return { cfg, jira, ramas: () => ramas, est: () => store.get("REC-1")!, p: new Proceso(cfg, jira, store, ws, fakeOs) };
}

const ANALISIS = (via = "operativa", over: Record<string, unknown> = {}) => ({
  resumen: "A script can remove duplicate invoices from the billing period.", tipo: "bug", criterios_aceptacion: ["c"],
  capacidades_afectadas: [], preguntas_abiertas: [], riesgos: [], listo: true, analista_ok: true, via, carril: "directo",
  justificacion_carril: "This can be corrected by changing data only.", plan: ["Adjust the module (1h)"], ...over,
});
const EJEC = (over: Record<string, unknown> = {}) => ({
  resumen: "Remove duplicate invoices from the billing period.", sistema: "SQL Server PROD", impacto: "Delete 12 invoice rows",
  filas_estimadas: 12, script_sql: "DELETE FROM facturas WHERE id IN (SELECT id_dup FROM dup);",
  rollback: "Restore from facturas_bak_REC1", verificacion: "SELECT COUNT(*) FROM facturas_dup", riesgos: [], ...over,
});
const VERIF = (over: Record<string, unknown> = {}) => ({
  verificado: true, evidencia: "COUNT = 0", mensaje_cliente: "The billing period no longer contains duplicate invoices.",
  pasos_validacion: ["Revisar el listado de facturas"], ...over,
});

async function hastaEjecucion() {
  const t = armar();
  await t.p.revisar();
  await t.p.analizar("REC-1", "analista-bot", "Ana");
  assert.deepEqual(await t.p.completar("REC-1", ANALISIS("operativa"), "analista-bot"), { ok: true, siguiente: "EJECUCION" });
  return t;
}

test("operational work creates a SIS and requires human approval and application", async () => {
  const { p, jira, est, ramas, cfg } = await hastaEjecucion();
  assert.equal(est().estado, "EJECUCION");                    // Analyst approval advances to execution.
  assert.equal(jira.creados.length, 1);                       // Closing analysis creates the SIS.
  assert.deepEqual(jira.links, [["SIS-1", "REC-1", "Relates"]]);

  await p.tomar("REC-1");
  assert.equal(ramas(), 0);                                   // No branch changes.

  assert.deepEqual(await p.completar("REC-1", EJEC()), { ok: true, siguiente: "APROBACION_EJECUCION" });
  assert.ok(existsSync(join(cfg.factoryDir, "REC-1", "round-1", "execution", "script.sql")));
  assert.ok(existsSync(join(cfg.factoryDir, "REC-1", "round-1", "analysis.md")));
  assert.match(jira.ultimo("REC-1"), /Script SQL/);

  jira.humano("REC-1", "pm", "/aprobar");                     // This user cannot approve execution.
  await p.revisar();
  assert.equal(est().estado, "APROBACION_EJECUCION");
  jira.humano("REC-1", "dba", "/approve");
  await p.revisar();
  assert.equal(est().estado, "APLICACION");
  assert.equal(jira.creados.length, 1);                       // Approval reuses the SIS.

  jira.humano("REC-1", "dba", "/aprobar se borraron 12 filas");
  await p.revisar();
  assert.equal(est().estado, "VERIFICACION");
  const { contexto } = await p.tomar("REC-1");
  assert.deepEqual(contexto.feedback_humano, [{ de: "dba", texto: "se borraron 12 filas" }]);

  assert.deepEqual(await p.completar("REC-1", VERIF()), { ok: true, siguiente: "CONFORMIDAD" });
  jira.humano("REC-1", "cliente", "/aprobar");
  await p.revisar();
  assert.equal(est().estado, "CERRADO");
});

test("rejects DROP, unfiltered DELETE, and missing rollback", async () => {
  const { p, jira, est } = await hastaEjecucion();
  await p.tomar("REC-1");
  for (const sql of ["DROP TABLE facturas;", "DELETE FROM facturas;", "UPDATE facturas SET x = 1;", "DELETE FROM t WHERE 1=1;", "TRUNCATE TABLE t"]) {
    const r = await p.completar("REC-1", EJEC({ script_sql: sql }));
    assert.equal(r.ok, false, sql);
  }
  assert.equal((await p.completar("REC-1", EJEC({ rollback: "" }))).ok, false);
  assert.equal((await p.completar("REC-1", EJEC({ script_sql: undefined }))).ok, false);   // Neither a script nor manual steps were supplied.
  assert.equal((await p.completar("REC-1", EJEC({ script_sql: undefined, pasos_manuales: ["Reiniciar el servicio X"] }))).ok, true);
  assert.equal(est().estado, "APROBACION_EJECUCION");
  assert.deepEqual(revisarSql("-- DELETE FROM t\nSELECT 'DROP TABLE x'; UPDATE t SET a=1 WHERE id=3;"), []);
});

test("failed verification retries execution or sends code defects back to analysis", async () => {
  const { p, jira, est } = await hastaEjecucion();
  await p.tomar("REC-1");
  await p.completar("REC-1", EJEC());
  jira.humano("REC-1", "dba", "/aprobar"); await p.revisar();
  jira.humano("REC-1", "dba", "/aprobar listo"); await p.revisar();

  await p.tomar("REC-1");
  assert.deepEqual(await p.completar("REC-1", VERIF({ verificado: false, evidencia: "COUNT = 4", mensaje_cliente: "", pasos_validacion: [] })),
    { ok: true, siguiente: "EJECUCION" });

  await p.tomar("REC-1");
  await p.completar("REC-1", EJEC());
  jira.humano("REC-1", "dba", "/aprobar"); await p.revisar();
  jira.humano("REC-1", "dba", "/aprobar listo"); await p.revisar();
  await p.tomar("REC-1");
  assert.deepEqual(await p.completar("REC-1", VERIF({ verificado: false, requiere_desarrollo: true, evidencia: "Reaparecen: bug en el alta" })),
    { ok: true, siguiente: "ANALISIS" });
  assert.equal(est().via, "desarrollo");
  assert.equal(est().sis, undefined);
  assert.deepEqual(est().artefactos.sis_previos, ["SIS-1"]);

  // Reanalysis selects a development lane and creates a development SIS.
  await p.analizar("REC-1", "analista-bot", "Ana");
  assert.deepEqual(await p.completar("REC-1", ANALISIS("desarrollo", { analista_ok: true }), "analista-bot"), { ok: true, siguiente: "DESARROLLO" });
  assert.equal(est().sis, "SIS-2");
  assert.equal(jira.creados[1].tipo, "Task");
});

test("operational work requires the direct lane and uses the operational issue type", async () => {
  const t = armar({ sis: { proyecto: "SIS", tipo: "Task", link: "Relates", transiciones: {}, tipoOperativo: "Incident" } });
  await t.p.analizar("REC-1", "bot", "Ana");
  const r = await t.p.completar("REC-1", ANALISIS("operativa", { carril: "liviano" }), "bot");
  assert.match((r as any).errores.join(), /directo lane for operational work/);
  assert.equal(t.jira.creados.length, 0);
  await t.p.completar("REC-1", ANALISIS("operativa"), "bot");
  assert.equal(t.jira.creados.length, 1);
  assert.equal(t.jira.creados[0].tipo, "Incident");
  assert.deepEqual((t.jira.creados[0] as any).labels, ["origen-rec-1", "carril-operativo"]);
  assert.equal(t.est().sis, "SIS-1");
});
