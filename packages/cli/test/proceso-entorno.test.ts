/** El proceso levanta y baja los entornos solo (orqen/config.yaml), sin que nadie corra `orqen env ...` a mano. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { cargarConfig } from "../src/proceso/config.ts";
import type { OpenSpecApi } from "../src/proceso/openspec.ts";
import { Proceso } from "../src/proceso/proceso.ts";
import { Store } from "../src/proceso/store.ts";
import { GitWorkspace, type Workspace } from "../src/proceso/workspace.ts";
import { FakeJira } from "./fakes.ts";

const fakeOs: OpenSpecApi = {
  nuevoCambio: (id) => id, existe: () => true, dir: (id) => id,
  validar: () => ({ ok: true, problemas: [] }), planificacionCompleta: () => true,
  tareas: () => [], escenarios: () => [], archivar: () => ({ archivadoComo: "x", totales: {} }),
};

test("implementar: tomar DESARROLLO levanta el entorno, completar lo baja; TESTING levanta con apps, testea y baja", async () => {
  const pasos: string[] = [];
  const ws: Workspace = {
    prepararRama: () => "rec/rec-1", commit: () => true, push: () => {}, abrirPr: () => "",
    levantarEntorno: (apps) => { pasos.push(`levantar(${apps ? "apps" : "servicios"})`); return { ok: true, detalle: "Entorno listo.", variables: { DATABASE_URL: "x" }, comandos: { unitarios: "orqen env test unitarios" } }; },
    bajarEntorno: () => { pasos.push("bajar"); },
    correrTests: () => { pasos.push("tests"); return { ok: true, salida: "" }; },
  };
  const dir = mkdtempSync(join(tmpdir(), "orqen-ent-"));
  const cfg = cargarConfig({ repoPath: dir, estadoDir: join(dir, "estado"), factoryDir: join(dir, "factory"), jql: "x", transicionesJira: {}, aprobadores: { analisis: [], codigo: [], cliente: [] } });
  const p = new Proceso(cfg, new FakeJira({ "REC-1": { titulo: "Ajuste" } }), new Store(cfg.estadoDir), ws, fakeOs);
  await p.revisar();
  await p.analizar("REC-1", "a", "Ana");
  await p.completar("REC-1", {
    resumen: "Ajustar el redondeo del total de la factura.", tipo: "bug", criterios_aceptacion: ["c"], capacidades_afectadas: [], preguntas_abiertas: [],
    riesgos: [], listo: true, analista_ok: true, via: "desarrollo", carril: "directo", justificacion_carril: "Un solo componente, bajo riesgo.", plan: ["Ajustar (1h)"], estimacion_horas: 1,
  }, "a");
  assert.deepEqual(pasos, [], "el análisis no levanta nada");

  const dev = await p.tomar("REC-1", "impl");
  assert.deepEqual(pasos, ["levantar(servicios)"]);
  assert.equal((dev.contexto as any).entorno.ok, true);
  assert.equal((dev.contexto as any).entorno.comandos.unitarios, "orqen env test unitarios");
  assert.deepEqual(await p.completar("REC-1", { completado: true, resumen_cambios: "x", archivos_modificados: [], tests_agregados: [] }, "impl"), { ok: true, siguiente: "TESTING" });
  assert.deepEqual(pasos, ["levantar(servicios)", "bajar"]);

  await p.tomar("REC-1", "qa");
  assert.deepEqual(pasos, ["levantar(servicios)", "bajar", "levantar(apps)", "tests", "bajar"]);
});

test("GitWorkspace: prepara, corre cada tipo de test con las variables del entorno y no usa Docker si no hay servicios", () => {
  const dir = mkdtempSync(join(tmpdir(), "orqen-ws-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  writeFileSync(join(dir, "docker-compose.orqen.yml"), "name: x\nservices: {}\n");
  const cfg = cargarConfig({
    repoPath: dir, estadoDir: join(dir, "estado"),
    entorno: {
      compose: "docker-compose.orqen.yml", variables: { SALUDO: "hola" },
      preparar: [`node -e "require('fs').writeFileSync('preparado.txt', process.env.SALUDO)"`],
      migrar: [`node -e "require('fs').writeFileSync('migrado.txt', '1')"`], seed: [],
      tests: { unitarios: `node -e "process.exit(process.env.SALUDO === 'hola' ? 0 : 1)"`, e2e: `node -e "console.log('e2e mal'); process.exit(1)"`, visual: null },
    },
  });
  const ws = new GitWorkspace(cfg);
  const e = ws.levantarEntorno(true);
  assert.equal(e.ok, true, e.detalle);
  assert.match(e.detalle, /dependencias instaladas, migraciones aplicadas/);
  assert.doesNotMatch(e.detalle, /servicios/);
  assert.equal(readFileSync(join(dir, "preparado.txt"), "utf8"), "hola");
  assert.ok(existsSync(join(dir, "migrado.txt")));
  assert.deepEqual(e.comandos, { unitarios: "orqen env test unitarios", e2e: "orqen env test e2e" });

  const r = ws.correrTests();
  assert.equal(r.ok, false);
  assert.match(r.salida, /tests unitarios: .* → OK/);
  assert.match(r.salida, /tests e2e: .* → FALLÓ[\s\S]*e2e mal/);
  ws.bajarEntorno();   // sin servicios: no hace nada (y no rompe sin Docker)

  // Si un paso falla, se informa cuál y el agente lo ve en el contexto
  const roto = new GitWorkspace({ ...cfg, entorno: { ...cfg.entorno!, preparar: [`node -e "console.error('sin red'); process.exit(1)"`] } });
  const f = roto.levantarEntorno(false);
  assert.equal(f.ok, false);
  assert.match(f.detalle, /Falló/);
  assert.match(f.salida!, /sin red/);
});
