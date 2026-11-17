/** Análisis con analista, carriles, SIS, orqen/work/, gates, permisos, locks y bloqueos con todo simulado. */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { cargarConfig } from "../scripts/config.ts";
import type { OpenSpecApi } from "../scripts/openspec.ts";
import { Proceso, nombreCambio } from "../scripts/proceso.ts";
import { Store } from "../scripts/store.ts";
import type { Workspace } from "../scripts/workspace.ts";
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
    estadoDir: join(dir, "estado"), factoryDir: join(dir, "factory"), jql: "x", transicionesJira: {},
    aprobadores: { analisis: ["analista"], codigo: ["senior"], cliente: ["cliente"] },
  });
  const jira = new FakeJira({ "REC-1": { titulo: "Algo" } });
  const store = new Store(cfg.estadoDir);
  return { cfg, p: new Proceso(cfg, jira, store, testsFallan, fakeOs), jira, est: () => store.get("REC-1")! };
}

const BASE = {
  resumen: "Resumen suficientemente largo del pedido.", tipo: "cambio", criterios_aceptacion: ["c"],
  capacidades_afectadas: [], riesgos: [],
};
const ANALISIS_PREGUNTAS = (preguntas: string[]) => ({ ...BASE, preguntas_abiertas: preguntas, listo: false });
/** Análisis cerrado con el OK del analista, carril directo. */
const ANALISIS_OK = (over: Record<string, unknown> = {}) => ({
  ...BASE, preguntas_abiertas: [], listo: true, analista_ok: true, via: "desarrollo", carril: "directo",
  justificacion_carril: "Cambio acotado en un solo componente.", plan: ["Hacer el cambio (2h)"], estimacion_horas: 2,
  decisiones: [{ pregunta: "¿Qué formato?", respuesta: "CSV" }], ...over,
});

test("analista: preguntas al cliente, OK obligatorio, carril directo, SIS y orqen/work/", async () => {
  const { p, jira, est, cfg } = armar();
  const pend = await p.revisar();
  assert.deepEqual(pend.map((x) => [x.key, x.estado, x.para]), [["REC-1", "NUEVO", "analista"]]);
  await assert.rejects(p.tomar("REC-1", "x"), /no tiene trabajo/);

  await p.analizar("REC-1", "codex", "Ana");
  assert.equal(est().estado, "ANALISIS");
  assert.equal(est().analista, "Ana");
  assert.match(jira.coms["REC-1"][0].cuerpo, /Ana inició el análisis/);
  await assert.rejects(p.analizar("REC-1", "claude", "Bea"), /ya lo tomó "codex"/);
  await assert.rejects(p.tomar("REC-1", "codex"), /lo conduce un analista/);   // un agente no analiza solo

  assert.equal((await p.completar("REC-1", ANALISIS_PREGUNTAS(["¿x?"]), "claude")).ok, false);   // otro agente
  assert.equal((await p.completar("REC-1", { resumen: "corto" }, "codex")).ok, false);          // esquema

  // sin OK del analista / sin carril / directo sin plan: no cierra
  let r = await p.completar("REC-1", ANALISIS_OK({ analista_ok: false }), "codex");
  assert.match((r as any).errores.join(), /OK explícito/);
  r = await p.completar("REC-1", ANALISIS_OK({ carril: undefined }), "codex");
  assert.match((r as any).errores.join(), /elegí el carril/);
  r = await p.completar("REC-1", ANALISIS_OK({ plan: undefined }), "codex");
  assert.match((r as any).errores.join(), /plan de implementación/);
  assert.equal(jira.creados.length, 0);                                 // nada se creó a medias

  // lo que solo el cliente puede contestar → ESPERA_CLIENTE
  await p.completar("REC-1", ANALISIS_PREGUNTAS(["¿Qué formato?"]), "codex");
  assert.equal(est().estado, "ESPERA_CLIENTE");
  assert.match(jira.ultimo("REC-1"), /¿Qué formato\?/);
  await assert.rejects(p.analizar("REC-1", "codex", "Ana"), /esperando respuestas del cliente/);
  await p.revisar();
  assert.equal(est().estado, "ESPERA_CLIENTE");   // sin respuesta no avanza
  jira.humano("REC-1", "cliente", "CSV");
  const pend2 = await p.revisar();
  assert.equal(est().estado, "ANALISIS");
  assert.deepEqual(pend2.map((x) => [x.key, x.para]), [["REC-1", "analista"]]);

  const { contexto } = await p.analizar("REC-1", "codex", "Ana");
  assert.deepEqual(contexto.feedback_humano, [{ de: "cliente", texto: "CSV" }]);
  assert.equal(contexto.factory, "orqen/work/REC-1/ronda-1");

  assert.deepEqual(await p.carril("REC-1", "directo", "codex"), { carril: "directo", openspec: undefined, rama: undefined });
  assert.deepEqual(await p.completar("REC-1", ANALISIS_OK(), "codex"), { ok: true, siguiente: "DESARROLLO" });

  // SIS creado al cerrar, vinculado al REC, con el carril
  assert.equal(est().estado, "DESARROLLO");
  assert.equal(est().carril, "directo");
  assert.equal(jira.creados.length, 1);
  assert.equal(jira.creados[0].key, "SIS-1");
  assert.match(jira.creados[0].titulo, /^\[REC-1\]/);
  assert.match(jira.creados[0].descripcion, /Carril:\* directo/);
  assert.deepEqual((jira.creados[0] as any).labels, ["origen-rec-1", "carril-directo"]);
  assert.deepEqual(jira.links, [["SIS-1", "REC-1", "Relates"]]);
  assert.equal(est().sis, "SIS-1");
  assert.match(jira.coms["REC-1"].map((c) => c.cuerpo).join("\n"), /Creé SIS-1/);

  // registro en orqen/work/REC-1
  const f = join(cfg.factoryDir, "REC-1");
  const md = readFileSync(join(f, "ronda-1", "analisis.md"), "utf8");
  assert.match(md, /Analista:\*\* Ana/);
  assert.match(md, /Carril:\*\* directo/);
  assert.match(md, /SIS:\*\* SIS-1/);
  assert.match(md, /¿Qué formato\?\*\* → CSV/);
  assert.ok(existsSync(join(f, "ronda-1", "analisis.json")));
  const estado = JSON.parse(readFileSync(join(f, "estado.json"), "utf8"));
  assert.deepEqual([estado.estado, estado.carril, estado.sis, estado.analista], ["DESARROLLO", "directo", "SIS-1", "Ana"]);
  assert.match(readFileSync(join(f, "bitacora.md"), "utf8"), /ANALISIS → DESARROLLO/);
});

