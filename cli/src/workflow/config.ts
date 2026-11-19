import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TEMPLATES_DIR } from "../lib/template-assets.ts";
import { existeConfig, leerConfig, type Config as ProjectConfig } from "../lib/config.ts";
import { type ConnectorsSettings, connectorSettings } from "../connectors/config.ts";
import { envWithLegacy, legacyConnectors, LEGACY_VARS } from "../connectors/legacy.ts";
import { providerEnv } from "../lib/provider-credentials.ts";

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

/**
 * The main working tree when `repo` is a linked git worktree (`git worktree add`), otherwise `repo`. The desktop app runs
 * each request in its own worktree so several agents can work at once; what git does not track (orqen/state, orqen/.env)
 * lives only in the main one, so every worktree shares the same requests state and credentials.
 */
export function mainWorktree(repo: string): string {
  try {
    const out = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .trim().split(/\r?\n/);
    const [gitDir, common] = out.map((p) => resolve(p));
    if (!gitDir || !common || gitDir === common) return repo;
    return basename(common) === ".git" ? dirname(common) : repo;
  } catch {
    return repo;
  }
}

export interface Config {
  /** Where the tickets live: requests (what the client sees) and optional issues (the team's). See connectors/. */
  connectors: ConnectorsSettings;
  /** SUPPORT_STAGE=on: `orqen list requests` sends new requests to the support person first. `orqen support` works either way, and the analyst can still take a NEW one directly. */
  supportStage: boolean;
  /** analysis = analysts (they also unblock BLOCKED together with code). qa = who decides QA_REVIEW (full lane). Accounts of the requests system. */
  approvers: { analysis?: string[]; qa?: string[]; code: string[]; client: string[]; execution?: string[] };
  /** Where the worqs live: orqen/worqs/<KEY>/ (committed with the request branch). The record and snapshot of each worq. */
  factoryDir: string;
  /** The repository still uses orqen/work/ (earlier versions): it keeps working, `orqen update` moves it to orqen/worqs/. */
  legacyWorkDir?: boolean;
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
  const main = mainWorktree(repoPath);
  const envFile = [join(repoPath, "orqen", ".env"), join(repoPath, "cli", ".env"), join(main, "orqen", ".env")].find(existsSync);
  if (!over.repoPath && envFile) process.loadEnvFile(envFile);
  const project = !over.repoPath && existeConfig(repoPath) ? leerConfig(repoPath) : undefined;
  const stages = [join(repoPath, "orqen", "stages"), join(repoPath, "cli", "stages")].find(existsSync);
  const localOpenSpec = join(repoPath, "node_modules", ".bin", process.platform === "win32" ? "openspec.cmd" : "openspec");
  const localState = join(main, "cli", ".state");
  const baseBranch = env("BASE_BRANCH", project?.proyecto.rama_base ?? "main");
  // WORQS_DIR (or FACTORY_DIR, its old name) wins; then orqen/worqs/; a repository that only has orqen/work/ keeps using it
  const worqsDir = worqsDirOf(repoPath, env("WORQS_DIR") || env("FACTORY_DIR"));
  const credentials = providerEnv(existsSync(join(repoPath, "orqen", ".env")) ? repoPath : main);
  // orqen/config.yaml (workflow) is the shared configuration; a variable in orqen/.env or the environment overrides it
  const f = project?.flujo;
  const list = (k: string, fromYaml?: string[]) => process.env[k] !== undefined && process.env[k] !== "" ? split(env(k)) : fromYaml ?? [];
  return {
    connectors: project?.conectores
      ? { requests: connectorSettings(project.conectores.requests, credentials, project.general?.prefijos.requests, repoPath), issues: project.conectores.issues ? connectorSettings(project.conectores.issues, credentials, project.general?.prefijos.issues, repoPath) : undefined }
      : legacyConnectors(credentials),
    supportStage: env("SUPPORT_STAGE") ? ["on", "true", "1", "yes"].includes(env("SUPPORT_STAGE").toLowerCase()) : !!f?.soporte,
    approvers: {
      analysis: list("APPROVERS_ANALYSIS", f?.aprobadores.analisis),
      qa: list("APPROVERS_QA", f?.aprobadores.qa),
      code: list("APPROVERS_CODE", f?.aprobadores.codigo),
      client: list("APPROVERS_CLIENT", f?.aprobadores.cliente),
      execution: list("APPROVERS_EXECUTION", f?.aprobadores.ejecucion),
    },
    factoryDir: worqsDir.dir,
    ...(worqsDir.legacy ? { legacyWorkDir: true } : {}),
    repoPath,
    baseBranch,
    testCommand: env("TEST_COMMAND") || f?.comando_tests || "npm test",
    develBranch: env("DEVEL_BRANCH") || f?.rama_desarrollo || "desarrollo",
    develPrCommand: env("DEVEL_PR_COMMAND") || f?.comando_pr || 'gh pr create --base {base} --head {branch} --title "{key}: {title}" --body-file {body}',
    // "jira" is the name used by earlier versions for "ticket"
    codeReviewGate: ["ticket", "jira"].includes(env("CODE_REVIEW_GATE") || f?.code_review.gate || "github") ? "ticket" : "github",
    githubReviewers: list("GITHUB_REVIEWERS", f?.code_review.revisores),
    openspecCmd: env("OPENSPEC_CMD") && env("OPENSPEC_CMD") !== "openspec" ? env("OPENSPEC_CMD") : existsSync(localOpenSpec) ? localOpenSpec : "openspec",
    stateDir: envL("ORQEN_STATE_DIR", "REC_STATE_DIR") || (existsSync(localState) || !project ? localState : join(main, "orqen", "state")),
    stagesDir: stages ?? join(TEMPLATES_DIR, "stages"),
    environment: project?.entornos,
    lockMinutes: Number(envL("ORQEN_LOCK_MIN", "REC_LOCK_MIN") || f?.lock_min || 90),
    // Headless agent command for `orqen cycle`. {prompt} is replaced (already escaped).
    agentCmd: env("AGENT_CMD") || project?.agente.comando || "claude -p --permission-mode acceptEdits",
    intervalSec: Number(envL("ORQEN_INTERVAL_SEC", "REC_INTERVAL_SEC") || f?.intervalo_seg || 120),
    ...over,
  };
}

/** Folder of the worqs: the explicit one, orqen/worqs/, or (earlier versions) orqen/work/ when only that exists. */
export function worqsDirOf(repoPath: string, explicit = ""): { dir: string; legacy: boolean } {
  if (explicit) return { dir: explicit, legacy: false };
  const dir = join(repoPath, "orqen", "worqs"), old = join(repoPath, "orqen", "work");
  return !existsSync(dir) && existsSync(old) ? { dir: old, legacy: true } : { dir, legacy: false };
}

let warnedWork = false;
let warned = false;
/** Warns once when orqen/.env still uses the variables of earlier versions, or the worqs are still in orqen/work/. */
export function warnLegacy(cfg: Config) {
  if (cfg.legacyWorkDir && !warnedWork) {
    warnedWork = true;
    console.error("[orqen] The worqs are now in orqen/worqs/ and this repository still has them in orqen/work/. It keeps working; " +
      "run `orqen update` to move them.");
  }
  const used = cfg.connectors.legacy ?? [];
  if (warned || !used.length) return;
  warned = true;
  console.error(`[orqen] orqen/.env uses variables of an earlier version (${used.join(", ")}). They still work; ` +
    `run \`orqen update\` to move them to \`connectors\` in orqen/config.yaml (${used.map((k) => `${k} → ${LEGACY_VARS[k]}`).join(", ")}).`);
}
