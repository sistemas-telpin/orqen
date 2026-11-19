/**
 * A worq is orqen's unit of work: what orqen carries for each request of the client (the request, its issue, the branch, the spec,
 * the PR and the record of every stage). It is identified by the key of the request and lives in orqen/worqs/<KEY>/.
 * Earlier versions called that folder orqen/work/: `orqen update` moves it.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { ARCHIVO_MANIFEST, leerManifest } from "./kit.ts";

/** Files of a worq (relative to its folder, with forward slashes), sorted. */
export function worqFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p); else out.push(relative(dir, p).replaceAll("\\", "/"));
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}

/**
 * Moves orqen/work/ (earlier versions) to orqen/worqs/ with `git mv` (plain rename when git cannot), and renames its README in the
 * manifest so `orqen update` still sees it as a kit file nobody edited. Does nothing when there is nothing to move or the new
 * folder already exists.
 */
export function moveWorkToWorqs(repo: string): { moved: boolean; detail: string } {
  const old = join(repo, "orqen", "work"), neu = join(repo, "orqen", "worqs");
  if (!existsSync(old)) return { moved: false, detail: "there is no orqen/work/" };
  if (existsSync(neu)) return { moved: false, detail: "orqen/worqs/ already exists: move the contents of orqen/work/ by hand" };
  try { execFileSync("git", ["mv", "orqen/work", "orqen/worqs"], { cwd: repo, stdio: "pipe" }); }
  catch { renameSync(old, neu); }
  const manifest = leerManifest(repo);
  const a = manifest.archivos;
  if (a["orqen/work/README.md"] !== undefined) {
    a["orqen/worqs/README.md"] = a["orqen/work/README.md"];
    delete a["orqen/work/README.md"];
    writeFileSync(join(repo, ARCHIVO_MANIFEST), JSON.stringify(manifest, null, 2) + "\n");
  }
  return { moved: true, detail: "orqen/work/ → orqen/worqs/" };
}

