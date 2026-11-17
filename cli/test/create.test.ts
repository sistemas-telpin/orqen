/** `orqen create project` and the tools catalog (tools/<id>/tool.yaml). */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { crearProyecto } from "../src/commands/create.ts";
import { cargarTool, chequearRequisitos, listarTools, parametrosDe, render, TOOLS_DIR, validarParametro, variablesBase } from "../src/lib/tools.ts";

const CLI = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const TSX = fileURLToPath(new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url));

function variables(id: string, nombre = "Plataforma de Pagos") {
  const base = variablesBase(nombre);
  const vars: Record<string, string> = { ...base };
  for (const p of parametrosDe(id, base)) vars[p.id] = p.defecto;
  if (vars.PAQUETE) vars.PAQUETE_RUTA = vars.PAQUETE.replaceAll(".", "/");
  return vars;
}

test("catalog: the two initial stacks are listed and their tool.yaml is valid", () => {
  const ids = listarTools().map((t) => t.id);
  assert.deepEqual(ids, ["java-tomcat-sqlserver", "vue-node-postgres"]);
  for (const id of ids) {
    const t = cargarTool(id, variables(id));
    assert.ok(t.entornos.procesos.some((p) => p.nombre === "db" && p.detener === "node orqen/tools/db.mjs down"), `${id}: db process with a clean stop`);
    assert.ok(t.entornos.tests.unitarios, `${id}: unit tests`);
    assert.ok(t.db, `${id}: database settings`);
    assert.doesNotMatch(JSON.stringify(t), /\{\{/, `${id}: every {{VARIABLE}} is replaced`);
  }
});

test("project variables: ids, Java package and a SQL Server-compatible password", () => {
  const v = variablesBase("Plataforma de Pagos Ñandú");
  assert.equal(v.PROYECTO_ID, "plataforma-de-pagos-nandu");
  assert.equal(v.PROYECTO_JAVA, "plataformadepagosnandu");
  assert.match(v.DB_PASSWORD, /^(?=.*[A-Z])(?=.*[a-z])(?=.*\d)(?=.*[^A-Za-z0-9]).{12,}$/);
  assert.equal(variablesBase("Facturación Web").PROYECTO_ID, "facturacion-web");
  assert.equal(validarParametro("puerto", "70000"), "A port is a number between 1 and 65535");
  assert.equal(validarParametro("paquete_java", "com.telpin.app"), undefined);
  assert.ok(validarParametro("paquete_java", "Com.Telpin"));
  assert.equal(render("{{A}}-{{B}}", { A: "x" }), "x-{{B}}");
});

test("requirements report missing commands and versions below the minimum", () => {
  const r = chequearRequisitos({ requisitos: [{ comando: "node", version: ">=999" }, { comando: "comando-que-no-existe-xyz" }] });
  assert.equal(r[0].ok, false);
  assert.match(r[0].detalle, /needs >=999/);
  assert.deepEqual([r[1].ok, r[1].detalle], [false, "not found"]);
});

test("create project (Java + Tomcat + SQL Server): code, tools, orqen config and initial commit", async () => {
  // The initial commit needs a Git identity; CI machines may not have one.
  process.env.GIT_AUTHOR_NAME ??= "orqen-test"; process.env.GIT_AUTHOR_EMAIL ??= "test@orqen.dev";
  process.env.GIT_COMMITTER_NAME ??= "orqen-test"; process.env.GIT_COMMITTER_EMAIL ??= "test@orqen.dev";
  const raiz = mkdtempSync(join(tmpdir(), "orqen-create-"));
  const dir = join(raiz, "facturacion");
  await crearProyecto({ nombre: "Facturación Web", stack: "java-tomcat-sqlserver", dir, yes: true, sinOpenspec: true, sinAnimacion: true });
  assert.equal(process.exitCode ?? 0, 0);

  const paquete = join(dir, "src/main/java/com/telpin/facturacionweb");
  assert.ok(existsSync(join(paquete, "HealthServlet.java")));
  assert.match(readFileSync(join(paquete, "Saludos.java"), "utf8"), /^package com\.telpin\.facturacionweb;/);
  assert.match(readFileSync(join(dir, "pom.xml"), "utf8"), /<artifactId>facturacion-web<\/artifactId>[\s\S]*<packaging>war<\/packaging>/);

  const db = JSON.parse(readFileSync(join(dir, "orqen/tools/db.json"), "utf8"));
  assert.deepEqual([db.engine, db.database, db.container], ["sqlserver", "facturacionweb", "facturacion-web-db"]);
  assert.ok(existsSync(join(dir, "orqen/tools/db.mjs")));

  const cfg = parse(readFileSync(join(dir, "orqen/config.yaml"), "utf8"));
  assert.deepEqual(cfg.entornos.procesos.map((p: any) => p.nombre), ["db", "app"]);
  assert.equal(cfg.entornos.variables.DB_PASSWORD, db.password, "the app and the container share the password");
  assert.match(cfg.entornos.variables.DB_URL, /^jdbc:sqlserver:\/\/localhost:\d+;databaseName=facturacionweb;/);
  assert.equal(cfg.stack.componentes[0].framework, "jakarta-servlet+tomcat");
  assert.match(readFileSync(join(dir, "AGENTS.md"), "utf8"), /Working with the person/);

  const log = execFileSync("git", ["log", "--oneline"], { cwd: dir, encoding: "utf8" });
  assert.match(log, /Create Facturación Web with orqen \(java-tomcat-sqlserver\)/);
  assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" }), "", "everything committed");
  assert.match(readFileSync(join(dir, ".gitignore"), "utf8"), /orqen\/\.env/);
});

test("create project refuses a non-empty folder and an unknown stack", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orqen-create-"));
  writeFileSync(join(dir, "x.txt"), "x");
  const r1 = spawnSync(process.execPath, [TSX, CLI, "create", "project", "Algo", "--dir", dir, "--yes", "--stack", "vue-node-postgres"], { encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
  assert.equal(r1.status, 1);
  assert.match(r1.stdout + r1.stderr, /not empty/);
  const r2 = spawnSync(process.execPath, [TSX, CLI, "create", "project", "Algo", "--dir", join(dir, "nuevo"), "--yes", "--stack", "cobol"], { encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
  assert.equal(r2.status, 1);
  assert.match(r2.stdout + r2.stderr, /Unknown stack "cobol"\. Available: java-tomcat-sqlserver, vue-node-postgres/);
  const r3 = spawnSync(process.execPath, [TSX, CLI, "create", "stacks"], { encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
  assert.match(r3.stdout, /vue-node-postgres\s+Vue \+ Node \+ PostgreSQL/);
});

test("orqen/tools/db.mjs: starts, waits until ready, reports, and stops the container (fake docker)", () => {
  // A fake `docker` that records calls: the container becomes ready on the third readiness check.
  const bin = mkdtempSync(join(tmpdir(), "fake-docker-"));
  const estado = join(bin, "estado.json");
  writeFileSync(join(bin, "docker.mjs"), `
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "node:fs";
const f = ${JSON.stringify(estado)};
const s = existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : { exists: false, running: false, checks: 0 };
const a = process.argv.slice(2);
appendFileSync(f + ".log", a.join(" ") + "\\n");
const save = () => writeFileSync(f, JSON.stringify(s));
switch (a[0]) {
  case "info": console.log("29"); break;
  case "inspect": if (!s.exists) process.exit(1); console.log(String(s.running)); break;
  case "run": s.exists = true; s.running = true; save(); break;
  case "start": s.running = true; save(); break;
  case "exec": s.checks++; save(); process.exit(s.checks >= 3 ? 0 : 1);
  case "logs": process.exit(0);
  case "stop": s.running = false; save(); break;
  case "rm": s.exists = false; s.running = false; save(); break;
  default: break;
}
`);
  if (process.platform === "win32") writeFileSync(join(bin, "docker.cmd"), `@node "%~dp0docker.mjs" %*\r\n`);
  else { writeFileSync(join(bin, "docker"), `#!/bin/sh\nexec node "${join(bin, "docker.mjs")}" "$@"\n`); chmodSync(join(bin, "docker"), 0o755); }

  const proyecto = mkdtempSync(join(tmpdir(), "orqen-db-"));
  mkdirSync(join(proyecto, "orqen/tools"), { recursive: true });
  writeFileSync(join(proyecto, "orqen/tools/db.mjs"), readFileSync(join(TOOLS_DIR, "_shared/db.mjs")));
  writeFileSync(join(proyecto, "orqen/tools/db.json"), JSON.stringify({ engine: "postgres", port: 5432, database: "pagos", user: "app", password: "app", container: "pagos-db" }));
  const env = { ...process.env, PATH: `${bin}${process.platform === "win32" ? ";" : ":"}${process.env.PATH}` };
  const run = (cmd: string) => spawnSync(process.execPath, ["orqen/tools/db.mjs", cmd], { cwd: proyecto, env, encoding: "utf8", timeout: 20_000 });

  const up = run("up");
  assert.match(up.stdout, /creating pagos-db \(postgres:17-alpine\) on port 5432[\s\S]*orqen-db: ready \(postgres on localhost:5432, database pagos\)/);
  const llamadas = readFileSync(estado + ".log", "utf8");
  assert.match(llamadas, /run -d --name pagos-db -p 5432:5432 -v pagos-db-data:\/var\/lib\/postgresql\/data -e POSTGRES_USER=app -e POSTGRES_PASSWORD=app -e POSTGRES_DB=pagos postgres:17-alpine/);
  assert.equal((llamadas.match(/^exec /gm) ?? []).length, 3, "waits until the database accepts connections");

  assert.match(run("down").stdout, /pagos-db stopped \(data kept\)/);
  assert.match(run("status").stdout, /pagos-db stopped/);
  assert.match(run("up").stdout, /starting pagos-db/, "the second time it starts the existing container");
  assert.match(run("reset").stdout, /removed/);
  assert.match(readFileSync(estado + ".log", "utf8"), /volume rm pagos-db-data/);
});
