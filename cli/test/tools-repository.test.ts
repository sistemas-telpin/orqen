import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { TOOLS_DIR } from "../src/lib/tools.ts";
import { catalogoTemporal, repoTemporal } from "./helpers.ts";
import { prepararTools, repositorioTools } from "../src/lib/tools-repository.ts";

// Redirect a GitHub URL to a local fixture through Git's native URL rewriting.
async function conRemoto(fn: () => Promise<void>, source = catalogoTemporal()) {
  const previous = { ...process.env };
  process.env.GIT_CONFIG_COUNT = "1";
  process.env.GIT_CONFIG_KEY_0 = `url.${source.replaceAll("\\", "/")}.insteadOf`;
  process.env.GIT_CONFIG_VALUE_0 = "https://github.com/example/catalog.git";
  delete process.env.ORQEN_TOOLS_REPO;
  try { await fn(); } finally { process.env = previous; }
}

test("GitHub references normalize HTTPS and SSH without accepting credentials or options", () => {
  for (const ref of ["@example/catalog", "example/catalog", "https://github.com/example/catalog.git/"]) {
    assert.deepEqual(repositorioTools(ref), { id: "example/catalog", url: "https://github.com/example/catalog.git" });
  }
  for (const ref of ["git@github.com:example/catalog.git", "ssh://git@github.com/example/catalog.git"]) {
    assert.equal(repositorioTools(ref).url, "git@github.com:example/catalog.git");
  }
  for (const bad of ["", "--upload-pack=anything", "../tools", "https://token@github.com/example/catalog", "https://gitlab.com/example/catalog", "@example/catalog;whoami"]) {
    assert.throws(() => repositorioTools(bad));
  }
  assert.match(TOOLS_DIR.replaceAll("\\", "/"), /\/cli\/tools$/);
});

test("first use requires a repository in unattended mode and creates no destination", async () => {
  await conRemoto(async () => {
    const dir = join(repoTemporal(), "tools");
    await assert.rejects(prepararTools(undefined, true, dir), /--tools-repo/);
    assert.equal(existsSync(dir), false);
  });
});

test("clone, pull, reuse offline and reject a different origin with an arbitrary repository name", async () => {
  const source = catalogoTemporal();
  await conRemoto(async () => {
    const dir = join(repoTemporal(), "tools");
    process.env.ORQEN_TOOLS_REPO = "@example/catalog";
    await prepararTools(undefined, true, dir);
    assert.ok(existsSync(join(dir, ".git")));
    assert.ok(existsSync(join(dir, "example/tool.yaml")));
    writeFileSync(join(dir, "personal.txt"), "keep my edits");
    await prepararTools(undefined, true, dir);
    assert.equal(readFileSync(join(dir, "personal.txt"), "utf8"), "keep my edits");
    writeFileSync(join(source, "catalog-version.txt"), "updated");
    execFileSync("git", ["add", "catalog-version.txt"], { cwd: source });
    execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-qm", "Update catalog"], { cwd: source });
    execFileSync("git", ["pull", "--ff-only"], { cwd: dir, stdio: "pipe" });
    assert.equal(readFileSync(join(dir, "catalog-version.txt"), "utf8"), "updated");
    assert.equal(readFileSync(join(dir, "personal.txt"), "utf8"), "keep my edits");
    await assert.rejects(prepararTools("@other/tools", true, dir), /belongs to example\/catalog/);
  }, source);
});

test("refuse existing plain directories without changing their content", async () => {
  const dir = join(repoTemporal(), "tools");
  mkdirSync(dir);
  writeFileSync(join(dir, "keep.txt"), "keep");
  await assert.rejects(prepararTools("@example/catalog", true, dir), /not a Git clone/);
  assert.equal(readFileSync(join(dir, "keep.txt"), "utf8"), "keep");
});

test("failed clones leave no destination or temporary checkout", async () => {
  await conRemoto(async () => {
    const parent = repoTemporal();
    const dir = join(parent, "tools");
    await assert.rejects(prepararTools("@example/catalog", true, dir), /Could not clone/);
    assert.equal(existsSync(dir), false);
    assert.deepEqual(readdirSync(parent), [".git"]);
  }, join(repoTemporal(), "missing"));
});

test("repositories without a stack are rejected and the temporary clone is cleaned", async () => {
  const empty = catalogoTemporal();
  // Use a different branch with no tool.yaml, preserving the valid fixture contract elsewhere.
  const { execFileSync } = await import("node:child_process");
  execFileSync("git", ["rm", "-qr", "."], { cwd: empty });
  execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-qm", "Empty catalog"], { cwd: empty });
  await conRemoto(async () => {
    const parent = repoTemporal();
    await assert.rejects(prepararTools("@example/catalog", true, join(parent, "tools")), /<stack>\/tool.yaml/);
    assert.deepEqual(readdirSync(parent), [".git"]);
  }, empty);
});

test("init does not clone the catalog and bootstrap cannot create projects", async () => {
  await conRemoto(async () => {
    const { spawnSync } = await import("node:child_process");
    const { fileURLToPath } = await import("node:url");
    const cli = fileURLToPath(new URL("../src/index.ts", import.meta.url));
    const tsx = fileURLToPath(new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url));
    const parent = repoTemporal();
    const catalog = join(parent, "personal-tools");
    const env = { ...process.env, NO_COLOR: "1", ORQEN_TOOLS_DIR: catalog, ORQEN_TOOLS_REPO: "@other/catalog" };
    const r = spawnSync(process.execPath, [tsx, cli, "init", "--dir", parent, "--yes", "--no-ai", "--no-openspec"], { env, encoding: "utf8" });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(existsSync(catalog), false, "init must not inspect or clone the external catalog");
    assert.ok(existsSync(join(parent, "orqen/config.yaml")));
    const createDir = join(parent, "new-project");
    const create = spawnSync(process.execPath, [tsx, cli, "bootstrap", "Example", "--dir", createDir, "--stack", "example", "--yes", "--no-openspec", "--tools-repo", "@example/catalog"], { env, encoding: "utf8" });
    assert.equal(create.status, 1, create.stdout + create.stderr);
    assert.match(create.stderr, /Unknown command: bootstrap/);
    assert.equal(existsSync(createDir), false);
    assert.equal(existsSync(catalog), false);
  });
});
