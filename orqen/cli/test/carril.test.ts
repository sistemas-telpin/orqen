/** Carril operativo (via=operativa): script SQL / reinicio sin OpenSpec ni rama. Todo simulado. */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { cargarConfig } from "../scripts/config.ts";
import type { OpenSpecApi } from "../scripts/openspec.ts";
import { Proceso } from "../scripts/proceso.ts";
import { revisarSql } from "../scripts/sql.ts";
import { Store } from "../scripts/store.ts";
import type { Workspace } from "../scripts/workspace.ts";
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
  resumen: "Hay facturas duplicadas que se corrigen con un script.", tipo: "bug", criterios_aceptacion: ["c"],
  capacidades_afectadas: [], preguntas_abiertas: [], riesgos: [], listo: true, analista_ok: true, via, carril: "directo",
  justificacion_carril: "Se corrige con datos, sin tocar código.", plan: ["Ajustar el módulo (1h)"], ...over,
});
const EJEC = (over: Record<string, unknown> = {}) => ({
  resumen: "Eliminar las facturas duplicadas del período.", sistema: "SQL Server PROD", impacto: "Borra 12 filas de facturas",
  filas_estimadas: 12, script_sql: "DELETE FROM facturas WHERE id IN (SELECT id_dup FROM dup);",
  rollback: "Restaurar desde la tabla facturas_bak_REC1", verificacion: "SELECT COUNT(*) FROM facturas_dup", riesgos: [], ...over,
});
const VERIF = (over: Record<string, unknown> = {}) => ({
  verificado: true, evidencia: "COUNT = 0", mensaje_cliente: "Ya no hay facturas duplicadas en el período.",
  pasos_validacion: ["Revisar el listado de facturas"], ...over,
});

async function hastaEjecucion() {
  const t = armar();
  await t.p.revisar();
  await t.p.analizar("REC-1", "analista-bot", "Ana");
  assert.deepEqual(await t.p.completar("REC-1", ANALISIS("operativa"), "analista-bot"), { ok: true, siguiente: "EJECUCION" });
  return t;
}

test("carril operativo completo: SIS al cerrar el análisis, sin rama, con aprobación y aplicación humanas", async () => {
  const { p, jira, est, ramas, cfg } = await hastaEjecucion();
  assert.equal(est().estado, "EJECUCION");                    // el OK del analista reemplaza al gate de análisis
  assert.equal(jira.creados.length, 1);                       // el SIS nace al cerrar el análisis, también acá
  assert.deepEqual(jira.links, [["SIS-1", "REC-1", "Relates"]]);

  await p.tomar("REC-1");
  assert.equal(ramas(), 0);                                   // no toca git

  assert.deepEqual(await p.completar("REC-1", EJEC()), { ok: true, siguiente: "APROBACION_EJECUCION" });
  assert.ok(existsSync(join(cfg.factoryDir, "REC-1", "ronda-1", "ejecucion", "script.sql")));
  assert.ok(existsSync(join(cfg.factoryDir, "REC-1", "ronda-1", "analisis.md")));
  assert.match(jira.ultimo("REC-1"), /Script SQL/);

  jira.humano("REC-1", "pm", "/aprobar");                     // no es aprobador de ejecución
  await p.revisar();
  assert.equal(est().estado, "APROBACION_EJECUCION");
  jira.humano("REC-1", "dba", "/aprobar");
  await p.revisar();
  assert.equal(est().estado, "APLICACION");
  assert.equal(jira.creados.length, 1);                       // no se crea otro SIS al autorizar

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

test("guardas del SQL: DROP, DELETE sin WHERE, WHERE trivial, sin rollback", async () => {
  const { p, jira, est } = await hastaEjecucion();
  await p.tomar("REC-1");
  for (const sql of ["DROP TABLE facturas;", "DELETE FROM facturas;", "UPDATE facturas SET x = 1;", "DELETE FROM t WHERE 1=1;", "TRUNCATE TABLE t"]) {
    const r = await p.completar("REC-1", EJEC({ script_sql: sql }));
    assert.equal(r.ok, false, sql);
  }
  assert.equal((await p.completar("REC-1", EJEC({ rollback: "" }))).ok, false);
  assert.equal((await p.completar("REC-1", EJEC({ script_sql: undefined }))).ok, false);   // ni script ni pasos
  assert.equal((await p.completar("REC-1", EJEC({ script_sql: undefined, pasos_manuales: ["Reiniciar el servicio X"] }))).ok, true);
  assert.equal(est().estado, "APROBACION_EJECUCION");
  assert.deepEqual(revisarSql("-- DELETE FROM t\nSELECT 'DROP TABLE x'; UPDATE t SET a=1 WHERE id=3;"), []);
});

test("verificación fallida vuelve a EJECUCION; requiere_desarrollo vuelve a ANALISIS con SIS nuevo", async () => {
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

  // el analista re-analiza, ahora con carril de desarrollo → nace un SIS de desarrollo
  await p.analizar("REC-1", "analista-bot", "Ana");
  assert.deepEqual(await p.completar("REC-1", ANALISIS("desarrollo", { analista_ok: true }), "analista-bot"), { ok: true, siguiente: "DESARROLLO" });
  assert.equal(est().sis, "SIS-2");
  assert.equal(jira.creados[1].tipo, "Task");
});

test("la vía operativa solo admite carril directo y usa el tipo de SIS operativo", async () => {
  const t = armar({ sis: { proyecto: "SIS", tipo: "Task", link: "Relates", transiciones: {}, tipoOperativo: "Incident" } });
  await t.p.analizar("REC-1", "bot", "Ana");
  const r = await t.p.completar("REC-1", ANALISIS("operativa", { carril: "liviano" }), "bot");
  assert.match((r as any).errores.join(), /no lleva spec/);
  assert.equal(t.jira.creados.length, 0);
  await t.p.completar("REC-1", ANALISIS("operativa"), "bot");
  assert.equal(t.jira.creados.length, 1);
  assert.equal(t.jira.creados[0].tipo, "Incident");
  assert.deepEqual((t.jira.creados[0] as any).labels, ["origen-rec-1", "carril-operativo"]);
  assert.equal(t.est().sis, "SIS-1");
});
