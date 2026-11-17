import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { aplicar, extraerBloque, leerManifest, planificar, type Decision } from "../src/lib/kit.ts";
import { fusionarConfigOpenSpec } from "../src/lib/openspec.ts";
import { completarEnv, jqlDeProyecto, parsearEnv, proyectoDeJql } from "../src/lib/env.ts";
import { repoTemporal } from "./ayuda.ts";

const vars = { RESUMEN_STACK: "Stack de prueba.", RAMA_BASE: "main", AGENTE_CMD: "claude -p" };
const siempre = (d: Decision) => async () => d;
const leer = (repo: string, r: string) => readFileSync(join(repo, r), "utf8");

test("instala el kit en un repo limpio y la segunda pasada no cambia nada", async () => {
  const repo = repoTemporal();
  const plan = planificar(repo, vars, { extra: { "docker-compose.orqen.yml": "services: {}\n" } });
  assert.ok(plan.every((c) => c.accion === "crear"));
  await aplicar(repo, plan, siempre("sobrescribir"));

  assert.ok(existsSync(join(repo, ".orqen/etapas/desarrollo.md")));
  assert.ok(existsSync(join(repo, ".orqen/plugin/.claude-plugin/plugin.json")));
  assert.ok(existsSync(join(repo, ".orqen/.env")), ".env local creado desde el ejemplo");
  assert.match(leer(repo, "AGENTS.md"), /orqen:inicio[\s\S]*Stack de prueba\.[\s\S]*orqen:fin/);
  assert.equal(leer(repo, "CLAUDE.md"), "@AGENTS.md\n");
  assert.match(leer(repo, ".gitignore"), /\.orqen\/estado\//);
  assert.equal(JSON.parse(leer(repo, ".claude-plugin/marketplace.json")).plugins[0].source, "./.orqen/plugin");
  assert.match(leer(repo, ".orqen/.env.example"), /AGENTE_CMD=claude -p/);
  assert.ok(Object.keys(leerManifest(repo).archivos).includes("AGENTS.md#orqen"));

  const otra = planificar(repo, vars, { extra: { "docker-compose.orqen.yml": "services: {}\n" } });
  assert.deepEqual(otra.filter((c) => c.accion !== "igual").map((c) => c.ruta), []);
});

test("respeta el AGENTS.md y el CLAUDE.md del equipo y solo maneja su bloque", async () => {
  const repo = repoTemporal({ "AGENTS.md": "# Reglas del equipo\n\nUsá tabs.\n", "CLAUDE.md": "Hablá en español.\n" });
  await aplicar(repo, planificar(repo, vars), siempre("sobrescribir"));
  const a = leer(repo, "AGENTS.md");
  assert.ok(a.startsWith("# Reglas del equipo\n\nUsá tabs."));
  assert.match(a, /orqen:inicio/);
  assert.equal(leer(repo, "CLAUDE.md"), "Hablá en español.\n\n@AGENTS.md\n");

  // Cambia el stack → el bloque se actualiza solo (nadie lo tocó) y el resto queda igual
  const plan = planificar(repo, { ...vars, RESUMEN_STACK: "Stack nuevo." });
  assert.equal(plan.find((c) => c.ruta === "AGENTS.md")!.accion, "actualizar");
  await aplicar(repo, plan, siempre("sobrescribir"));
  assert.match(extraerBloque(leer(repo, "AGENTS.md"))!, /Stack nuevo\./);
  assert.ok(leer(repo, "AGENTS.md").startsWith("# Reglas del equipo"));
});

test("archivo editado por el equipo: conflicto, y cada decisión hace lo que dice", async () => {
  const repo = repoTemporal();
  await aplicar(repo, planificar(repo, vars), siempre("sobrescribir"));
  const ruta = ".orqen/etapas/testing.md";
  writeFileSync(join(repo, ruta), "# Mi guía de testing\n");

  // Simula una versión nueva del kit: otro AGENTE_CMD cambia .env.example (no editado) → actualizar
  const nuevas = { ...vars, AGENTE_CMD: "codex exec --full-auto -" };
  const plan = planificar(repo, nuevas);
  assert.equal(plan.find((c) => c.ruta === ".orqen/.env.example")!.accion, "actualizar");
  assert.equal(plan.find((c) => c.ruta === ruta)!.accion, "conflicto");

  const res = await aplicar(repo, plan, siempre("nuevo"));
  assert.equal(leer(repo, ruta), "# Mi guía de testing\n", "no pisa lo del equipo");
  assert.ok(existsSync(join(repo, `${ruta}.orqen-nuevo`)));
  assert.equal(res.find((r) => r.ruta === ruta)!.accion, "guardado-al-lado");
  assert.match(leer(repo, ".orqen/.env.example"), /codex exec/);

  await aplicar(repo, planificar(repo, nuevas), siempre("mantener"));
  assert.equal(leer(repo, ruta), "# Mi guía de testing\n");
  await aplicar(repo, planificar(repo, nuevas), siempre("sobrescribir"));
  assert.match(leer(repo, ruta), /Etapa TESTING/);
});

test("fusiona las reglas en openspec/config.yaml sin borrar las del equipo ni los comentarios", async () => {
  const actual = [
    "schema: spec-driven",
    "",
    "context: |",
    "  Language: es",
    "  Stack: NestJS",
    "",
    "# reglas propias",
    "rules:",
    "  proposal:",
    "    - Máximo 500 palabras",
    "",
  ].join("\n");
  const frag = "context: |\n  Language: es\n  Cada change es un REC.\nrules:\n  proposal:\n    - Citá el REC.\n  tasks:\n    - Estimá en horas.\noperations:\n  apply:\n    guidance:\n      - No hagas commits.\n";
  const r = fusionarConfigOpenSpec(actual, frag);
  assert.match(r, /# reglas propias/);
  assert.match(r, /Stack: NestJS\n\s+Cada change es un REC\./);
  assert.equal((r.match(/Language: es/g) ?? []).length, 1);
  assert.match(r, /- Máximo 500 palabras\n\s+- Citá el REC\./);
  assert.match(r, /tasks:\n\s+- Estimá en horas\./);
  assert.match(r, /guidance:\n\s+- No hagas commits\./);
  assert.equal(fusionarConfigOpenSpec(r, frag), r, "idempotente");

  // Con el openspec/ presente, el plan del kit lo incluye
  const repo = repoTemporal({ "openspec/config.yaml": actual });
  mkdirSync(join(repo, "openspec", "specs"), { recursive: true });
  const plan = planificar(repo, vars);
  assert.equal(plan.find((c) => c.ruta === "openspec/config.yaml")!.accion, "actualizar");
});

test(".env: se completa desde el ejemplo conservando comentarios, y se vuelve a leer igual", () => {
  const plantilla = [
    "JIRA_URL=https://tu-empresa.atlassian.net",
    "JIRA_DEPLOYMENT=cloud            # cloud | server",
    "JIRA_TOKEN=",
    "REC_JQL=project = REC AND labels = rec-agente AND statusCategory != Done",
    "# comentario suelto",
    "SIS_PROYECTO=SIS",
    "",
  ].join("\n");
  const r = completarEnv(plantilla, { JIRA_URL: "https://acme.atlassian.net", JIRA_DEPLOYMENT: "server", JIRA_TOKEN: "abc#123", REC_JQL: jqlDeProyecto("PAG"), OTRA: "x" });
  assert.match(r, /^JIRA_URL=https:\/\/acme\.atlassian\.net$/m);
  assert.match(r, /^JIRA_DEPLOYMENT=server            # cloud \| server$/m);
  assert.match(r, /^JIRA_TOKEN='abc#123'$/m);
  assert.match(r, /# comentario suelto/);
  assert.match(r, /^SIS_PROYECTO=SIS$/m, "lo que no se pasa queda como en el ejemplo");
  assert.match(r, /^OTRA=x$/m);
  const leido = parsearEnv(r);
  assert.equal(leido.JIRA_TOKEN, "abc#123");
  assert.equal(leido.JIRA_DEPLOYMENT, "server");
  assert.equal(proyectoDeJql(leido.REC_JQL), "PAG");
  // Node lo lee igual que nosotros
  const repo = repoTemporal();
  writeFileSync(join(repo, "x.env"), r);
  delete process.env.JIRA_TOKEN;
  process.loadEnvFile(join(repo, "x.env"));
  assert.equal(process.env.JIRA_TOKEN, "abc#123");
  assert.equal(process.env.JIRA_DEPLOYMENT, "server");
});
