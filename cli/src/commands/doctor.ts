/**
 * `orqen doctor`: everything the flow needs on this machine and in this repository, checked at once, each problem with what to do.
 * The same things otherwise show up one at a time, in the middle of a stage (gh missing at `orqen pr`, a base branch that is not on
 * origin, a connector without credentials…).
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Connectors } from "../connectors/index.ts";
import { existeConfig, leerConfig } from "../lib/config.ts";
import { leerManifest } from "../lib/kit.ts";
import { VERSION_CLI } from "../lib/system.ts";
import type { Config as FlowConfig } from "../workflow/config.ts";
import { ghFailure } from "../workflow/workspace.ts";

export type CheckStatus = "ok" | "warn" | "fail";
export interface Check { name: string; status: CheckStatus; detail: string; fix?: string }

/** Runs a program: what doctor needs from the system (replaced in the tests). */
export type Runner = (cmd: string, args: string[], o?: { cwd?: string; shell?: boolean }) => { code: number | null; stdout: string; stderr: string; error?: NodeJS.ErrnoException };

export const systemRunner: Runner = (cmd, args, o = {}) => {
  const r = spawnSync(cmd, args, { cwd: o.cwd, shell: o.shell, encoding: "utf8", windowsHide: true, timeout: 30_000 });
  return { code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "", error: r.error as NodeJS.ErrnoException | undefined };
};