test("carril liviano: exige `orqen carril` y que el change coincida", async () => {
  const { p, jira, est } = armar();
  await p.analizar("REC-1", "codex", "Ana");
  const spec = { cambio: "rec-1-algo", resumen: "Resumen de la propuesta.", supuestos: ["s"] };
  const liviano = (over = {}) => ANALISIS_OK({ carril: "liviano", plan: undefined, estimacion_horas: undefined, especificacion: spec, ...over });

  let r = await p.completar("REC-1", liviano({ especificacion: undefined }), "codex");
  assert.match((r as any).errores.join(), /necesitan la spec/);
  r = await p.completar("REC-1", liviano(), "codex");                    // no corrió `orqen carril`
  assert.match((r as any).errores.join(), /orqen carril REC-1 liviano/);
  await assert.rejects(p.carril("REC-1", "gigante", "codex"), /Carril inválido/);

  assert.deepEqual(await p.carril("REC-1", "liviano", "codex"),
    { carril: "liviano", rama: "rec/rec-1", openspec: { cambio: "rec-1-algo", dir: "openspec/changes/rec-1-algo" } });
  r = await p.completar("REC-1", liviano({ especificacion: { ...spec, cambio: "otro" } }), "codex");
  assert.match((r as any).errores.join(), /debe ser "rec-1-algo"/);

  assert.deepEqual(await p.completar("REC-1", liviano(), "codex"), { ok: true, siguiente: "DESARROLLO" });
  assert.equal(est().cambio, "rec-1-algo");
  assert.equal(est().artefactos.estimacion_horas, 5);                    // 2h + 3h de tasks.md
  assert.match(jira.creados[0].descripcion, /OpenSpec change:\* openspec\/changes\/rec-1-algo/);
  assert.match(jira.creados[0].descripcion, /Estimación:\* 5 h/);
});

test("testing que falla 3 veces bloquea; /aprobar reintenta (carril directo: criterios como escenarios)", async () => {
  const { p, jira, est } = armar();
  await p.analizar("REC-1", "codex", "Ana");
  await p.completar("REC-1", ANALISIS_OK(), "codex");
  const dev = { completado: true, resumen_cambios: "x", archivos_modificados: [], tests_agregados: [] };
  const qa = { escenarios: [{ requisito: "Criterio de aceptación", escenario: "c", cubierto: true }], diagnostico_fallas: "falla", sugerencias: [], cobertura_ok: true };
  for (let i = 0; i < 3; i++) {
    await p.tomar("REC-1"); await p.completar("REC-1", dev);   // directo: no hay tasks.md que tildar
    const t = await p.tomar("REC-1");
    assert.deepEqual(t.contexto.escenarios, [{ capacidad: "-", requisito: "Criterio de aceptación", escenario: "c" }]);
    await p.completar("REC-1", qa);
  }
  assert.equal(est().estado, "BLOQUEADO");
  jira.humano("REC-1", "intruso", "/aprobar");
  await p.revisar();
  assert.equal(est().estado, "BLOQUEADO");
  jira.humano("REC-1", "senior", "/aprobar revisá el mock");
  await p.revisar();
  assert.equal(est().estado, "TESTING");
  assert.equal(est().intentosTesting, 0);
});

test("testing exige evaluar cada criterio y los hitos se espejan en el SIS", async () => {
  const { p, jira, est } = armar();
  await p.analizar("REC-1", "codex", "Ana");
  await p.completar("REC-1", ANALISIS_OK(), "codex");
  await p.tomar("REC-1");
  await p.completar("REC-1", { completado: true, resumen_cambios: "x", archivos_modificados: [], tests_agregados: [] });
  await p.tomar("REC-1");
  const r = await p.completar("REC-1", { escenarios: [], diagnostico_fallas: "", sugerencias: [], cobertura_ok: true });
  assert.match((r as any).errores.join(), /Faltan evaluar escenarios/);
  assert.equal(est().estado, "TESTING");
  assert.ok(jira.coms["SIS-1"].length >= 1);   // los hitos técnicos se espejan en el SIS
});

test("nombre del change", () => {
  assert.equal(nombreCambio("REC-123", "Exportación de facturas a CSV mensual", 1), "rec-123-exportacion-facturas-csv-mensual");
  assert.equal(nombreCambio("REC-123", "Exportación", 2), "rec-123-exportacion-r2");
});
