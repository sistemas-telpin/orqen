/** System prerequisites, CLI version, and update commands. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import semver from "semver";
import { ejecutar, version } from "./proc.ts";

const { name, version: cliVersion } = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8"),
) as { name: string; version: string };
export const PAQUETE_CLI = name;
export const VERSION_CLI = cliVersion;

export interface Chequeo { nombre: string; ok: boolean; detalle: string; requerido: boolean; ayuda?: string }

export function chequearSistema(repo: string): Chequeo[] {
  const node = process.versions.node;
  const git = version("git");
  const esRepo = git ? ejecutar("git", ["rev-parse", "--is-inside-work-tree"], { cwd: repo }).codigo === 0 : false;
  const pnpm = version("pnpm"), npm = version("npm");
  return [
    { nombre: "Node.js", ok: semver.gte(node, "20.12.0"), detalle: `v${node}`, requerido: true, ayuda: "Install Node 20.12 or later" },
    { nombre: "git", ok: !!git && esRepo, detalle: git ? (esRepo ? git.replace(/^git version /, "v") : "directory is not a Git repository") : "not installed", requerido: true, ayuda: git ? "Run `git init` or pass a repository path" : "Install Git" },
    { nombre: "pnpm / npm", ok: !!(pnpm || npm), detalle: [pnpm && `pnpm ${pnpm}`, npm && `npm ${npm}`].filter(Boolean).join(" · ") || "not installed", requerido: true },
  ];
}

/** Latest stable version of a package, or null if the registry is unavailable. */
export function ultimaVersionPaquete(gestor: string, paquete: string): string | null {
  const r = ejecutar(gestor, ["view", `${paquete}@latest`, "version"], { timeoutMs: 30_000 });
  if (r.codigo !== 0) return null;
  const v = r.stdout.trim();
  return semver.valid(v) ? v : null;
}

/** Determine from the package path whether pnpm installed the CLI globally. */
export function instaladaConPnpm(): boolean {
  return /[\\/](pnpm|\.pnpm)[\\/]/i.test(fileURLToPath(import.meta.url));
}

export function gestorCli(): "pnpm" | "npm" {
  return instaladaConPnpm() || (!version("npm") && !!version("pnpm")) ? "pnpm" : "npm";
}

/** Use origin/HEAD, the current branch, or main as the base branch. */
export function ramaBase(repo: string): string {
  const r = ejecutar("git", ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], { cwd: repo });
  if (r.codigo === 0 && r.stdout.trim()) return r.stdout.trim().replace(/^origin\//, "");
  const a = ejecutar("git", ["branch", "--show-current"], { cwd: repo });
  return a.stdout.trim() || "main";
}
