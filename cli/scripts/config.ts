import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const envFile = join(REC_DIR, ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

const env = (k: string, d = "") => process.env[k] ?? d;
const split = (v: string) => v.split(",").map((s) => s.trim()).filter(Boolean);
const kv = (v: string) => Object.fromEntries(split(v).map((p) => p.split("=").map((s) => s.trim())));

function repoRoot(): string {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: REC_DIR, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return resolve(REC_DIR, "..");
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
  repoPath: string; baseBranch: string; testCommand: string; prCommand: string;
  openspecCmd: string;
  stateDir: string; lockMinutes: number;
  agentCmd: string; intervalSec: number;
}

export function loadConfig(over: Partial<Config> = {}): Config {
  const repoPath = over.repoPath ?? (env("REPO_PATH") || repoRoot());
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
    baseBranch: env("BASE_BRANCH", "main"),
    testCommand: env("TEST_COMMAND", "npm test"),
    prCommand: env("PR_COMMAND", 'gh pr create --base main --head {branch} --title "{key}: {title}" --body-file {body}'),
    openspecCmd: env("OPENSPEC_CMD", "openspec"),
    stateDir: env("REC_STATE_DIR", join(REC_DIR, ".state")),
    lockMinutes: Number(env("REC_LOCK_MIN", "90")),
    // Headless agent command for `orqen cycle`. {prompt} is replaced (already escaped).
    agentCmd: env("AGENT_CMD", "claude -p {prompt} --permission-mode acceptEdits"),
    intervalSec: Number(env("REC_INTERVAL_SEC", "120")),
    ...over,
  };
}
