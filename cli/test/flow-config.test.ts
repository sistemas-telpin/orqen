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
