import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TEMPLATES_DIR } from "../lib/template-assets.ts";
import { existeConfig, leerConfig, type Config as ProjectConfig } from "../lib/config.ts";
import { type ConnectorsSettings, connectorSettings } from "../connectors/config.ts";
import { envWithLegacy, legacyConnectors, LEGACY_VARS } from "../connectors/legacy.ts";

export const CLI_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const env = (k: string, d = "") => process.env[k] ?? d;
const split = (v: string) => v.split(",").map((s) => s.trim()).filter(Boolean);
/** New variable name, falling back to the one used by earlier versions. */
const envL = (k: string, legacy: string, d = "") => envWithLegacy(process.env, k, legacy, d);

function repoRoot(): string {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: process.cwd(), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return process.cwd();
  }
}

export interface Config {
  /** Where the tickets live: requests (what the client sees) and optional issues (the team's). See connectors/. */
  connectors: ConnectorsSettings;
  /** SUPPORT_STAGE=on: `orqen pending` sends new requests to the support person first. `orqen support` works either way, and the analyst can still take a NEW one directly. */
  supportStage: boolean;
  /** analysis = analysts (they also unblock BLOCKED together with code). qa = who decides QA_REVIEW (full lane). Accounts of the requests system. */
  approvers: { analysis?: string[]; qa?: string[]; code: string[]; client: string[]; execution?: string[] };
  factoryDir: string;       // record and state of each request: orqen/work/<KEY>/ (committed with the branch)
  repoPath: string; baseBranch: string; testCommand: string;
  /** `orqen pr`: integration branch ("desarrollo"/"devel") the request branch is sent to, and the command that opens that PR. */
  develBranch: string; develPrCommand: string;
  /** Who decides in CODE_REVIEW: the review on the PR in GitHub or `/approve`/`/reject` on the request. */
  codeReviewGate: "github" | "ticket";
  /** GitHub logins whose reviews count in CODE_REVIEW when codeReviewGate is github (empty = any reviewer). Separate from approvers.code, which are accounts of the requests system. */
  githubReviewers: string[];
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
    connectors: project?.conectores
      ? { requests: connectorSettings(project.conectores.requests, process.env, project.general?.prefijos.requests), issues: project.conectores.issues ? connectorSettings(project.conectores.issues, process.env, project.general?.prefijos.issues) : undefined }
      : legacyConnectors(process.env),
    supportStage: ["on", "true", "1", "yes"].includes(env("SUPPORT_STAGE").toLowerCase()),
    approvers: {
      analysis: split(env("APPROVERS_ANALYSIS")),
      qa: split(env("APPROVERS_QA")),
      code: split(env("APPROVERS_CODE")),
      client: split(env("APPROVERS_CLIENT")),
      execution: split(env("APPROVERS_EXECUTION")),
    },
    factoryDir: env("FACTORY_DIR") || join(repoPath, "orqen", "work"),
    repoPath,
    baseBranch,
    testCommand: env("TEST_COMMAND", "npm test"),
    develBranch: env("DEVEL_BRANCH", "desarrollo"),
    develPrCommand: env("DEVEL_PR_COMMAND", 'gh pr create --base {base} --head {branch} --title "{key}: {title}" --body-file {body}'),
    // "jira" is the name used by earlier versions for "ticket"
    codeReviewGate: ["ticket", "jira"].includes(env("CODE_REVIEW_GATE", "github")) ? "ticket" : "github",
    githubReviewers: split(env("GITHUB_REVIEWERS")),
    openspecCmd: env("OPENSPEC_CMD") && env("OPENSPEC_CMD") !== "openspec" ? env("OPENSPEC_CMD") : existsSync(localOpenSpec) ? localOpenSpec : "openspec",
    stateDir: envL("ORQEN_STATE_DIR", "REC_STATE_DIR") || (existsSync(localState) || !project ? localState : join(repoPath, "orqen", "state")),
    stagesDir: stages ?? join(TEMPLATES_DIR, "stages"),
    environment: project?.entornos,
    lockMinutes: Number(envL("ORQEN_LOCK_MIN", "REC_LOCK_MIN", "90")),
    // Headless agent command for `orqen cycle`. {prompt} is replaced (already escaped).
    agentCmd: env("AGENT_CMD") || project?.agente.comando || "claude -p --permission-mode acceptEdits",
    intervalSec: Number(envL("ORQEN_INTERVAL_SEC", "REC_INTERVAL_SEC", "120")),
    ...over,
  };
}

let warned = false;
/** Warns once when orqen/.env still uses the variables of earlier versions. */
export function warnLegacy(cfg: Config) {
  const used = cfg.connectors.legacy ?? [];
  if (warned || !used.length) return;
  warned = true;
  console.error(`[orqen] orqen/.env uses variables of an earlier version (${used.join(", ")}). They still work; ` +
    `run \`orqen update\` to move them to \`conectores\` in orqen/config.yaml (${used.map((k) => `${k} → ${LEGACY_VARS[k]}`).join(", ")}).`);
}
