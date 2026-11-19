/** The worq: orqen's unit of work. Where it lives (orqen/worqs/), how a repository of earlier versions (orqen/work/) keeps working and moves. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig, warnLegacy, worqsDirOf } from "../src/workflow/config.ts";
import { moveWorkToWorqs, worqFiles } from "../src/lib/worqs.ts";
import { GitWorkspace } from "../src/workflow/workspace.ts";
import { testConnectors } from "./fakes.ts";

const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

test("the worqs folder: orqen/worqs/ by default, orqen/work/ of earlier versions while it is the only one, WORQS_DIR or FACTORY_DIR first", () => {
  const repo = mkdtempSync(join(tmpdir(), "orqen-dir-"));
  assert.deepEqual(worqsDirOf(repo), { dir: join(repo, "orqen", "worqs"), legacy: false });
  mkdirSync(join(repo, "orqen", "work"), { recursive: true });
  assert.deepEqual(worqsDirOf(repo), { dir: join(repo, "orqen", "work"), legacy: true });
  mkdirSync(join(repo, "orqen", "worqs"), { recursive: true });
  assert.deepEqual(worqsDirOf(repo), { dir: join(repo, "orqen", "worqs"), legacy: false });   // the new one wins when both exist
  assert.deepEqual(worqsDirOf(repo, "/somewhere/else"), { dir: "/somewhere/else", legacy: false });
});

test("a repository that still has orqen/work/ keeps working, and is told once to run orqen update", () => {
  const repo = realpathSync.native(mkdtempSync(join(tmpdir(), "orqen-legacy-")));
  git(repo, "init", "-q", "-b", "main");
  mkdirSync(join(repo, "orqen", "work", "REQ-1"), { recursive: true });
  const cfg = loadConfig({ repoPath: repo, stateDir: join(repo, "orqen", "state"), connectors: testConnectors(false), approvers: { code: [], client: [] } });
  assert.equal(cfg.factoryDir, join(repo, "orqen", "work"));
  assert.equal(cfg.legacyWorkDir, true);
  const lines: string[] = [];
  const log = console.error;
  console.error = (m: string) => { lines.push(m); };
  try { warnLegacy({ ...cfg, legacyWorkDir: true }); warnLegacy({ ...cfg, legacyWorkDir: true }); } finally { console.error = log; }
  assert.equal(lines.length, 1);
  assert.match(lines[0], /orqen\/worqs\/[\s\S]*orqen\/work\/[\s\S]*orqen update/);
});

test("orqen update moves orqen/work/ to orqen/worqs/ (git mv) and keeps the kit README as an unedited kit file", () => {
  const repo = realpathSync.native(mkdtempSync(join(tmpdir(), "orqen-mv-")));
  git(repo, "init", "-q", "-b", "main");
  mkdirSync(join(repo, "orqen", "work", "REQ-1", "round-1"), { recursive: true });
  writeFileSync(join(repo, "orqen", "work", "README.md"), "# orqen/work\n");
  writeFileSync(join(repo, "orqen", "work", "REQ-1", "round-1", "analysis.md"), "a");
  writeFileSync(join(repo, "orqen", "manifest.json"), JSON.stringify({ kit: "0.1.0", archivos: { "orqen/work/README.md": "abc", "AGENTS.md#orqen": "def" } }));
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "old install");
  assert.deepEqual(moveWorkToWorqs(repo), { moved: true, detail: "orqen/work/ → orqen/worqs/" });
  assert.equal(existsSync(join(repo, "orqen", "work")), false);
  assert.ok(existsSync(join(repo, "orqen", "worqs", "REQ-1", "round-1", "analysis.md")));
  assert.match(git(repo, "status", "--short"), /^R\s+orqen\/work\/README\.md -> orqen\/worqs\/README\.md/m);   // a rename for git, not delete + add
  const manifest = JSON.parse(readFileSync(join(repo, "orqen", "manifest.json"), "utf8"));
  assert.deepEqual(manifest.archivos, { "AGENTS.md#orqen": "def", "orqen/worqs/README.md": "abc" });
  assert.deepEqual(worqFiles(join(repo, "orqen", "worqs", "REQ-1")), ["round-1/analysis.md"]);
  // nothing to move, or the new folder already there: it says so and touches nothing
  assert.equal(moveWorkToWorqs(repo).moved, false);
  mkdirSync(join(repo, "orqen", "work"), { recursive: true });
  assert.match(moveWorkToWorqs(repo).detail, /already exists/);
});

test("snapshots in branches of earlier versions (orqen/work/<KEY>/state.json) are still found", () => {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), "orqen-snap-old-")));
  git(base, "init", "-q", "-b", "main");
  writeFileSync(join(base, "a.txt"), "a");
  git(base, "add", "-A");
  git(base, "commit", "-qm", "init");
  const cfg = loadConfig({ repoPath: base, stateDir: join(base, "orqen", "state"), factoryDir: join(base, "orqen", "worqs"), connectors: testConnectors(false), approvers: { code: [], client: [] } });
  git(base, "checkout", "-q", "-b", "orqen/req-1");
  mkdirSync(join(base, "orqen", "work", "REQ-1"), { recursive: true });
  writeFileSync(join(base, "orqen", "work", "REQ-1", "state.json"), JSON.stringify({ key: "REQ-1", state: "TESTING", artifacts: {}, updated: "2026-11-19T10:00:00Z" }));
  git(base, "add", "-A");
  git(base, "commit", "-qm", "old snapshot");
  git(base, "checkout", "-q", "main");
  const found = new GitWorkspace(cfg).snapshotOf("REQ-1")!;
  assert.equal(found.source, "orqen/req-1:orqen/work/REQ-1/state.json");
  assert.equal((found.snapshot as any).state, "TESTING");
});
