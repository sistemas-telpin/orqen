import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { ejecutar, ejecutarAsync } from "./proc.ts";
import { p, textoValidado } from "../ui/console.ts";
import { listarTools, TOOLS_DIR } from "./tools.ts";

/** Only GitHub repository references; never credentials, local paths or Git options. */
export function repositorioTools(value: string): { id: string; url: string } {
  const input = value.trim();
  const ssh = input.startsWith("git@github.com:") || input.startsWith("ssh://git@github.com/");
  const path = input.replace(/^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/|@)/, "").replace(/\/$/, "").replace(/\.git$/, "");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*\/[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(path)) {
    throw new Error("Use @owner/repo, owner/repo, https://github.com/owner/repo or git@github.com:owner/repo.git (without credentials).");
  }
  return { id: path.toLowerCase(), url: ssh ? `git@github.com:${path}.git` : `https://github.com/${path}.git` };
}

/** Reuse a personal clone, or obtain it using the caller's Git credentials. */
export async function prepararTools(repo: string | undefined, yes: boolean, dir = TOOLS_DIR): Promise<void> {
  repo ??= process.env.ORQEN_TOOLS_REPO;
  const existente = existsSync(dir);
  if (existente) {
    if (!existsSync(join(dir, ".git"))) throw new Error(`${dir} is not a Git clone. Move this folder aside before configuring --tools-repo.`);
    const remote = ejecutar("git", ["config", "--get", "remote.origin.url"], { cwd: dir, timeoutMs: 10_000 });
    const actual = remote.codigo === 0 ? repositorioTools(remote.stdout.trim()) : undefined;
    if (!actual) throw new Error(`The catalog at ${dir} has no GitHub origin.`);
    if (repo && actual.id !== repositorioTools(repo).id) throw new Error(`The catalog at ${dir} belongs to ${actual.id}. Move it aside before selecting another repository.`);
    if (!listarTools(dir).length) throw new Error(`No stacks (tool.yaml) found in ${dir}.`);
    return;
  }
  if (!repo && !yes) repo = await textoValidado("GitHub repository for your stacks (requires access)", "", (v) => {
    try { repositorioTools(v); return undefined; } catch (e) { return (e as Error).message; }
  }, "@company/tools");
  if (!repo) throw new Error("A GitHub stack repository is required. Pass --tools-repo @owner/repo or set ORQEN_TOOLS_REPO (also required with --yes on first use).");
  const origen = repositorioTools(repo);
  mkdirSync(dirname(dir), { recursive: true });
  const temporal = mkdtempSync(join(dirname(dir), ".tools-clone-"));
  try {
    p.log.step(`Cloning ${origen.id} into ${dir} using your Git credentials...`);
    const r = await ejecutarAsync("git", ["clone", "--depth", "1", "--", origen.url, temporal], { timeoutMs: 120_000 });
    if (r.codigo !== 0) throw new Error(`Could not clone ${origen.id}. Check your Git credentials and repository access. ${r.stderr.trim().slice(-1200)}`);
    if (!listarTools(temporal).length) throw new Error("The repository must contain <stack>/tool.yaml at its root.");
    renameSync(temporal, dir);
  } finally {
    rmSync(temporal, { recursive: true, force: true });
  }
}
