#!/usr/bin/env node
/**
 * Local development database in Docker, managed by orqen.
 *
 *   node orqen/tools/db.mjs up       start the container (create it the first time), wait until it accepts
 *                              connections, create the database, print "orqen-db: ready" and keep following its logs
 *                              (orqen runs this as a process and stops it with `node orqen/tools/db.mjs down`)
 *   node orqen/tools/db.mjs down     stop the container (data is kept in a Docker volume)
 *   node orqen/tools/db.mjs reset    delete the container and its volume (empty database next time)
 *   node orqen/tools/db.mjs status   show whether it is running
 *
 * Settings live in orqen/tools/db.json (engine, port, database, user, password). Only Docker is required.
 */
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const cfg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "db.json"), "utf8"));
const container = cfg.container, volume = `${cfg.container}-data`;

const ENGINES = {
  postgres: {
    image: cfg.image ?? "postgres:17-alpine", internalPort: 5432, dataDir: "/var/lib/postgresql/data",
    env: { POSTGRES_USER: cfg.user, POSTGRES_PASSWORD: cfg.password, POSTGRES_DB: cfg.database },
    ready: ["pg_isready", "-h", "127.0.0.1", "-U", cfg.user, "-d", cfg.database],
    createDb: null,   // POSTGRES_DB creates it on first start
  },
  sqlserver: {
    image: cfg.image ?? "mcr.microsoft.com/mssql/server:2022-latest", internalPort: 1433, dataDir: "/var/opt/mssql",
    env: { ACCEPT_EULA: "Y", MSSQL_SA_PASSWORD: cfg.password, MSSQL_PID: "Developer" },
    ready: ["/opt/mssql-tools18/bin/sqlcmd", "-C", "-S", "localhost", "-U", "sa", "-P", cfg.password, "-Q", "SELECT 1", "-b"],
    createDb: ["/opt/mssql-tools18/bin/sqlcmd", "-C", "-S", "localhost", "-U", "sa", "-P", cfg.password, "-b",
      "-Q", `IF DB_ID('${cfg.database}') IS NULL CREATE DATABASE [${cfg.database}]`],
  },
};
const engine = ENGINES[cfg.engine];
if (!engine) { console.error(`orqen-db: unknown engine "${cfg.engine}" in orqen/tools/db.json`); process.exit(2); }

const docker = (args, opts = {}) => spawnSync("docker", args, { encoding: "utf8", windowsHide: true, ...opts });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function requireDocker() {
  const r = docker(["info", "--format", "{{.ServerVersion}}"]);
  if (r.error) fail("Docker is not installed. Install Docker Desktop (Windows/macOS) or Docker Engine (Linux).");
  if (r.status !== 0) fail("Docker is not running. Start Docker Desktop and try again.");
}
function fail(msg) { console.error(`orqen-db: ${msg}`); process.exit(1); }

function state() {
  const r = docker(["inspect", "-f", "{{.State.Running}}", container]);
  return r.status !== 0 ? "missing" : r.stdout.trim() === "true" ? "running" : "stopped";
}

async function up() {
  requireDocker();
  const s = state();
  if (s === "missing") {
    console.log(`orqen-db: creating ${container} (${engine.image}) on port ${cfg.port}…`);
    const env = Object.entries(engine.env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
    const r = docker(["run", "-d", "--name", container, "-p", `${cfg.port}:${engine.internalPort}`, "-v", `${volume}:${engine.dataDir}`, ...env, engine.image], { stdio: ["ignore", "pipe", "inherit"] });
    if (r.status !== 0) fail(`could not create the container (is port ${cfg.port} already in use? change it in orqen/tools/db.json and orqen/config.yaml).`);
  } else if (s === "stopped") {
    console.log(`orqen-db: starting ${container}…`);
    if (docker(["start", container]).status !== 0) fail(`could not start ${container}.`);
  }
  const until = Date.now() + 180_000;
  while (docker(["exec", container, ...engine.ready]).status !== 0) {
    if (state() !== "running") fail(`${container} stopped while starting. Logs: docker logs ${container}`);
    if (Date.now() > until) fail(`${container} did not accept connections after 180s. Logs: docker logs ${container}`);
    await sleep(1000);
  }
  if (engine.createDb && docker(["exec", container, ...engine.createDb]).status !== 0) fail(`could not create database ${cfg.database}.`);
  console.log(`orqen-db: ready (${cfg.engine} on localhost:${cfg.port}, database ${cfg.database})`);

  // Stay alive following the logs so orqen can manage it as a process.
  const logs = spawn("docker", ["logs", "-f", "--since", "1s", container], { stdio: "inherit", windowsHide: true });
  const stop = () => { docker(["stop", container]); process.exit(0); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  logs.on("exit", (code) => process.exit(state() === "running" ? (code ?? 0) : 1));
}

function down() {
  if (state() === "running") { docker(["stop", container], { stdio: "inherit" }); console.log(`orqen-db: ${container} stopped (data kept)`); }
  else console.log(`orqen-db: ${container} is not running`);
}

function reset() {
  docker(["rm", "-f", container]);
  docker(["volume", "rm", volume]);
  console.log(`orqen-db: ${container} and its data were removed`);
}

const cmd = process.argv[2];
if (cmd === "up") await up();
else if (cmd === "down") down();
else if (cmd === "reset") reset();
else if (cmd === "status") console.log(`orqen-db: ${container} ${state()} (${cfg.engine}, localhost:${cfg.port}, database ${cfg.database})`);
else { console.log("Usage: node orqen/tools/db.mjs up | down | reset | status"); process.exit(cmd ? 1 : 0); }
