/** CLI end-to-end tests for init and update without network access or Docker. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";
import { hash } from "../src/lib/kit.ts";
import { MONOREPO, repoTemporal } from "./helpers.ts";

const CLI = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const TSX = fileURLToPath(new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url));

function orqen(cwd: string, ...args: string[]) {
  const r = spawnSync(process.execPath, [TSX, CLI, ...args], { cwd, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
  return { codigo: r.status, salida: r.stdout + r.stderr };
}

test("orqen --help prints the current logo and usage without an interactive terminal", () => {
  const r = orqen(process.cwd(), "--help");
  assert.equal(r.codigo, 0, r.salida);
  assert.match(r.salida, /AI Software Factory KIT/);
  assert.match(r.salida, /Usage: orqen/);
});

test("orqen init --yes writes the repository configuration", () => {
  const repo = repoTemporal(MONOREPO);
  const r = orqen(repo, "init", "--yes", "--no-ai", "--no-openspec");
  assert.equal(r.codigo, 0, r.salida);
  assert.match(r.salida, /AI Software Factory KIT/);

  const cfg = parse(readFileSync(join(repo, "orqen/config.yaml"), "utf8"));
  assert.equal(cfg.version, 1);
  assert.equal(cfg.proyecto.rama_base, "main");
  assert.equal(cfg.entornos.compose, "docker-compose.orqen.yml");
  assert.equal(cfg.entornos.tests.e2e, "pnpm exec playwright test");
  assert.ok(!JSON.stringify(cfg).includes("null"), "no null values in orqen/config.yaml");

  const compose = parse(readFileSync(join(repo, "docker-compose.orqen.yml"), "utf8"));
  assert.ok(compose.services.db && compose.services.cache);
  assert.match(readFileSync(join(repo, "AGENTS.md"), "utf8"), /orqen env up/);
  assert.ok(existsSync(join(repo, "orqen/manifest.json")));
});

test("orqen init reports when the directory is not a Git repository", () => {
  const repo = repoTemporal({ "README.md": "x" }, false);
  const r = orqen(repo, "init", "--yes", "--no-ai", "--no-openspec");
  assert.equal(r.codigo, 1);
  assert.match(r.salida, /git init/);
});

test("orqen update --yes reports current files and preserves user edits", () => {
  const repo = repoTemporal(MONOREPO);
  assert.equal(orqen(repo, "init", "--yes", "--no-ai", "--no-openspec").codigo, 0);

  const r1 = orqen(repo, "update", "--yes", "--no-cli", "--no-openspec");
  assert.equal(r1.codigo, 0, r1.salida);
  assert.match(r1.salida, /up to date/);

  // Simulate an edited guide and an outdated environment template.
  writeFileSync(join(repo, "orqen/stages/delivery.md"), "# Local delivery guide\n");
  const manifest = JSON.parse(readFileSync(join(repo, "orqen/manifest.json"), "utf8"));
  writeFileSync(join(repo, "orqen/.env.example"), "OLD=1\n");
  manifest.archivos["orqen/.env.example"] = hash("OLD=1\n");
  manifest.kit = "0.0.9";
  writeFileSync(join(repo, "orqen/manifest.json"), JSON.stringify(manifest));

  const r2 = orqen(repo, "update", "--yes", "--no-cli", "--no-openspec");
  assert.equal(r2.codigo, 0, r2.salida);
  assert.match(r2.salida, /Kit 0\.0\.9 → 0\.1\.0/);
  assert.equal(readFileSync(join(repo, "orqen/stages/delivery.md"), "utf8"), "# Local delivery guide\n");
  assert.ok(existsSync(join(repo, "orqen/stages/delivery.md.orqen-new")));
  assert.match(readFileSync(join(repo, "orqen/.env.example"), "utf8"), /JIRA_URL/);
});

test("orqen update prompts for init when configuration is absent", () => {
  const r = orqen(repoTemporal(), "update", "--yes", "--no-cli");
  assert.equal(r.codigo, 1);
  assert.match(r.salida, /orqen init/);
});

test("orqen env test uses variables from orqen/config.yaml", () => {
  const repo = repoTemporal({ "README.md": "x" });
  mkdirSync(join(repo, "orqen"), { recursive: true });
  writeFileSync(join(repo, "orqen/config.yaml"), stringify({
    version: 1, orqen: { cli: "0.1.0", kit: "0.1.0" }, proyecto: { nombre: "x", rama_base: "main" },
    openspec: { instalacion: "global" }, stack: { resumen: "x" },
    entornos: {
      variables: { SALUDO: "hola" },
      tests: { unitarios: `node -e "process.exit(process.env.SALUDO === 'hola' ? 0 : 1)"`, e2e: `node -e "process.exit(2)"` },
    },
  }));
  const ok = orqen(repo, "env", "test", "unitarios");
  assert.equal(ok.codigo, 0, ok.salida);
  const mal = orqen(repo, "env", "test");
  assert.equal(mal.codigo, 1);
  assert.match(mal.salida, /✘ e2e/);
});
