/** The workflow manages environments using orqen/config.yaml. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { cargarConfig } from "../src/workflow/config.ts";
import type { OpenSpecApi } from "../src/workflow/openspec.ts";
import { Proceso } from "../src/workflow/workflow.ts";
import { Store } from "../src/workflow/store.ts";
import { GitWorkspace, type Workspace } from "../src/workflow/workspace.ts";
import { FakeJira } from "./fakes.ts";

const fakeOs: OpenSpecApi = {
  nuevoCambio: (id) => id, existe: () => true, dir: (id) => id,
  validar: () => ({ ok: true, problemas: [] }), planificacionCompleta: () => true,
  tareas: () => [], escenarios: () => [], archivar: () => ({ archivadoComo: "x", totales: {} }),
};

test("development manages its environment and testing starts apps, runs the suite, and tears down", async () => {
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
    resumen: "Adjust rounding for the invoice total.", tipo: "bug", criterios_aceptacion: ["c"], capacidades_afectadas: [], preguntas_abiertas: [],
    riesgos: [], listo: true, analista_ok: true, via: "desarrollo", carril: "directo", justificacion_carril: "Un solo componente, bajo riesgo.", plan: ["Ajustar (1h)"], estimacion_horas: 1,
  }, "a");
  assert.deepEqual(pasos, [], "analysis starts no services");

  const dev = await p.tomar("REC-1", "impl");
  assert.deepEqual(pasos, ["levantar(servicios)"]);
  assert.equal((dev.contexto as any).entorno.ok, true);
  assert.equal((dev.contexto as any).entorno.comandos.unitarios, "orqen env test unitarios");
  assert.deepEqual(await p.completar("REC-1", { completado: true, resumen_cambios: "x", archivos_modificados: [], tests_agregados: [] }, "impl"), { ok: true, siguiente: "TESTING" });
  assert.deepEqual(pasos, ["levantar(servicios)", "bajar"]);

  await p.tomar("REC-1", "qa");
  assert.deepEqual(pasos, ["levantar(servicios)", "bajar", "levantar(apps)", "tests", "bajar"]);
});

test("GitWorkspace runs configured tests with environment variables and skips Docker without services", () => {
  const dir = mkdtempSync(join(tmpdir(), "orqen-ws-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  writeFileSync(join(dir, "docker-compose.orqen.yml"), "name: x\nservices: {}\n");
  const cfg = cargarConfig({
    repoPath: dir, estadoDir: join(dir, "estado"),
    entorno: {
      compose: "docker-compose.orqen.yml", variables: { SALUDO: "hola" },
      preparar: [`node -e "require('fs').writeFileSync('preparado.txt', process.env.SALUDO)"`],
      migrar: [`node -e "require('fs').writeFileSync('migrado.txt', '1')"`], seed: [],
      tests: { unitarios: `node -e "process.exit(process.env.SALUDO === 'hola' ? 0 : 1)"`, e2e: `node -e "console.log('e2e failed'); process.exit(1)"`, visual: null },
    },
  });
  const ws = new GitWorkspace(cfg);
  const e = ws.levantarEntorno(true);
  assert.equal(e.ok, true, e.detalle);
  assert.match(e.detalle, /dependencies installed, migrations applied/);
  assert.doesNotMatch(e.detalle, /servicios/);
  assert.equal(readFileSync(join(dir, "preparado.txt"), "utf8"), "hola");
  assert.ok(existsSync(join(dir, "migrado.txt")));
  assert.deepEqual(e.comandos, { unitarios: "orqen env test unitarios", e2e: "orqen env test e2e" });

  const r = ws.correrTests();
  assert.equal(r.ok, false);
  assert.match(r.salida, /tests unitarios: .* → OK/);
  assert.match(r.salida, /tests e2e: .* → FAILED[\s\S]*e2e failed/);
  ws.bajarEntorno();   // Teardown needs no Docker when there are no services.

  // The agent context identifies the failed step.
  const roto = new GitWorkspace({ ...cfg, entorno: { ...cfg.entorno!, preparar: [`node -e "console.error('network unavailable'); process.exit(1)"`] } });
  const f = roto.levantarEntorno(false);
  assert.equal(f.ok, false);
  assert.match(f.detalle, /Failed/);
  assert.match(f.salida!, /network unavailable/);
});
