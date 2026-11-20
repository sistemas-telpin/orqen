/** CLI end-to-end tests for init and update without network access or Docker. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse, stringify } from "yaml";
import { MONOREPO, repoTemporal } from "./helpers.ts";

const CLI = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const TSX = fileURLToPath(new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url));

// An unavailable and invalid catalog must have no effect on init or update.
const catalogo = join(repoTemporal(), "unavailable-catalog");

function orqen(cwd: string, ...args: string[]) {
  return orqenCon({}, cwd, ...args);
}

function orqenCon(env: Record<string, string>, cwd: string, ...args: string[]) {
  const r = spawnSync(process.execPath, [TSX, CLI, ...args], { cwd, encoding: "utf8", env: { ...process.env, NO_COLOR: "1", ORQEN_TOOLS_DIR: catalogo, ORQEN_TOOLS_REPO: "not-a-github-repository", ...env } });
  return { codigo: r.status, salida: r.stdout + r.stderr };
}

test("desktop release discovery is read-only and installs only the confirmed version", () => {
  const repo = repoTemporal({
    "global/@telpin-sistemas/orqen-desktop/package.json": { version: "0.1.7" },
    "global/@telpin-sistemas/orqen-studio/package.json": { version: "0.1.7" },
    "bin/npm.cmd": '@node "%~dp0npm.mjs" %*\r\n',
    "bin/npm": '#!/bin/sh\nexec node "$(dirname "$0")/npm.mjs" "$@"\n',
    "bin/npm.mjs": `
      import { writeFileSync } from "node:fs";
      const args = process.argv.slice(2);
      if (args[0] === "root") console.log(process.env.TEST_GLOBAL);
      else if (args[0] === "view") console.log("0.1.8");
      else if (args[0] === "install") writeFileSync(process.env.TEST_NPM_CALL, JSON.stringify(args));
      else process.exitCode = 2;
    `,
    "github.mjs": `
      globalThis.fetch = async (url) => Response.json(String(url).includes("/compare/")
        ? { commits: [{ commit: { message: "Fix the Worq chat" } }] }
        : { body: "New bot settings" });
    `,
  }, false);
  if (process.platform !== "win32") chmodSync(join(repo, "bin/npm"), 0o755);
  const log = join(repo, "npm-call.json");
  const global = join(repo, "global");
  const env = {
    PATH: [join(repo, "bin"), process.env.PATH].filter(Boolean).join(delimiter),
    ORQEN_DESKTOP_NPM_MANIFEST: join(global, "@telpin-sistemas/orqen-desktop/package.json"),
    NODE_OPTIONS: `--import=${pathToFileURL(join(repo, "github.mjs")).href}`,
    TEST_GLOBAL: global, TEST_NPM_CALL: log,
  };

  const check = orqenCon(env, repo, "desktop-release", "0.1.7");
  assert.equal(check.codigo, 0, check.salida);
  assert.deepEqual(JSON.parse(check.salida), {
    status: "available",
    version: "0.1.8",
    notes: "New bot settings",
    commits: ["Fix the Worq chat"],
    url: "https://github.com/sistemas-telpin/orqen-studio/compare/v0.1.7...v0.1.8",
  });
  const current = orqenCon(env, repo, "desktop-release", "0.1.8");
  assert.equal(current.codigo, 0, current.salida);
  assert.equal(JSON.parse(current.salida).status, "current");
  assert.ok(!existsSync(log));

  const installed = orqenCon(env, repo, "update", "--desktop", "--target", "0.1.8", "--yes", "--json");
  assert.equal(installed.codigo, 0, installed.salida);
  assert.deepEqual(JSON.parse(installed.salida), { status: "installed", version: "0.1.8" });
  assert.deepEqual(JSON.parse(readFileSync(log, "utf8")), ["install", "-g", "@telpin-sistemas/orqen-desktop@0.1.8"]);

  const studio = { ...env, ORQEN_DESKTOP_NPM_MANIFEST: join(global, "@telpin-sistemas/orqen-studio/package.json") };
  const studioCheck = orqenCon(studio, repo, "desktop-release", "0.1.7");
  assert.equal(studioCheck.codigo, 0, studioCheck.salida);
  assert.equal(JSON.parse(studioCheck.salida).status, "available");
  const studioUpdate = orqenCon({ ...env, ORQEN_DESKTOP_NPM_MANIFEST: "" }, repo, "update", "--desktop", "--target", "0.1.8", "--yes", "--json");
  assert.equal(studioUpdate.codigo, 0, studioUpdate.salida);
  assert.deepEqual(JSON.parse(readFileSync(log, "utf8")), ["install", "-g", "@telpin-sistemas/orqen-studio@0.1.8"]);
});

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

  // two files with English keys: config.yaml (the flow) and environment.yaml (stack, processes, tests)
  const cfg = parse(readFileSync(join(repo, "orqen/config.yaml"), "utf8"));
  const env = parse(readFileSync(join(repo, "orqen/environment.yaml"), "utf8"));
  assert.equal(cfg.version, 1);
  assert.equal(cfg.project.base_branch, "main");
  assert.equal(cfg.workflow.devel_branch, "desarrollo");
  assert.equal(cfg.stack, undefined);
  assert.equal(cfg.entornos, undefined);
  assert.deepEqual(env.processes.map((x: any) => `${x.name}:${x.command}:${x.when}`).sort(), ["api:pnpm start:always", "web:pnpm dev:e2e"]);
  assert.ok(env.stack.summary);
  assert.equal(existsSync(catalogo), false, "init must leave the external catalog untouched");
  assert.equal(existsSync(join(repo, "orqen/tools/db.mjs")), false, "init does not scaffold services from a catalog");
  // Claude Code loads the /orqen:* commands from the committed project settings once the folder is trusted.
  const claude = JSON.parse(readFileSync(join(repo, ".claude/settings.json"), "utf8"));
  assert.deepEqual(claude.extraKnownMarketplaces.orqen.source, { source: "directory", path: "./" });
  assert.equal(claude.enabledPlugins["orqen@orqen"], true);
  assert.equal(env.tests.e2e, "pnpm exec playwright test");
  assert.ok(!JSON.stringify([cfg, env]).includes("null"), "no null values in the configuration");
  for (const k of ["proyecto", "conectores", "flujo", "agente", "entornos", "procesos", "nombre", "comando", "resumen"])
    assert.doesNotMatch(readFileSync(join(repo, "orqen/config.yaml"), "utf8") + readFileSync(join(repo, "orqen/environment.yaml"), "utf8"), new RegExp(`^\\s*-?\\s*${k}:`, "m"), `no Spanish key ${k}`);

  assert.ok(!existsSync(join(repo, "docker-compose.orqen.yml")), "no Docker in between");
  assert.match(readFileSync(join(repo, "AGENTS.md"), "utf8"), /orqen env up/);
  assert.ok(existsSync(join(repo, "orqen/manifest.json")));
});

test("orqen init --connectors saves the connectors and the provider accounts outside the repository", () => {
  const repo = repoTemporal(MONOREPO);
  const usuario = repoTemporal({}, false);
  const draft = join(usuario, "connectors.json");
  writeFileSync(draft, JSON.stringify({
    conectores: { requests: { tipo: "jira", proyecto: "SOP", filtro: "project = SOP AND labels = orqen" }, issues: { tipo: "github", repo: "my-org/my-repo", etiquetas: ["orqen"] } },
    // Unreachable on purpose: the check fails, the connectors are saved anyway.
    env: { JIRA_URL: "http://127.0.0.1:9", JIRA_USER: "bot@example.com", JIRA_TOKEN: "jira-secret-token", JIRA_DEPLOYMENT: "server" },
  }));
  const r = orqenCon({ ORQEN_USER_CONFIG_DIR: usuario, GITHUB_TOKEN: "", GH_TOKEN: "" }, repo, "init", "--yes", "--no-ai", "--no-openspec", "--connectors", draft);
  assert.equal(r.codigo, 0, r.salida);
  assert.match(r.salida, /Connectors saved/);
  const cfg = parse(readFileSync(join(repo, "orqen/config.yaml"), "utf8"));
  assert.equal(cfg.connectors.requests.type, "jira");
  assert.equal(cfg.connectors.issues.repo, "my-org/my-repo");
  assert.ok(!readFileSync(join(repo, "orqen/config.yaml"), "utf8").includes("jira-secret-token"), "no secrets in config.yaml");
  assert.match(readFileSync(join(usuario, "credentials.env"), "utf8"), /JIRA_TOKEN=.*jira-secret-token/);

  // Re-running init with --no-connectors keeps them.
  const r2 = orqenCon({ ORQEN_USER_CONFIG_DIR: usuario }, repo, "init", "--yes", "--no-ai", "--no-openspec", "--no-connectors");
  assert.equal(r2.codigo, 0, r2.salida);
  assert.equal(parse(readFileSync(join(repo, "orqen/config.yaml"), "utf8")).connectors.requests.filter, "project = SOP AND labels = orqen");
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

  // Simulate an edited guide and an older kit.
  writeFileSync(join(repo, "orqen/stages/delivery.md"), "# Local delivery guide\n");
  const manifest = JSON.parse(readFileSync(join(repo, "orqen/manifest.json"), "utf8"));
  const installedKit = manifest.kit;
  manifest.kit = "0.0.9";
  writeFileSync(join(repo, "orqen/manifest.json"), JSON.stringify(manifest));

  const r2 = orqen(repo, "update", "--yes", "--no-cli", "--no-openspec");
  assert.equal(r2.codigo, 0, r2.salida);
  assert.ok(r2.salida.includes(`Kit 0.0.9 → ${installedKit}`), r2.salida);
  assert.equal(readFileSync(join(repo, "orqen/stages/delivery.md"), "utf8"), "# Local delivery guide\n");
  assert.ok(existsSync(join(repo, "orqen/stages/delivery.md.orqen-new")));
  // init writes the flow settings into config.yaml, where the team edits them
  assert.match(readFileSync(join(repo, "orqen/config.yaml"), "utf8"), /workflow:[\s\S]*devel_branch: desarrollo/);
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
  const ok = orqen(repo, "env", "test", "unit");
  assert.equal(ok.codigo, 0, ok.salida);
  const mal = orqen(repo, "env", "test");
  assert.equal(mal.codigo, 1);
  assert.match(mal.salida, /✘ e2e/);
});

test("orqen env test <type> -- <args> appends the arguments to that type's command (only the e2e of a change)", () => {
  const repo = repoTemporal({ "README.md": "x" });
  mkdirSync(join(repo, "orqen"), { recursive: true });
  writeFileSync(join(repo, "orqen/config.yaml"), stringify({
    version: 1, orqen: { cli: "0.1.0", kit: "0.1.0" }, proyecto: { nombre: "x", rama_base: "main" },
    openspec: { instalacion: "global" }, stack: { resumen: "x" },
    entornos: { tests: { e2e: `node -e "process.exit(process.argv[1] === 'tests/a.spec.ts' && process.argv[2] === 'login ok' ? 0 : 3)"` } },
  }));
  const ok = orqen(repo, "env", "test", "e2e", "--", "tests/a.spec.ts", "login ok");
  assert.equal(ok.codigo, 0, ok.salida);
  const sinFiltro = orqen(repo, "env", "test", "e2e");
  assert.equal(sinFiltro.codigo, 1);
  const sinTipo = orqen(repo, "env", "test", "--", "tests/a.spec.ts");
  assert.equal(sinTipo.codigo, 1);
  assert.match(sinTipo.salida, /Name the test type/);
});


test("init reuses project-local database scripts without a stack repository", () => {
  const repo = repoTemporal(MONOREPO);
  mkdirSync(join(repo, "orqen/tools"), { recursive: true });
  const script = "// Existing project-local database script\n";
  writeFileSync(join(repo, "orqen/tools/db.mjs"), script);
  writeFileSync(join(repo, "orqen/tools/db.json"), JSON.stringify({ engine: "postgres", port: 5432 }));
  const result = orqen(repo, "init", "--yes", "--no-ai", "--no-openspec");
  assert.equal(result.codigo, 0, result.salida);
  const env = parse(readFileSync(join(repo, "orqen/environment.yaml"), "utf8"));
  const databases = env.processes.filter((p: any) => p.name === "db");
  assert.equal(databases.length, 1);
  assert.equal(databases[0].command, "node orqen/tools/db.mjs up");
  assert.equal(databases[0].stop, "node orqen/tools/db.mjs down");
  assert.equal(readFileSync(join(repo, "orqen/tools/db.mjs"), "utf8"), script);
});

test("orqen init --commit commits only what orqen wrote; without it, init leaves the files uncommitted and explains how", () => {
  const git = (cwd: string, ...a: string[]) => spawnSync("git", a, { cwd, encoding: "utf8" });
  // a repository with history, and a file of the person's own that init must not touch
  const nuevo = () => {
    const r = repoTemporal({ "README.md": "x", "package.json": { name: "x", scripts: { test: "node --test" } } });
    git(r, "config", "user.name", "orqen-test");
    git(r, "config", "user.email", "test@example.com");
    git(r, "add", "-A"); git(r, "commit", "-qm", "first");
    writeFileSync(join(r, "mine.txt"), "mine");
    git(r, "add", "mine.txt");
    return r;
  };
  const repo = nuevo();

  const plain = orqen(repo, "init", "--yes", "--no-ai", "--no-openspec", "--no-connectors");
  assert.equal(plain.codigo, 0, plain.salida);
  assert.match(plain.salida, /4. Commit the changes/);   // the note box wraps the command, so it is not matched as one line
  assert.match(plain.salida, /git commit -m "Install orqen"/);
  assert.equal(git(repo, "log", "--oneline").stdout.trim().split("\n").length, 1, "--yes alone does not commit");

  const repo2 = nuevo();   // init stops when the repository already has orqen/config.yaml
  const withCommit = orqen(repo2, "init", "--yes", "--no-ai", "--no-openspec", "--no-connectors", "--commit");
  assert.equal(withCommit.codigo, 0, withCommit.salida);
  assert.doesNotMatch(withCommit.salida, /4. Commit the changes/);
  const log = git(repo2, "log", "--oneline", "-1").stdout;
  assert.match(log, /Install orqen/);
  const files = git(repo2, "show", "--name-only", "--format=", "HEAD").stdout;
  assert.match(files, /orqen\/config\.yaml/);
  assert.match(files, /AGENTS\.md/);
  assert.doesNotMatch(files, /mine\.txt/);
  assert.match(git(repo2, "status", "--short").stdout, /^A\s+mine\.txt/m, "the person's staged file stays staged");
});

test("with nothing configured, the connectors say so instead of failing as a Jira without URL", () => {
  const repo = repoTemporal({ "package.json": { name: "x" } });
  const env = { JIRA_URL: "", REC_JQL: "", ORQEN_USER_CONFIG_DIR: join(repo, "no-user-config") };
  assert.equal(orqenCon(env, repo, "init", "--yes", "--no-ai", "--no-openspec", "--no-connectors").codigo, 0);
  const r = orqenCon(env, repo, "connectors");
  assert.match(r.salida, /not configured/);
  assert.match(r.salida, /No connectors are configured: run `orqen connectors setup`/);
  assert.doesNotMatch(r.salida, /Jira connector without URL/);
  const list = orqenCon(env, repo, "list", "requests");
  assert.match(list.salida, /orqen connectors setup/);
});
