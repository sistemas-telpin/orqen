/**
 * Configuración del proceso REC para el repo actual:
 *  - `orqen/.env`   credenciales y datos de Jira / SIS / aprobadores (no se commitea)
 *  - `orqen/config.yaml`    rama base, entornos y comandos de tests
 *  - `orqen/state` estado operativo de cada REC (ignorado por git)
 *  - `orqen/stages` guías de cada etapa (si faltan, se usan las del kit)
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { DIR_PLANTILLAS } from "orqen-kit";
import { existeConfig, leerConfig } from "../lib/config.ts";

const env = (k: string, d = "") => process.env[k] ?? d;
const split = (v: string) => v.split(",").map((s) => s.trim()).filter(Boolean);
const kv = (v: string) => Object.fromEntries(split(v).map((p) => p.split("=").map((s) => s.trim())));

export function raizRepo(desde = process.cwd()): string {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: desde, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return resolve(desde);
  }
}

export interface Entorno {
  compose: string;
  variables: Record<string, string>;
  preparar: string[]; migrar: string[]; seed: string[];
  tests: Record<string, string | null | undefined>;
}

export interface Config {
  jiraUrl: string; jiraUser: string; jiraToken: string; jiraDeployment: "cloud" | "server";
  jql: string;
  /** analisis = analistas (también destraban BLOQUEADO junto con codigo). */
  aprobadores: { analisis?: string[]; codigo: string[]; cliente: string[]; ejecucion?: string[] };
  transicionesJira: Record<string, string>;
  /** SIS: issue que se crea en otro proyecto de Jira al cerrar el análisis (todos los carriles). */
  sis: { proyecto: string; tipo: string; link: string; transiciones: Record<string, string>; tipoOperativo: string };
  factoryDir: string;       // registro y estado por REC: orqen/work/<KEY>/ (se commitea con la rama)
  repoPath: string; ramaBase: string;
  /** Comando de tests si no hay entornos en orqen/config.yaml. */
  comandoTests: string; comandoPr: string;
  /** Entornos de orqen/config.yaml: qué levantar y qué tests correr (lo usa el proceso en DESARROLLO y TESTING). */
  entorno?: Entorno;
  openspecCmd: string;
  estadoDir: string; etapasDir: string; lockMinutos: number;
  agenteCmd: string; intervaloSeg: number;
}

/** Binario de OpenSpec: OPENSPEC_CMD, o el instalado como devDependency del repo, o el global. */
function openspecDe(repo: string): string {
  if (process.env.OPENSPEC_CMD && process.env.OPENSPEC_CMD !== "openspec") return process.env.OPENSPEC_CMD;
  const local = join(repo, "node_modules", ".bin", process.platform === "win32" ? "openspec.cmd" : "openspec");
  return existsSync(local) ? local : "openspec";
}

export function cargarConfig(over: Partial<Config> = {}): Config {
  const repoPath = over.repoPath ?? (env("REPO_PATH") || raizRepo());
  const envFile = join(repoPath, "orqen", ".env");
  if (!over.repoPath && existsSync(envFile)) process.loadEnvFile(envFile);
  const orqen = !over.repoPath && existeConfig(repoPath) ? leerConfig(repoPath) : undefined;
  const etapasRepo = join(repoPath, "orqen", "stages");
  const ramaBase = env("RAMA_BASE") || orqen?.proyecto.rama_base || "main";
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
    factoryDir: env("FACTORY_DIR") || join(repoPath, "orqen", "work"),
    repoPath,
    ramaBase,
    comandoTests: env("COMANDO_TESTS", "npm test"),
    comandoPr: env("COMANDO_PR", `gh pr create --base ${ramaBase} --head {rama} --title "{key}: {titulo}" --body-file {cuerpo}`),
    entorno: orqen?.entornos,
    openspecCmd: openspecDe(repoPath),
    estadoDir: env("REC_ESTADO_DIR", join(repoPath, "orqen", "state")),
    etapasDir: existsSync(etapasRepo) ? etapasRepo : join(DIR_PLANTILLAS, "etapas"),
    lockMinutos: Number(env("REC_LOCK_MIN", "90")),
    // Comando headless del agente para `orqen cycle`. El prompt va por stdin, o como argumento si tiene {prompt}.
    agenteCmd: env("AGENTE_CMD") || orqen?.agente.comando || "claude -p --permission-mode acceptEdits",
    intervaloSeg: Number(env("REC_INTERVALO_SEG", "120")),
    ...over,
  };
}
