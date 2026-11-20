/** `orqen doctor`: every problem of the setup at once, each with what to do. */
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { type Check, diagnose, type Runner } from "../src/commands/doctor.ts";
import { loadConfig } from "../src/workflow/config.ts";
import { FakeTracker, testConnectors } from "./fakes.ts";
import { repoTemporal } from "./helpers.ts";

const cfgOf = (repo: string) => loadConfig({ repoPath: repo, stateDir: join(repo, "orqen", "state"), connectors: testConnectors(false), develBranch: "desarrollo" });
const byName = (cs: Check[]) => Object.fromEntries(cs.map((c) => [c.name, c]));

/** A system where git works, gh is missing, the base branch is not on origin and the agent is installed. */
const broken: Runner = (cmd, args) => {
  if (cmd === "gh") return { code: null, stdout: "", stderr: "", error: Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" }) };
  if (cmd === "git" && args[0] === "remote") return { code: 0, stdout: "https://github.com/acme/app.git\n", stderr: "" };
  if (cmd === "git" && args[0] === "ls-remote") return { code: 2, stdout: "", stderr: "" };
  return { code: 0, stdout: "1.0.0\n", stderr: "" };
};

test("doctor reports each problem with what to do, and fails when the flow cannot work", async () => {
  const repo = repoTemporal();
  const checks = byName(await diagnose(cfgOf(repo), { requests: new FakeTracker({}) }, broken));
  assert.equal(checks.git.status, "ok");
  assert.deepEqual([checks.orqen.status, checks.orqen.fix], ["fail", "orqen init"]);
  assert.equal(checks.gh.status, "fail");
  assert.match(checks.gh.detail, /not installed or is not in the PATH/);
  assert.equal(checks["base branch"].status, "fail");
  assert.match(checks["base branch"].detail, /desarrollo/);
  assert.deepEqual([checks["requests connector"].status, checks["issues connector"].status], ["ok", "ok"]);
  assert.equal(checks.CI.status, "warn");
  assert.equal(checks.agent.status, "ok");
});

test("doctor with everything in place", async () => {
  const repo = repoTemporal({
    "orqen/config.yaml": "version: 1\norqen:\n  cli: 0.0.0\n  kit: 0.0.0\nproject:\n  name: app\n  base_branch: main\nopenspec:\n  install: global\n",
    "orqen/environment.yaml": "tests:\n  unit: npm test\n",
    ".github/workflows/ci.yml": "on: push\n",
  });
  const fine: Runner = (cmd, args) => cmd === "gh" ? { code: 0, stdout: "", stderr: "  ✓ Logged in to github.com account dev\n" }
    : cmd === "git" && args[0] === "remote" ? { code: 0, stdout: "https://github.com/acme/app.git\n", stderr: "" } : { code: 0, stdout: "1.0.0\n", stderr: "" };
  const checks = await diagnose(cfgOf(repo), { requests: new FakeTracker({}) }, fine);
  assert.deepEqual(checks.filter((c) => c.status === "fail"), []);
  const c = byName(checks);
  assert.match(c.gh.detail, /Logged in/);
  assert.equal(c.tests.detail, "configured: unit");
  assert.equal(c.CI.status, "ok");
  assert.equal(c.kit.status, "warn", "no manifest: the kit is not the CLI's");
});

test("an invalid orqen/config.yaml is reported, not skipped", async () => {
  const repo = repoTemporal({ "orqen/config.yaml": "version: 1\nproject:\n  name: app\n" });
  const c = byName(await diagnose(cfgOf(repo), { requests: new FakeTracker({}) }, broken));
  assert.equal(c.config.status, "fail");
  assert.match(c.config.detail, /orqen\/config\.yaml/);
});

test("a connector that fails its check is a problem to fix", async () => {
  const repo = repoTemporal();
  const bad = Object.assign(new FakeTracker({}), { check: async () => ({ ok: false, detail: "401 bad credentials" }) });
  const checks = byName(await diagnose(cfgOf(repo), { requests: bad }, broken));
  assert.deepEqual([checks["requests connector"].status, checks["requests connector"].fix], ["fail", "orqen connectors setup"]);
  assert.match(checks["requests connector"].detail, /401/);
});
