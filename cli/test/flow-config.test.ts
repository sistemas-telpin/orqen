/** The flow settings live in orqen/config.yaml (flujo); a variable in orqen/.env or the environment still overrides each one. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { stringify } from "yaml";
import { loadConfig } from "../src/workflow/config.ts";

const VARS = ["SUPPORT_STAGE", "APPROVERS_QA", "APPROVERS_CODE", "CODE_REVIEW_GATE", "GITHUB_REVIEWERS", "DEVEL_BRANCH", "TEST_COMMAND", "ORQEN_LOCK_MIN", "REC_LOCK_MIN"];

function inRepo(flujo: unknown, fn: () => void) {
  const repo = realpathSync.native(mkdtempSync(join(tmpdir(), "orqen-flujo-")));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  mkdirSync(join(repo, "orqen"));
  writeFileSync(join(repo, "orqen/config.yaml"), stringify({
    version: 1, orqen: { cli: "0.1.0", kit: "0.1.0" }, proyecto: { nombre: "x", rama_base: "main" },
    openspec: { instalacion: "global" }, stack: { resumen: "x" }, entornos: {}, flujo,
  }));
  const saved = Object.fromEntries(VARS.map((k) => [k, process.env[k]]));
  for (const k of VARS) delete process.env[k];
  const cwd = process.cwd();
  try { process.chdir(repo); fn(); } finally {
    process.chdir(cwd);
    for (const k of VARS) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  }
}

test("loadConfig reads the flow settings from config.yaml (flujo)", () => {
  inRepo({
    soporte: true, aprobadores: { qa: ["ana", "beto"], codigo: "seni, otro" },
    code_review: { gate: "ticket", revisores: ["octo"] }, rama_desarrollo: "develop", comando_tests: "pnpm test", lock_min: 30,
  }, () => {
    const c = loadConfig();
    assert.equal(c.supportStage, true);
    assert.deepEqual(c.approvers.qa, ["ana", "beto"]);
    assert.deepEqual(c.approvers.code, ["seni", "otro"]);
    assert.deepEqual(c.approvers.client, []);
    assert.equal(c.codeReviewGate, "ticket");
    assert.deepEqual(c.githubReviewers, ["octo"]);
    assert.equal(c.develBranch, "develop");
    assert.equal(c.testCommand, "pnpm test");
    assert.equal(c.lockMinutes, 30);
  });
});

test("a variable in orqen/.env or the environment overrides config.yaml; without either, the defaults", () => {
  inRepo({ soporte: true, aprobadores: { qa: ["ana"] }, rama_desarrollo: "develop" }, () => {
    process.env.SUPPORT_STAGE = "off"; process.env.APPROVERS_QA = "zoe"; process.env.DEVEL_BRANCH = "integration";
    const c = loadConfig();
    assert.equal(c.supportStage, false);
    assert.deepEqual(c.approvers.qa, ["zoe"]);
    assert.equal(c.develBranch, "integration");
  });
  inRepo(undefined, () => {
    const c = loadConfig();
    assert.equal(c.supportStage, false);
    assert.equal(c.codeReviewGate, "github");
    assert.equal(c.develBranch, "desarrollo");
    assert.equal(c.testCommand, "npm test");
    assert.equal(c.lockMinutes, 90);
  });
});

test("config.yaml and environment.yaml use English keys; old files are read and rewritten by escribirConfig", async () => {
  const { leerConfig, escribirConfig, configVieja } = await import("../src/lib/config.ts");
  const { parse } = await import("yaml");
  const { readFileSync, existsSync } = await import("node:fs");
  // an old file: Spanish keys, with the stack and the environment inside config.yaml
  const repo = realpathSync.native(mkdtempSync(join(tmpdir(), "orqen-en-")));
  mkdirSync(join(repo, "orqen"));
  writeFileSync(join(repo, "orqen/config.yaml"), stringify({
    version: 1, orqen: { cli: "0.1.0", kit: "0.1.0" }, proyecto: { nombre: "x", rama_base: "main" }, agente: { comando: "codex exec" },
    openspec: { instalacion: "global" },
    stack: { resumen: "API", componentes: [{ nombre: "api", tipo: "libreria", ruta: ".", lenguaje: "ts", comandos: { instalar: "npm i" } }] },
    conectores: { externo: { tipo: "jira", filtro: "project = SOP", transiciones: { CLOSED: "Done" } } },
    flujo: { aprobadores: { codigo: ["seni"] }, comando_pr: "gh pr create" },
    entornos: { procesos: [{ nombre: "api", comando: "npm start", cuando: "siempre", listo_si: "ready" }], tests: { unitarios: "npm test" } },
  }));
  assert.equal(configVieja(repo), true);
  const old = leerConfig(repo);
  assert.equal(old.proyecto.rama_base, "main");
  assert.equal(old.conectores?.requests.filtro, "project = SOP");
  assert.deepEqual(old.flujo?.aprobadores.codigo, ["seni"]);
  assert.equal(old.entornos.procesos[0].listo_si, "ready");

  escribirConfig(repo, old);
  assert.equal(configVieja(repo), false);
  const cfg = parse(readFileSync(join(repo, "orqen/config.yaml"), "utf8"));
  const env = parse(readFileSync(join(repo, "orqen/environment.yaml"), "utf8"));
  assert.deepEqual(Object.keys(cfg).sort(), ["agent", "connectors", "openspec", "orqen", "project", "version", "workflow"]);
  assert.deepEqual(cfg.connectors.requests, { type: "jira", filter: "project = SOP", transitions: { CLOSED: "Done" } });
  assert.deepEqual(cfg.workflow.approvers.code, ["seni"]);
  assert.equal(cfg.workflow.pr_command, "gh pr create");
  assert.equal(cfg.agent.command, "codex exec");
  assert.deepEqual(env.processes[0], { name: "api", command: "npm start", path: ".", when: "always", ready_when: "ready", wait_seconds: 120 });
  assert.equal(env.stack.components[0].type, "library");
  assert.equal(env.stack.components[0].commands.install, "npm i");
  assert.equal(env.tests.unit, "npm test");
  // and it reads back the same
  assert.deepEqual(leerConfig(repo), old);

  // errors name the key as written in the file
  writeFileSync(join(repo, "orqen/config.yaml"), readFileSync(join(repo, "orqen/config.yaml"), "utf8").replace("pr_command: gh pr create", "pr_command: { a: 1 }"));
  assert.throws(() => leerConfig(repo), /orqen\/config\.yaml: workflow\.pr_command/);
  writeFileSync(join(repo, "orqen/environment.yaml"), "processes:\n  - name: api\n");
  assert.throws(() => leerConfig(repo), /orqen\/environment\.yaml: processes\.0\.command/);
  assert.ok(existsSync(join(repo, "orqen/environment.yaml")));
});
