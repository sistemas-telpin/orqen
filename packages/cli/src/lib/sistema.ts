/** Chequeos del entorno de la máquina y versión / autoactualización de la CLI. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import semver from "semver";
import { ejecutar, version } from "./proc.ts";

export const PAQUETE_CLI = "orqen";
export const VERSION_CLI: string = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8"),
).version;

export interface Chequeo { nombre: string; ok: boolean; detalle: string; requerido: boolean; ayuda?: string }

export function chequearSistema(repo: string): Chequeo[] {
  const node = process.versions.node;
  const git = version("git");
  const esRepo = git ? ejecutar("git", ["rev-parse", "--is-inside-work-tree"], { cwd: repo }).codigo === 0 : false;
  const pnpm = version("pnpm"), npm = version("npm");
  const docker = version("docker");
  const compose = docker ? version("docker", ["compose", "version", "--short"]) : null;
  const daemon = docker ? ejecutar("docker", ["info", "--format", "{{.ServerVersion}}"], { timeoutMs: 15_000 }).codigo === 0 : false;
  return [
    { nombre: "Node.js", ok: semver.gte(node, "20.12.0"), detalle: `v${node}`, requerido: true, ayuda: "Instalá Node ≥ 20.12" },
    { nombre: "git", ok: !!git && esRepo, detalle: git ? (esRepo ? git.replace(/^git version /, "v") : "la carpeta no es un repo git") : "no instalado", requerido: true, ayuda: git ? "Corré `git init` o pasá la ruta del repo" : "Instalá git" },
    { nombre: "pnpm / npm", ok: !!(pnpm || npm), detalle: [pnpm && `pnpm ${pnpm}`, npm && `npm ${npm}`].filter(Boolean).join(" · ") || "no instalado", requerido: true },
    {
      nombre: "Docker", ok: !!docker && !!compose && daemon, requerido: false,
      detalle: !docker ? "no instalado" : !compose ? "falta Docker Compose v2" : daemon ? `${docker.replace(/^Docker version /, "v").split(",")[0]} · compose ${compose}` : "instalado, pero el daemon no responde",
      ayuda: "Sin Docker se genera igual el compose; los agentes no van a poder levantar los servicios hasta instalarlo (Docker Desktop en Windows/macOS).",
    },
  ];
}

/** Última versión publicada de la CLI (null si no hay acceso al registry). */
export function ultimaVersionCli(): string | null {
  const r = ejecutar("npm", ["view", PAQUETE_CLI, "version"], { timeoutMs: 30_000 });
  if (r.codigo !== 0) return null;
  const v = r.stdout.trim();
  return semver.valid(v) ? v : null;
}

/** ¿La CLI se instaló global con pnpm? (por la ruta del paquete). */
export function instaladaConPnpm(): boolean {
  return /[\\/](pnpm|\.pnpm)[\\/]/i.test(fileURLToPath(import.meta.url));
}

export function comandoActualizarCli(): [string, string[]] {
  return instaladaConPnpm() || (version("pnpm") && !version("npm"))
    ? ["pnpm", ["add", "-g", `${PAQUETE_CLI}@latest`]]
    : ["npm", ["install", "-g", `${PAQUETE_CLI}@latest`]];
}

/** Rama por defecto del repo: origin/HEAD, si no la actual, si no "main". */
export function ramaBase(repo: string): string {
  const r = ejecutar("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], { cwd: repo });
  if (r.codigo === 0 && r.stdout.trim()) return r.stdout.trim().replace(/^origin\//, "");
  const a = ejecutar("git", ["branch", "--show-current"], { cwd: repo });
  return a.stdout.trim() || "main";
}
