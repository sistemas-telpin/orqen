/** What every SDD provider shares: reading sources (folder or git branch) and parsing markdown task lists. */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Source, SpecSection, SpecTask, TaskGroup } from "./types.ts";

const day = (d: Date) => d.toISOString().slice(0, 10);

function git(cwd: string, args: string[]): string | undefined {
  try { return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true }); }
  catch { return undefined; }
}

/** Files on disk under `root` (the project or a request's worktree). */
export class DirSource implements Source {
  constructor(readonly root: string, readonly label = root) {}
  list(dir: string) {
    const p = join(this.root, dir);
    if (!existsSync(p) || !statSync(p).isDirectory()) return [];
    return readdirSync(p, { withFileTypes: true }).map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).sort();
  }
  read(path: string) {
    const p = join(this.root, path);
    return existsSync(p) && statSync(p).isFile() ? readFileSync(p, "utf8").replace(/\r\n/g, "\n") : undefined;
  }
  modified(path: string) {
    const p = join(this.root, path);
    if (!existsSync(p)) return undefined;
    let last = statSync(p).mtime;
    if (statSync(p).isDirectory()) {
      const walk = (d: string) => { for (const e of readdirSync(d, { withFileTypes: true })) { const q = join(d, e.name); if (e.isDirectory()) walk(q); else { const m = statSync(q).mtime; if (m > last) last = m; } } };
      walk(p);
    }
    return day(last);
  }
  created(path: string) {
    const added = git(this.root, ["log", "--diff-filter=A", "--format=%cs", "--", path])?.trim().split("\n").filter(Boolean).pop();
    if (added) return added;
    const p = join(this.root, path);
    return existsSync(p) ? day(statSync(p).birthtime.getTime() ? statSync(p).birthtime : statSync(p).mtime) : undefined;
  }
}

/** Files of a branch, read with git (the request's branch when its worktree is not on this machine). */
export class GitSource implements Source {
  constructor(readonly repo: string, readonly ref: string) {}
  get label() { return `branch ${this.ref}`; }
  list(dir: string) {
    const out = git(this.repo, ["ls-tree", "--name-only", `${this.ref}:${dir}`]);
    if (out === undefined) return [];
    const kinds = git(this.repo, ["ls-tree", `${this.ref}:${dir}`]) ?? "";
    const trees = new Set(kinds.split("\n").filter((l) => / tree /.test(l)).map((l) => l.split("\t")[1]));
    return out.split("\n").filter(Boolean).map((n) => (trees.has(n) ? `${n}/` : n)).sort();
  }
  read(path: string) { return git(this.repo, ["show", `${this.ref}:${path}`])?.replace(/\r\n/g, "\n"); }
  modified(path: string) { return git(this.repo, ["log", "-1", "--format=%cs", this.ref, "--", path])?.trim() || undefined; }
  created(path: string) { return git(this.repo, ["log", "--diff-filter=A", "--format=%cs", this.ref, "--", path])?.trim().split("\n").filter(Boolean).pop(); }
}

/**
 * Checkbox tasks of a markdown plan (`- [ ]` / `- [x]`, also `* [X]`), grouped by the heading above them. Works for
 * OpenSpec's tasks.md, spec-kit's tasks.md and any plan written the same way.
 */
export function parseTasks(md: string): TaskGroup[] {
  const groups: TaskGroup[] = [];
  let cur: TaskGroup | undefined;
  for (const line of md.split("\n")) {
    const h = line.match(/^#{1,6}\s+(.+?)\s*$/);
    if (h) { cur = { title: h[1].replace(/\*\*/g, "").trim(), items: [] }; groups.push(cur); continue; }
    const t = line.match(/^\s*[-*+]\s+\[([ xX])\]\s+(.+?)\s*$/);
    if (t) {
      if (!cur) { cur = { title: "", items: [] }; groups.push(cur); }
      cur.items.push({ text: t[2].replace(/\*\*/g, "").trim(), done: t[1] !== " " });
    }
  }
  return groups.filter((g) => g.items.length);
}

export function progressOf(groups: TaskGroup[]) {
  const all: SpecTask[] = groups.flatMap((g) => g.items);
  return all.length ? { done: all.filter((t) => t.done).length, total: all.length } : undefined;
}

/** "ov-buscar-cliente-documento" → "ov buscar cliente documento" (the change id is a fine title). */
export const humanize = (id: string) => id.replace(/^\d{3,}-/, "").replace(/[-_]+/g, " ").trim();

/** The first `# heading` of a markdown, when it is not a generic one ("Proposal", "Spec"…). */
export function titleOf(md: string | undefined, generic: string[]): string | undefined {
  const h = md?.match(/^#\s+(.+?)\s*$/m)?.[1]?.replace(/^(Change|Feature)( Specification)?:\s*/i, "").trim();
  return h && !generic.some((g) => h.toLowerCase() === g.toLowerCase()) ? h : undefined;
}

/** A markdown file as a tab. */
export const mdSection = (id: string, title: string, markdown: string, file?: string): SpecSection => ({ id, title, kind: "markdown", markdown, file });

/** "verification.md" → "Verification", "data-model.md" → "Data model". */
export const fileTitle = (name: string) => { const b = name.replace(/\.md$/i, "").replace(/[-_]+/g, " "); return b.charAt(0).toUpperCase() + b.slice(1); };
