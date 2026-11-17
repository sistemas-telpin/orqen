import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TEMPLATES_DIR } from "../lib/template-assets.ts";
import { existeConfig, leerConfig, type Config as ProjectConfig } from "../lib/config.ts";

export const REC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const env = (k: string, d = "") => process.env[k] ?? d;
const split = (v: string) => v.split(",").map((s) => s.trim()).filter(Boolean);
const kv = (v: string) => Object.fromEntries(split(v).map((p) => p.split("=").map((s) => s.trim())));

function repoRoot(): string {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: process.cwd(), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return process.cwd();
  }
}

export interface Config {
  jiraUrl: string; jiraUser: string; jiraToken: string; jiraDeployment: "cloud" | "server";
  jql: string;
  /** analysis = analysts (they also unblock BLOCKED together with code). */
  approvers: { analysis?: string[]; code: string[]; client: string[]; execution?: string[] };
  jiraTransitions: Record<string, string>;
  /** SIS: issue created in another Jira project when the analysis closes (all lanes). */
  sis: { project: string; type: string; link: string; transitions: Record<string, string>; operationalType: string };
  factoryDir: string;       // per-REC record and state: orqen/work/<KEY>/ (committed with the branch)
  repoPath: string; baseBranch: string; testCommand: string;
  /** `orqen pr`: integration branch ("desarrollo"/"devel") the REC branch is sent to, and the command that opens that PR. */
  develBranch: string; develPrCommand: string;
  openspecCmd: string;
  stateDir: string; lockMinutes: number; stagesDir: string;
  environment?: ProjectConfig["entornos"];
  agentCmd: string; intervalSec: number;
}

export function loadConfig(over: Partial<Config> = {}): Config {
  const repoPath = over.repoPath ?? (env("REPO_PATH") || repoRoot());
  const envFile = [join(repoPath, "orqen", ".env"), join(repoPath, "cli", ".env")].find(existsSync);
  if (!over.repoPath && envFile) process.loadEnvFile(envFile);
  const project = !over.repoPath && existeConfig(repoPath) ? leerConfig(repoPath) : undefined;
  const stages = [join(repoPath, "orqen", "stages"), join(repoPath, "cli", "stages")].find(existsSync);
  const localOpenSpec = join(repoPath, "node_modules", ".bin", process.platform === "win32" ? "openspec.cmd" : "openspec");
  const localState = join(repoPath, "cli", ".state");
  const baseBranch = env("BASE_BRANCH", project?.proyecto.rama_base ?? "main");
  return {
    jiraUrl: env("JIRA_URL"), jiraUser: env("JIRA_USER"), jiraToken: env("JIRA_TOKEN"),
    jiraDeployment: env("JIRA_DEPLOYMENT", "cloud") as "cloud" | "server",
    jql: env("REC_JQL", "project = REC AND labels = rec-agente AND statusCategory != Done"),
    approvers: {
      analysis: split(env("APPROVERS_ANALYSIS")),
      code: split(env("APPROVERS_CODE")),
      client: split(env("APPROVERS_CLIENT")),
      execution: split(env("APPROVERS_EXECUTION")),
    },
    jiraTransitions: kv(env("JIRA_TRANSITIONS")),
    sis: {
      project: env("SIS_PROJECT", "SIS"), type: env("SIS_TYPE", "Task"), link: env("SIS_LINK", "Relates"),
      transitions: kv(env("SIS_TRANSITIONS")),
      operationalType: env("SIS_TYPE_OPERATIONAL") || env("SIS_TYPE", "Task"),
    },
    factoryDir: env("FACTORY_DIR") || join(repoPath, "orqen", "work"),
    repoPath,
    baseBranch,
    testCommand: env("TEST_COMMAND", "npm test"),
    develBranch: env("DEVEL_BRANCH", "desarrollo"),
    develPrCommand: env("DEVEL_PR_COMMAND", 'gh pr create --base {base} --head {branch} --title "{key}: {title}" --body-file {body}'),
    openspecCmd: env("OPENSPEC_CMD") && env("OPENSPEC_CMD") !== "openspec" ? env("OPENSPEC_CMD") : existsSync(localOpenSpec) ? localOpenSpec : "openspec",
    stateDir: env("REC_STATE_DIR") || (existsSync(localState) || !project ? localState : join(repoPath, "orqen", "state")),
    stagesDir: stages ?? join(TEMPLATES_DIR, "stages"),
    environment: project?.entornos,
    lockMinutes: Number(env("REC_LOCK_MIN", "90")),
    // Headless agent command for `orqen cycle`. {prompt} is replaced (already escaped).
    agentCmd: env("AGENT_CMD") || project?.agente.comando || "claude -p --permission-mode acceptEdits",
    intervalSec: Number(env("REC_INTERVAL_SEC", "120")),
    ...over,
  };
}
