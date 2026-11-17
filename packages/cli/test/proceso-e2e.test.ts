/**
 * Recorrido completo de un REC con OpenSpec REAL, git REAL y Jira simulado.
 * El "agente" es este test: escribe los archivos y las salidas JSON que escribiría un LLM.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DIR_PLANTILLAS } from "orqen-kit";
import { cargarConfig } from "../src/proceso/config.ts";
import { OpenSpecCli } from "../src/proceso/openspec.ts";
import { Proceso } from "../src/proceso/proceso.ts";
import { Store } from "../src/proceso/store.ts";
import { GitWorkspace } from "../src/proceso/workspace.ts";
import { FakeJira } from "./fakes.ts";

const OPENSPEC = fileURLToPath(new URL(`../node_modules/.bin/openspec${process.platform === "win32" ? ".cmd" : ""}`, import.meta.url));

function repoTemporal() {
  const dir = mkdtempSync(join(tmpdir(), "rec-e2e-"));
  const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@t"); git("config", "user.name", "t");
  mkdirSync(join(dir, "openspec", "specs"), { recursive: true });
  mkdirSync(join(dir, "openspec", "changes", "archive"), { recursive: true });
  cpSync(join(DIR_PLANTILLAS, "openspec", "config.yaml"), join(dir, "openspec", "config.yaml"));
  writeFileSync(join(dir, "openspec", "specs", ".gitkeep"), "");
  writeFileSync(join(dir, "openspec", "changes", "archive", ".gitkeep"), "");
  writeFileSync(join(dir, "exportar.mjs"), "export const exportar = () => '';\n");
  writeFileSync(join(dir, "test.mjs"), "import {exportar} from './exportar.mjs'; if (exportar([{n:1}]) !== 'n\\n1') process.exit(1);\n");
  git("add", "-A"); git("commit", "-qm", "init");
  return { dir, git };
}

test("REC completo con OpenSpec real", { skip: !existsSync(OPENSPEC) && "falta openspec" }, async () => {
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

  // ---- ANALISIS conducido por el analista
  assert.deepEqual((await p.revisar()).map((x) => [x.key, x.estado, x.para]), [["REC-7", "NUEVO", "analista"]]);
  await p.analizar("REC-7", "analista-bot", "Ana");
  assert.equal(git("rev-parse", "--abbrev-ref", "HEAD").trim(), "main");   // el grilling no toca la rama

  // carril completo: `orqen lane` crea rama + change de OpenSpec
  const c = await p.carril("REC-7", "completo", "analista-bot");
  const cambio = c.openspec!.cambio;
  assert.equal(cambio, "rec-7-exportar-facturas-csv");
  assert.equal(git("rev-parse", "--abbrev-ref", "HEAD").trim(), "rec/rec-7");
  const cdir = join(dir, "openspec", "changes", cambio);
  const analisis = {
    resumen: "El área contable necesita exportar facturas a CSV para conciliar.", tipo: "funcionalidad",
    criterios_aceptacion: ["Dado facturas, cuando exporto, entonces obtengo CSV con encabezado"],
    capacidades_afectadas: ["facturacion-exportacion"], preguntas_abiertas: [], riesgos: [], listo: true,
    decisiones: [{ pregunta: "¿Solo CSV?", respuesta: "Sí, Excel queda fuera" }],
    analista_ok: true, via: "desarrollo", carril: "completo", justificacion_carril: "Capacidad nueva con contrato hacia contabilidad.",
    especificacion: { cambio, resumen: "Exportación de facturas a CSV.", supuestos: [] },
  };

  // sin artefactos → rechazada por OpenSpec; nada se creó en Jira
  let r = await p.completar("REC-7", analisis, "analista-bot");
  assert.equal(r.ok, false);
  assert.equal(jira.creados.length, 0);

  writeFileSync(join(cdir, "proposal.md"), `# Proposal\n\n## Why\n\nREC-7: el área contable concilia a mano.\n\n## What Changes\n\nExportar facturas a CSV. Fuera de alcance: Excel.\n\n## Capabilities\n\n### New Capabilities\n- \`facturacion-exportacion\`: exportar facturas a CSV\n\n### Modified Capabilities\n\n## Impact\n\nexportar.mjs\n`);
  mkdirSync(join(cdir, "specs", "facturacion-exportacion"), { recursive: true });
  writeFileSync(join(cdir, "specs", "facturacion-exportacion", "spec.md"), `# Spec Delta\n\n## Purpose\nPermitir exportar facturas a CSV para la conciliación contable del cliente.\n\n## ADDED Requirements\n\n### Requirement: Exportar a CSV\nEl sistema SHALL generar un CSV con encabezado y una fila por factura.\n\n#### Scenario: Facturas con encabezado\n- **WHEN** se exporta una lista de facturas\n- **THEN** el CSV tiene encabezado y una fila por factura\n`);
  writeFileSync(join(cdir, "design.md"), "# Design\n\n## Context\nFunción pura.\n\n## Goals / Non-Goals\n**Goals:** CSV.\n\n## Decisions\nSin dependencias.\n\n## Risks / Trade-offs\nNinguno.\n");
  writeFileSync(join(cdir, "tasks.md"), "# Tasks\n\n## 1. Exportación\n\n- [ ] 1.1 Implementar exportar\n- [ ] 1.2 Test del escenario (1h)\n");

  r = await p.completar("REC-7", analisis, "analista-bot");
  assert.equal(r.ok, false);
  assert.match((r as any).errores.join(), /estimación/);   // falta (Nh) en 1.1
  assert.equal(jira.creados.length, 0);

  writeFileSync(join(cdir, "tasks.md"), "# Tasks\n\n## 1. Exportación\n\n- [ ] 1.1 Implementar exportar (2h)\n- [ ] 1.2 Test del escenario (1h)\n");
  r = await p.completar("REC-7", analisis, "analista-bot");
  assert.deepEqual(r, { ok: true, siguiente: "DESARROLLO" });   // el OK del analista reemplaza a los gates de análisis y de spec
  assert.equal(estado(), "DESARROLLO");
  assert.match(jira.coms["REC-7"].map((x) => x.cuerpo).join("\n"), /3 h estimadas/);
  assert.match(git("log", "--format=%s"), /spec OpenSpec/);

  // ---- orqen/work/REC-7 quedó commiteado en la rama y el árbol limpio (se puede cambiar de rama)
  const tracked = git("ls-files", "orqen/work/REC-7").split("\n");
  assert.ok(tracked.includes("orqen/work/REC-7/ronda-1/analisis.md"));
  assert.ok(tracked.includes("orqen/work/REC-7/bitacora.md"));
  assert.ok(tracked.includes("orqen/work/REC-7/estado.json"));
  assert.equal(git("status", "--porcelain", "--untracked-files=no").trim(), "");
  assert.match(readFileSync(join(dir, "orqen", "work", "REC-7", "ronda-1", "analisis.md"), "utf8"), /Excel queda fuera/);
  assert.equal(JSON.parse(readFileSync(join(dir, "orqen", "work", "REC-7", "estado.json"), "utf8")).estado, "DESARROLLO");

  // ---- al cerrar el análisis nace el SIS, vinculado al REC
  assert.equal(jira.creados.length, 1);
  assert.equal(jira.creados[0].key, "SIS-1");
  assert.equal(jira.creados[0].proyecto, "SIS");
  assert.match(jira.creados[0].titulo, /^\[REC-7\]/);
  assert.deepEqual(jira.links, [["SIS-1", "REC-7", "Relates"]]);
  assert.equal(new Store(cfg.estadoDir).get("REC-7")!.sis, "SIS-1");
  assert.match(jira.coms["REC-7"].map((c) => c.cuerpo).join("\n"), /Creé SIS-1/);

  // ---- DESARROLLO
  await p.tomar("REC-7");
  writeFileSync(join(dir, "exportar.mjs"), "export const exportar = (fs) => ['n', ...fs.map(f => f.n)].join('\\n');\n");
  const dev = { completado: true, resumen_cambios: "Implementé exportar()", archivos_modificados: ["exportar.mjs"], tests_agregados: ["test.mjs"] };
  r = await p.completar("REC-7", dev);
  assert.match((r as any).errores.join(), /sin tildar/);
  writeFileSync(join(cdir, "tasks.md"), readFileSync(join(cdir, "tasks.md"), "utf8").replaceAll("- [ ]", "- [x]"));
  r = await p.completar("REC-7", dev);
  assert.deepEqual(r, { ok: true, siguiente: "TESTING" });
  assert.match(jira.ultimo("SIS-1"), /Desarrollo listo/);   // el hito técnico se espeja en el SIS

  // ---- TESTING (tests reales pasan)
  const t = await p.tomar("REC-7");
  assert.equal(t.contexto.resultado_tests.ok, true);
  assert.equal(t.contexto.escenarios!.length, 1);
  r = await p.completar("REC-7", { escenarios: [], diagnostico_fallas: "", sugerencias: [], cobertura_ok: true });
  assert.match((r as any).errores.join(), /Faltan evaluar escenarios/);
  r = await p.completar("REC-7", {
    escenarios: [{ requisito: "Exportar a CSV", escenario: "Facturas con encabezado", cubierto: true, test: "test.mjs" }],
    diagnostico_fallas: "", sugerencias: [], cobertura_ok: true,
  });
  assert.deepEqual(r, { ok: true, siguiente: "REVISION_CODIGO" });

  jira.humano("REC-7", "senior", "/aprobar");
  await p.revisar();
  assert.equal(estado(), "ENTREGA");

  // ---- ENTREGA: tomar archiva el change → spec fusionada en openspec/specs
  await p.tomar("REC-7");
  assert.ok(existsSync(join(dir, "openspec", "specs", "facturacion-exportacion", "spec.md")));
  assert.ok(!existsSync(cdir));
  r = await p.completar("REC-7", { notas_release: "n", mensaje_cliente: "Ya podés exportar facturas a CSV desde el módulo.", pasos_validacion: ["Exportar"] });
  assert.deepEqual(r, { ok: true, siguiente: "CONFORMIDAD" });

  // ---- cliente rechaza → ronda 2 con change nuevo
  jira.humano("REC-7", "cliente", "/rechazar falta el total");
  await p.revisar();
  const rec = new Store(cfg.estadoDir).get("REC-7")!;
  assert.equal(rec.estado, "ANALISIS");
  assert.equal(rec.ronda, 2);
  assert.equal(rec.cambio, "");
  assert.equal(rec.sis, undefined);                          // la ronda 2 tendrá un SIS nuevo
  assert.deepEqual(rec.artefactos.sis_previos, ["SIS-1"]);
  assert.deepEqual(rec.feedback, [{ de: "cliente", rechazo: "falta el total" }]);
});
