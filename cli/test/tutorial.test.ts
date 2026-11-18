/** orqen tutorial and orqen lang: language detection and the steps in both languages. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buscarPaso, buscarRepo, datosDelRepo } from "../src/commands/tutorial.ts";
import { detectarIdioma, normalizarIdioma } from "../src/lib/lang.ts";
import { pasosTutorial, TEMAS, type DatosTutorial } from "../src/tutorial/content.ts";
import { renderMarkdown, renderTerminal } from "../src/tutorial/render.ts";
import { pasosApp } from "../src/tutorial/app.ts";

test("normalizarIdioma: Spanish variants are es, anything else is en, C/POSIX/empty mean nothing", () => {
  for (const v of ["es", "es-AR", "es_ES.UTF-8", "Spanish", "español", '"es-419"']) assert.equal(normalizarIdioma(v), "es", v);
  for (const v of ["en-US", "en_GB.UTF-8", "pt-BR", "fr"]) assert.equal(normalizarIdioma(v), "en", v);
  for (const v of ["", "C", "C.UTF-8", "POSIX", undefined]) assert.equal(normalizarIdioma(v), undefined, String(v));
});

test("detectarIdioma: ORQEN_LANG wins, then LC_ALL / LANG", () => {
  assert.equal(detectarIdioma({ ORQEN_LANG: "en", LANG: "es_AR.UTF-8" }, "linux"), "en");
  assert.equal(detectarIdioma({ LANG: "es_AR.UTF-8" }, "linux"), "es");
  assert.equal(detectarIdioma({ LC_ALL: "en_US.UTF-8", LANG: "es_AR.UTF-8" }, "linux"), "en");
  assert.equal(detectarIdioma({ LANG: "C.UTF-8", LANGUAGE: "es" }, "linux"), "es");
});

const base: DatosTutorial = {
  proyecto: "pagos", procesos: [
    { nombre: "api", comando: "npm run dev", puerto: 3000, cuando: "siempre" },
    { nombre: "web", comando: "npm run dev", puerto: 5173, cuando: "e2e" },
  ],
  tests: ["unitarios"], externo: "SOP-123", interno: "DEV-456", herramienta: "Jira", herramientaInterna: "Jira", soporte: false, gate: "github", ramaDevel: "desarrollo",
  windows: false, db: true, conectado: true,
};

test("both languages have the same steps, in order, and render without placeholders", () => {
  const es = pasosTutorial(base, "es"), en = pasosTutorial(base, "en");
  assert.deepEqual(es.map((p) => p.id), [...TEMAS]);
  assert.deepEqual(en.map((p) => p.id), [...TEMAS]);
  for (const [i, p] of es.entries()) {
    assert.equal(p.bloques.length, en[i].bloques.length, `blocks of ${p.id}`);
    for (const out of [renderMarkdown(p, "x"), renderTerminal(p, "x"), renderMarkdown(en[i], "x")])
      assert.doesNotMatch(out, /undefined|null|NaN|\[object/, p.id);
  }
  assert.match(renderMarkdown(es[0], "Paso 1 de 12"), /^### Paso 1 de 12 · Bienvenida/);
  assert.match(renderMarkdown(en[0], "Step 1 of 12"), /^### Step 1 of 12 · Welcome/);
});

test("steps use the repository's data: processes, URLs, keys, gate, platform", () => {
  const env = (d: DatosTutorial, i: "es" | "en" = "es") => renderMarkdown(pasosTutorial(d, i).find((p) => p.id === "env")!, "x");
  assert.match(env(base), /api\s+http:\/\/localhost:3000/);
  assert.match(env(base), /web\s+http:\/\/localhost:5173\s+\(solo para tests e2e\)/);
  assert.match(env(base), /tail -f orqen\/state\/logs\/api\.log/);
  assert.match(env(base), /db\.mjs status/);
  assert.match(env({ ...base, windows: true }), /Get-Content orqen\\state\\logs\\api\.log -Wait -Tail 50/);
  assert.match(env({ ...base, procesos: [] }, "en"), /No parts are configured/);

  const next = (d: DatosTutorial) => renderMarkdown(pasosTutorial(d, "en").find((p) => p.id === "next")!, "x");
  assert.match(next({ ...base, externo: "SOPL-123", interno: "DEV-456" }), /\/orqen:analyze SOPL-123[\s\S]*\/orqen:implement DEV-456/);
  assert.match(next(base), /Approve on GitHub/);
  assert.match(next({ ...base, gate: "ticket" }), /then \/approve in Jira/);
  assert.match(next({ ...base, gate: "ticket", herramienta: "GitHub" }), /then \/approve in GitHub/);
  assert.match(next({ ...base, herramientaInterna: undefined, interno: "SOP-123" }), /\/orqen:implement SOP-123/);
  assert.doesNotMatch(next(base), /SUPPORT/);
  assert.match(next({ ...base, soporte: true }), /SUPPORT\s+support\s+\/orqen:support/);
});

test("buscarPaso accepts a number or an id; buscarRepo walks up to orqen/config.yaml; datosDelRepo reads the .env of earlier versions", () => {
  const pasos = pasosTutorial(base, "es");
  assert.equal(buscarPaso(pasos, "1"), 0);
  assert.equal(buscarPaso(pasos, "env"), TEMAS.indexOf("env"));
  assert.equal(buscarPaso(pasos, "ENV"), TEMAS.indexOf("env"));
  assert.equal(buscarPaso(pasos, "99"), -1);
  assert.equal(buscarPaso(pasos, "nope"), -1);

  const repo = mkdtempSync(join(tmpdir(), "orqen-tut-"));
  mkdirSync(join(repo, "orqen"), { recursive: true });
  mkdirSync(join(repo, "src", "deep"), { recursive: true });
  writeFileSync(join(repo, "orqen", "config.yaml"), "version: 1\n");
  writeFileSync(join(repo, "orqen", ".env"), "REC_JQL=project = SOPL AND labels = x\nSIS_PROJECT=DEV\nSUPPORT_STAGE=on\nCODE_REVIEW_GATE=jira\nJIRA_TOKEN=secret\n");
  assert.equal(buscarRepo(join(repo, "src", "deep")), repo);
  const d = datosDelRepo(repo, "win32");
  assert.equal(d.externo, "SOPL-123");
  assert.equal(d.interno, "DEV-456");
  assert.equal(d.soporte, true);
  assert.equal(d.gate, "ticket");
  assert.equal(d.windows, true);
  assert.equal(d.conectado, false);   // no JIRA_URL
  assert.doesNotMatch(JSON.stringify(pasosTutorial(d, "es")), /secret/);
});

test("pasosApp: every step also says how to do it in the desktop app, in both languages", () => {
  const d: DatosTutorial = { proyecto: "demo", procesos: [], tests: [], externo: "SOP-1", interno: "DEV-2", herramienta: "Jira", herramientaInterna: "Jira",
    soporte: false, gate: "github", ramaDevel: "develop", windows: false, db: false, conectado: true };
  for (const idioma of ["es", "en"] as const) {
    const app = pasosApp(d, idioma);
    for (const id of TEMAS) {
      assert.ok(app[id]?.bloques.length, `${idioma}/${id}`);
      assert.ok(!app[id].pantalla || ["pending", "env", "connectors"].includes(app[id].pantalla!), id);
    }
  }
});
