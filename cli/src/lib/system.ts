/** System prerequisites, CLI version, and update commands. */
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
    { nombre: "Node.js", ok: semver.gte(node, "20.12.0"), detalle: `v${node}`, requerido: true, ayuda: "Install Node 20.12 or later" },
    { nombre: "git", ok: !!git && esRepo, detalle: git ? (esRepo ? git.replace(/^git version /, "v") : "directory is not a Git repository") : "not installed", requerido: true, ayuda: git ? "Run `git init` or pass a repository path" : "Install Git" },
    { nombre: "pnpm / npm", ok: !!(pnpm || npm), detalle: [pnpm && `pnpm ${pnpm}`, npm && `npm ${npm}`].filter(Boolean).join(" · ") || "not installed", requerido: true },
    {
      nombre: "Docker", ok: !!docker && !!compose && daemon, requerido: false,
      detalle: !docker ? "not installed" : !compose ? "Docker Compose v2 is missing" : daemon ? `${docker.replace(/^Docker version /, "v").split(",")[0]} · compose ${compose}` : "installed, but the daemon is unavailable",
      ayuda: "Compose configuration can be generated now. Install Docker to start services (Docker Desktop on Windows or macOS).",
    },
  ];
}

/** Latest published CLI version, or null if the registry is unavailable. */
export function ultimaVersionCli(): string | null {
  const r = ejecutar("npm", ["view", PAQUETE_CLI, "version"], { timeoutMs: 30_000 });
  if (r.codigo !== 0) return null;
  const v = r.stdout.trim();
  return semver.valid(v) ? v : null;
}

/** Determine from the package path whether pnpm installed the CLI globally. */
export function instaladaConPnpm(): boolean {
  return /[\\/](pnpm|\.pnpm)[\\/]/i.test(fileURLToPath(import.meta.url));
}

export function comandoActualizarCli(): [string, string[]] {
  return instaladaConPnpm() || (version("pnpm") && !version("npm"))
    ? ["pnpm", ["add", "-g", `${PAQUETE_CLI}@latest`]]
    : ["npm", ["install", "-g", `${PAQUETE_CLI}@latest`]];
}

/** Use origin/HEAD, the current branch, or main as the base branch. */
export function ramaBase(repo: string): string {
  const r = ejecutar("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], { cwd: repo });
  if (r.codigo === 0 && r.stdout.trim()) return r.stdout.trim().replace(/^origin\//, "");
  const a = ejecutar("git", ["branch", "--show-current"], { cwd: repo });
  return a.stdout.trim() || "main";
}
