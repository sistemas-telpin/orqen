import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { aplicar, extraerBloque, leerManifest, planificar, type Decision } from "../src/lib/kit.ts";
import { fusionarConfigOpenSpec } from "../src/lib/openspec.ts";
import { stageGuideFile } from "../src/lib/stage-guides.ts";
import { completarEnv, parsearEnv } from "../src/lib/env.ts";
import { repoTemporal } from "./helpers.ts";

const vars = { RESUMEN_STACK: "Test stack.", BASE_BRANCH: "main", AGENT_CMD: "claude -p" };
const siempre = (d: Decision) => async () => d;
const leer = (repo: string, r: string) => readFileSync(join(repo, r), "utf8");

test("installs the kit idempotently", async () => {
  const repo = repoTemporal();
  const plan = planificar(repo, vars);
  assert.ok(plan.every((c) => c.accion === "crear"));
  await aplicar(repo, plan, siempre("sobrescribir"));

  assert.ok(existsSync(join(repo, "orqen/stages/development.md")));
  assert.ok(existsSync(join(repo, "orqen/plugin/.claude-plugin/plugin.json")));
  // the shared settings live in orqen/config.yaml: no .env.example, and no .env is created (it only holds optional local overrides)
  assert.ok(!existsSync(join(repo, "orqen/.env.example")));
  assert.ok(!existsSync(join(repo, "orqen/.env")));
  assert.match(leer(repo, "AGENTS.md"), /orqen:inicio[\s\S]*Test stack\.[\s\S]*orqen:fin/);
  assert.equal(leer(repo, "CLAUDE.md"), "@AGENTS.md\n");
  assert.match(leer(repo, ".gitignore"), /orqen\/state\//);
  assert.equal(JSON.parse(leer(repo, ".claude-plugin/marketplace.json")).plugins[0].source, "./orqen/plugin");
  assert.ok(Object.keys(leerManifest(repo).archivos).includes("AGENTS.md#orqen"));

  const otra = planificar(repo, vars);
  assert.deepEqual(otra.filter((c) => c.accion !== "igual").map((c) => c.ruta), []);
});

test("preserves team guidance outside the managed AGENTS.md block", async () => {
  const repo = repoTemporal({ "AGENTS.md": "# Team rules\n\nUse tabs.\n", "CLAUDE.md": "Write in English.\n" });
  await aplicar(repo, planificar(repo, vars), siempre("sobrescribir"));
  const a = leer(repo, "AGENTS.md");
  assert.ok(a.startsWith("# Team rules\n\nUse tabs."));
  assert.match(a, /orqen:inicio/);
  assert.equal(leer(repo, "CLAUDE.md"), "Write in English.\n\n@AGENTS.md\n");

  // A changed stack updates an unedited managed block.
  const plan = planificar(repo, { ...vars, RESUMEN_STACK: "Updated stack." });
  assert.equal(plan.find((c) => c.ruta === "AGENTS.md")!.accion, "actualizar");
  await aplicar(repo, plan, siempre("sobrescribir"));
  assert.match(extraerBloque(leer(repo, "AGENTS.md"))!, /Updated stack\./);
  assert.ok(leer(repo, "AGENTS.md").startsWith("# Team rules"));
});

test("uses the previous stage guide path for existing installations", async () => {
  const repo = repoTemporal({ "orqen/stages/analisis.md": "# Local analysis guide\n" });
  const directory = join(repo, "orqen", "stages");
  assert.equal(stageGuideFile(directory, "analysis.md"), "analisis.md");

  const plan = planificar(repo, vars);
  const guide = plan.find((entry) => entry.ruta === "orqen/stages/analisis.md");
  assert.equal(guide?.accion, "conflicto");
  assert.match(guide?.nuevo ?? "", /^## Analysis/);
  await aplicar(repo, plan, siempre("mantener"));
  assert.equal(leer(repo, "orqen/stages/analisis.md"), "# Local analysis guide\n");
  assert.ok(!existsSync(join(directory, "analysis.md")));
});

test("offers conflict decisions for a guide edited by the team", async () => {
  const repo = repoTemporal();
  await aplicar(repo, planificar(repo, vars), siempre("sobrescribir"));
  const ruta = "orqen/stages/testing.md";
  writeFileSync(join(repo, ruta), "# Local testing guide\n");

  const nuevas = { ...vars, AGENT_CMD: "codex exec --full-auto -" };
  const plan = planificar(repo, nuevas);
  assert.equal(plan.find((c) => c.ruta === ruta)!.accion, "conflicto");

  const res = await aplicar(repo, plan, siempre("nuevo"));
  assert.equal(leer(repo, ruta), "# Local testing guide\n", "keeps team edits");
  assert.ok(existsSync(join(repo, `${ruta}.orqen-new`)));
  assert.equal(res.find((r) => r.ruta === ruta)!.accion, "guardado-al-lado");

  await aplicar(repo, planificar(repo, nuevas), siempre("mantener"));
  assert.equal(leer(repo, ruta), "# Local testing guide\n");
  await aplicar(repo, planificar(repo, nuevas), siempre("sobrescribir"));
  assert.match(leer(repo, ruta), /## Testing/);
});

test("merges OpenSpec rules while preserving team rules and comments", async () => {
  const actual = [
    "schema: spec-driven",
    "",
    "context: |",
    "  Language: en",
    "  Stack: NestJS",
    "",
    "# team rules",
    "rules:",
    "  proposal:",
    "    - At most 500 words",
    "",
  ].join("\n");
  const frag = "context: |\n  Language: en\n  Each change corresponds to a request.\nrules:\n  proposal:\n    - Cite the request.\n  tasks:\n    - Estimate in hours.\noperations:\n  apply:\n    guidance:\n      - Leave commits to orqen.\n";
  const r = fusionarConfigOpenSpec(actual, frag);
  assert.match(r, /# team rules/);
  assert.match(r, /Stack: NestJS\n\s+Each change corresponds to a request\./);
  assert.equal((r.match(/Language: en/g) ?? []).length, 1);
  assert.match(r, /- At most 500 words\n\s+- Cite the request\./);
  assert.match(r, /tasks:\n\s+- Estimate in hours\./);
  assert.match(r, /guidance:\n\s+- Leave commits to orqen\./);
  assert.equal(fusionarConfigOpenSpec(r, frag), r, "idempotente");

  // The kit plan merges OpenSpec rules when openspec/ exists.
  const repo = repoTemporal({ "openspec/config.yaml": actual });
  mkdirSync(join(repo, "openspec", "specs"), { recursive: true });
  const plan = planificar(repo, vars);
  assert.equal(plan.find((c) => c.ruta === "openspec/config.yaml")!.accion, "actualizar");
});

test("fills .env from the example, preserves comments, and reads it back", () => {
  const plantilla = [
    "JIRA_URL=https://tu-empresa.atlassian.net",
    "JIRA_DEPLOYMENT=cloud            # cloud | server",
    "JIRA_TOKEN=",
    "APPROVERS_CODE=                  # senior reviewers",
    "# standalone comment",
    "GITHUB_TOKEN=",
    "",
  ].join("\n");
  const r = completarEnv(plantilla, { JIRA_URL: "https://acme.atlassian.net", JIRA_DEPLOYMENT: "server", JIRA_TOKEN: "abc#123", APPROVERS_CODE: "ana,beto", OTRA: "x" });
  assert.match(r, /^JIRA_URL=https:\/\/acme\.atlassian\.net$/m);
  assert.match(r, /^JIRA_DEPLOYMENT=server            # cloud \| server$/m);
  assert.match(r, /^JIRA_TOKEN='abc#123'$/m);
  assert.match(r, /# standalone comment/);
  assert.match(r, /^GITHUB_TOKEN=$/m, "values not supplied stay as shown in the template");
  assert.match(r, /^APPROVERS_CODE=ana,beto                  # senior reviewers$/m);
  assert.match(r, /^OTRA=x$/m);
  const leido = parsearEnv(r);
  assert.equal(leido.JIRA_TOKEN, "abc#123");
  assert.equal(leido.JIRA_DEPLOYMENT, "server");
  assert.equal(leido.APPROVERS_CODE, "ana,beto");
  // Node parses the same values.
  const repo = repoTemporal();
  writeFileSync(join(repo, "x.env"), r);
  delete process.env.JIRA_TOKEN;
  process.loadEnvFile(join(repo, "x.env"));
  assert.equal(process.env.JIRA_TOKEN, "abc#123");
  assert.equal(process.env.JIRA_DEPLOYMENT, "server");
});