export async function diagnose(cfg: FlowConfig, connectors: Partial<Connectors>, run: Runner = systemRunner): Promise<Check[]> {
  const repo = cfg.repoPath;
  const out: Check[] = [];
  const add = (name: string, status: CheckStatus, detail: string, fix?: string) => out.push({ name, status, detail, ...(fix ? { fix } : {}) });

  // --- repository
  const origin = run("git", ["remote", "get-url", "origin"], { cwd: repo });
  if (origin.error?.code === "ENOENT") add("git", "fail", "git is not installed or is not in the PATH", "Install git and open a new terminal");
  else if (origin.code !== 0) add("git", "fail", "the repository has no origin remote: branches and PRs cannot be pushed", "git remote add origin <url>");
  else add("git", "ok", `origin: ${origin.stdout.trim()}`);

  // --- orqen in the project
  const installed = existeConfig(repo);
  if (!installed) add("orqen", "fail", "orqen is not installed in this repository (no orqen/config.yaml)", "orqen init");
  else {
    const kit = leerManifest(repo).kit;
    if (kit === VERSION_CLI) add("kit", "ok", `kit ${kit}, same as the CLI`);
    else add("kit", "warn", `the kit is ${kit} and the CLI ${VERSION_CLI}: the /orqen:* commands may not match the CLI`, "orqen update --no-cli");
  }

  // --- GitHub CLI: orqen pr, the senior's review, CI and merge detection
  const gh = run("gh", ["auth", "status"], { cwd: repo });
  if (gh.error || gh.code !== 0) {
    const why = ghFailure(gh.error ?? Object.assign(new Error(gh.stderr || "gh failed"), { stderr: gh.stderr }));
    add("gh", "fail", why, gh.error?.code === "ENOENT" ? "Install it from https://cli.github.com and open a new terminal" : "gh auth login");
  } else add("gh", "ok", (gh.stdout + gh.stderr).split("\n").map((l) => l.trim()).find((l) => /logged in/i.test(l)) ?? "logged in");

  // --- the branch PRs go to
  if (origin.code === 0) {
    const base = run("git", ["ls-remote", "--exit-code", "--heads", "origin", cfg.develBranch], { cwd: repo });
    if (base.code === 0) add("base branch", "ok", `${cfg.develBranch} exists on origin`);
    else if (base.code === 2) add("base branch", "fail", `the branch PRs go to (${cfg.develBranch}) does not exist on origin: orqen pr will refuse to open them`,
      `git push origin <branch>:${cfg.develBranch}, or set workflow.devel_branch in orqen/config.yaml`);
    else add("base branch", "warn", `could not check whether ${cfg.develBranch} exists on origin (${(base.stderr || "no answer").trim().split("\n")[0]})`);
  }

  // --- connectors
  for (const role of ["requests", "issues"] as const) {
    const t = connectors[role];
    const name = role === "requests" ? "requests connector" : "issues connector";
    if (!t) {
      if (role === "requests") add(name, "fail", "not configured: orqen has nowhere to read the requests from", "orqen connectors setup");
      else add(name, "ok", "not configured: development issues go to the requests connector");
      continue;
    }
    let r: { ok: boolean; detail: string };
    try { r = await t.check(); } catch (e) { r = { ok: false, detail: (e as Error).message.split("\n")[0] }; }
    add(name, r.ok ? "ok" : "fail", `${t.label}: ${r.detail}`, r.ok ? undefined : "orqen connectors setup");
  }

  // --- CI: without it, the senior approves without knowing whether the tests pass on the PR
  const wf = join(repo, ".github", "workflows");
  const workflows = existsSync(wf) ? readdirSync(wf).filter((f) => /\.ya?ml$/i.test(f)) : [];
  if (workflows.length) add("CI", "ok", `${workflows.length} GitHub Actions workflow(s)`);
  else add("CI", "warn", "no GitHub Actions workflows: /orqen:approve cannot check that the tests pass on the PR",
    "Add a workflow in .github/workflows that runs the tests (if CI runs elsewhere, ignore this)");

  // --- tests the testing stage runs
  if (installed) {
    let tests: Record<string, unknown> | undefined;
    try { tests = leerConfig(repo).entornos.tests; }
    catch (e) { add("config", "fail", (e as Error).message.replace(/\n/g, " "), "Fix orqen/config.yaml and orqen/environment.yaml as the message says"); }
    const inFile: Record<string, string> = { unitarios: "unit", integracion: "integration" };   // as written in orqen/environment.yaml
    const set = Object.entries(tests ?? {}).filter(([, v]) => v).map(([k]) => inFile[k] ?? k);
    if (set.length) add("tests", "ok", `configured: ${set.join(", ")}`);
    else if (tests) add("tests", "warn", "no tests in orqen/environment.yaml: the testing stage has nothing to run", "Set tests.unit in orqen/environment.yaml");
  }

  // --- the agent that runs the stages unattended (orqen cycle, orqen eval)
  const agent = cfg.agentCmd.trim().split(/\s+/)[0];
  if (agent) {
    const a = run(agent, ["--version"], { cwd: repo, shell: process.platform === "win32" });
    if (a.error?.code === "ENOENT" || a.code === 127 || (process.platform === "win32" && a.code === 1 && /not recognized/i.test(a.stderr)))
      add("agent", "warn", `${agent} (agent.command) is not in the PATH: orqen cycle and orqen eval cannot run it`, `Install ${agent} or change agent.command in orqen/config.yaml`);
    else add("agent", "ok", `${agent} ${a.stdout.trim().split("\n")[0]}`.trim());
  }
  return out;
}

const ICON: Record<CheckStatus, string> = { ok: "✔", warn: "⚠", fail: "✘" };

export function printChecks(checks: Check[]) {
  const w = Math.max(...checks.map((c) => c.name.length));
  for (const c of checks) {
    console.log(`${ICON[c.status]} ${c.name.padEnd(w)}  ${c.detail}`);
    if (c.fix && c.status !== "ok") console.log(`  ${" ".repeat(w)}  → ${c.fix}`);
  }
  const fails = checks.filter((c) => c.status === "fail").length, warns = checks.filter((c) => c.status === "warn").length;
  console.log(fails ? `\n${fails} problem(s) to fix before using the flow${warns ? `, ${warns} warning(s)` : ""}.`
    : warns ? `\nReady, with ${warns} warning(s).` : "\nEverything is ready.");
}
