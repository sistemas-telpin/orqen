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

function raizRepo(): string {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: REC_DIR, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return resolve(REC_DIR, "..");
  }
}

export interface Config {
  jiraUrl: string; jiraUser: string; jiraToken: string; jiraDeployment: "cloud" | "server";
  jql: string;
  /** analisis = analistas (también destraban BLOQUEADO junto con codigo). */
  aprobadores: { analisis?: string[]; codigo: string[]; cliente: string[]; ejecucion?: string[] };
  transicionesJira: Record<string, string>;
  /** SIS: issue que se crea en otro proyecto de Jira al cerrar el análisis (todos los carriles). */
  sis: { proyecto: string; tipo: string; link: string; transiciones: Record<string, string>; tipoOperativo: string };
  factoryDir: string;       // registro y estado por REC: factory/<KEY>/ (se commitea con la rama)
  repoPath: string; ramaBase: string; comandoTests: string; comandoPr: string;
  openspecCmd: string;
  estadoDir: string; lockMinutos: number;
  agenteCmd: string; intervaloSeg: number;
}

export function cargarConfig(over: Partial<Config> = {}): Config {
  const repoPath = over.repoPath ?? (env("REPO_PATH") || raizRepo());
  return {
    jiraUrl: env("JIRA_URL"), jiraUser: env("JIRA_USER"), jiraToken: env("JIRA_TOKEN"),
    jiraDeployment: env("JIRA_DEPLOYMENT", "cloud") as "cloud" | "server",
    jql: env("REC_JQL", "project = REC AND labels = rec-agente AND statusCategory != Done"),
    aprobadores: {
      analisis: split(env("APROBADORES_ANALISIS")),
      codigo: split(env("APROBADORES_CODIGO")),
      cliente: split(env("APROBADORES_CLIENTE")),
      ejecucion: split(env("APROBADORES_EJECUCION")),
    },
    transicionesJira: kv(env("TRANSICIONES_JIRA")),
    sis: {
      proyecto: env("SIS_PROYECTO", "SIS"), tipo: env("SIS_TIPO", "Task"), link: env("SIS_LINK", "Relates"),
      transiciones: kv(env("TRANSICIONES_SIS")),
      tipoOperativo: env("SIS_TIPO_OPERATIVO") || env("SIS_TIPO", "Task"),
    },
    factoryDir: env("FACTORY_DIR") || join(repoPath, "factory"),
    repoPath,
    ramaBase: env("RAMA_BASE", "main"),
    comandoTests: env("COMANDO_TESTS", "npm test"),
    comandoPr: env("COMANDO_PR", 'gh pr create --base main --head {rama} --title "{key}: {titulo}" --body-file {cuerpo}'),
    openspecCmd: env("OPENSPEC_CMD", "openspec"),
    estadoDir: env("REC_ESTADO_DIR", join(REC_DIR, ".estado")),
    lockMinutos: Number(env("REC_LOCK_MIN", "90")),
    // Comando headless del agente para `rec ciclo`. {prompt} se reemplaza (ya escapado).
    agenteCmd: env("AGENTE_CMD", "claude -p {prompt} --permission-mode acceptEdits"),
    intervaloSeg: Number(env("REC_INTERVALO_SEG", "120")),
    ...over,
  };
}
