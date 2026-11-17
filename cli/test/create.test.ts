/** CLI/catalog contracts use a synthetic repository, never private stacks. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { catalogoTemporal, repoTemporal } from "./helpers.ts";

const catalogo = catalogoTemporal();
process.env.ORQEN_TOOLS_DIR = catalogo;
process.env.ORQEN_TOOLS_REPO = "@example/catalog";
const { cargarTool, chequearRequisitos, listarTools, parametrosDe, render, validarParametro, variablesBase } = await import("../src/lib/tools.ts");
const CLI = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const TSX = fileURLToPath(new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url));
function cli(...args: string[]) {
  const r = spawnSync(process.execPath, [TSX, CLI, ...args], { encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
  return { code: r.status, output: r.stdout + r.stderr };
}

test("catalog loads custom stacks, parameters and rendered settings", () => {
  assert.deepEqual(listarTools().map((t) => t.id), ["example"]);
  const vars = { ...variablesBase("Payments"), PORT: "4567" };
  assert.equal(parametrosDe("example", vars)[0].defecto, "4567");
  const tool = cargarTool("example", vars);
  assert.equal(tool.db?.database, "payments");
  assert.doesNotMatch(JSON.stringify(tool), /\{\{/);
});

test("project variables, parameter validation and rendering", () => {
  const v = variablesBase("Facturaci\u00f3n \u00d1and\u00fa");
  assert.equal(v.PROYECTO_ID, "facturacion-nandu");
  assert.match(v.DB_PASSWORD, /^(?=.*[A-Z])(?=.*[a-z])(?=.*\d)(?=.*[^A-Za-z0-9]).{12,}$/);
  assert.ok(validarParametro("puerto", "70000"));
  assert.equal(validarParametro("paquete_java", "com.example.app"), undefined);
  assert.ok(validarParametro("paquete_java", "Com.Example"));
  assert.equal(render("{{A}}-{{B}}", { A: "x" }), "x-{{B}}");
});

test("requirements report missing commands and versions below the minimum", () => {
  const r = chequearRequisitos({ requisitos: [{ comando: "node", version: ">=999" }, { comando: "orqen-missing-command-xyz" }] });
  assert.equal(r[0].ok, false);
  assert.match(r[0].detalle, /needs >=999/);
  assert.equal(r[1].detalle, "not found");
});

test("create project uses the personal catalog for scaffold, scripts and configuration", () => {
  const dir = join(repoTemporal(), "project");
  const r = cli("create", "project", "Payments", "--dir", dir, "--stack", "example", "--yes", "--no-openspec");
  assert.equal(r.code, 0, r.output);
  assert.match(readFileSync(join(dir, "README.md"), "utf8"), /# Payments\r?\nPort: 4567/);
  assert.ok(existsSync(join(dir, "orqen/tools/db.mjs")));
  const db = JSON.parse(readFileSync(join(dir, "orqen/tools/db.json"), "utf8"));
  assert.equal(db.database, "payments");
  const cfg = parse(readFileSync(join(dir, "orqen/config.yaml"), "utf8"));
  assert.equal(cfg.stack.resumen, "Example Payments");
  assert.equal(cfg.entornos.tests.unitarios, "node --test");
  assert.match(readFileSync(join(dir, ".gitignore"), "utf8"), /orqen\/\.env/);
});

test("create refuses non-empty destinations and unknown stacks, and lists custom stacks", () => {
  const dir = repoTemporal();
  writeFileSync(join(dir, "x.txt"), "x");
  const r1 = cli("create", "project", "Example", "--dir", dir, "--yes", "--stack", "example");
  assert.equal(r1.code, 1);
  assert.match(r1.output, /not empty/);
  const r2 = cli("create", "project", "Example", "--dir", join(dir, "new"), "--yes", "--stack", "missing");
  assert.equal(r2.code, 1);
  assert.match(r2.output, /Unknown stack "missing". Available: example/);
  assert.match(cli("create", "stacks").output, /example\s+Example stack/);
});
