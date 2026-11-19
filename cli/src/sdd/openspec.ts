/** OpenSpec: openspec/changes/<id>/ (proposal, design, tasks, specs/<capability>/spec.md and any other .md). */
import { fileTitle, humanize, mdSection, parseTasks, progressOf, titleOf } from "./common.ts";
import type { SddProvider, Source, SpecSection, SpecSummary, SpecView } from "./types.ts";

const CHANGES = "openspec/changes";
const ARCHIVE = `${CHANGES}/archive`;
const KNOWN = ["proposal.md", "design.md", "tasks.md"];

/** Folder of a change: active, or archived as <date>-<id>. */
function locate(src: Source, id: string): { dir: string; archived: boolean } | undefined {
  if (src.list(`${CHANGES}/${id}`).length) return { dir: `${CHANGES}/${id}`, archived: false };
  const a = src.list(ARCHIVE).map((n) => n.replace(/\/$/, "")).find((n) => n === id || n.replace(/^\d{4}-\d{2}-\d{2}-/, "") === id);
  return a ? { dir: `${ARCHIVE}/${a}`, archived: true } : undefined;
}

/** specs/**\/spec.md of the change: one per capability. */
function specsOf(src: Source, dir: string): Array<{ name: string; markdown: string }> {
  const out: Array<{ name: string; markdown: string }> = [];
  const walk = (d: string, rel: string) => {
    for (const n of src.list(d)) {
      if (n.endsWith("/")) walk(`${d}/${n.slice(0, -1)}`, rel ? `${rel}/${n.slice(0, -1)}` : n.slice(0, -1));
      else if (n === "spec.md") { const md = src.read(`${d}/${n}`); if (md !== undefined) out.push({ name: rel || "spec", markdown: md }); }
    }
  };
  walk(`${dir}/specs`, "");
  return out;
}

export const openspec: SddProvider = {
  id: "openspec",
  label: "OpenSpec",
  detect: (src) => src.list("openspec").length > 0,
  list(src) {
    const rows: SpecSummary[] = [];
    for (const n of src.list(CHANGES).filter((x) => x.endsWith("/") && x !== "archive/")) {
      const id = n.slice(0, -1), dir = `${CHANGES}/${id}`;
      rows.push({ id, title: titleOf(src.read(`${dir}/proposal.md`), ["Proposal", "Why"]) ?? humanize(id), status: "active", progress: progressOf(parseTasks(src.read(`${dir}/tasks.md`) ?? "")), updated: src.modified(dir) });
    }
    for (const n of src.list(ARCHIVE).filter((x) => x.endsWith("/"))) {
      const full = n.slice(0, -1), id = full.replace(/^\d{4}-\d{2}-\d{2}-/, "");
      rows.push({ id, title: humanize(id), status: "archived", updated: full.slice(0, 10) });
    }
    return rows.sort((a, b) => (a.status === b.status ? (b.updated ?? "").localeCompare(a.updated ?? "") : a.status === "active" ? -1 : 1));
  },
  read(src, id) {
    const at = locate(src, id);
    if (!at) return undefined;
    const { dir } = at;
    const proposal = src.read(`${dir}/proposal.md`), design = src.read(`${dir}/design.md`), tasks = src.read(`${dir}/tasks.md`);
    const groups = parseTasks(tasks ?? "");
    const specs = specsOf(src, dir);
    const sections: SpecSection[] = [];
    if (tasks !== undefined) sections.push({ id: "tasks", title: "Tasks", kind: "tasks", groups, file: `${dir}/tasks.md` });
    if (specs.length) sections.push({ id: "specs", title: "Specs", kind: "specs", specs });
    if (proposal !== undefined) sections.push(mdSection("proposal", "Proposal", proposal, `${dir}/proposal.md`));
    if (design !== undefined) sections.push(mdSection("design", "Design", design, `${dir}/design.md`));
    // anything else the team writes in the change (verification.md, notes.md…) becomes a tab too
    for (const n of src.list(dir).filter((x) => x.toLowerCase().endsWith(".md") && !KNOWN.includes(x))) {
      const md = src.read(`${dir}/${n}`);
      if (md !== undefined) sections.push(mdSection(n.replace(/\.md$/i, "").toLowerCase(), fileTitle(n), md, `${dir}/${n}`));
    }
    const view: SpecView = {
      provider: "openspec", providerLabel: "OpenSpec", id, title: titleOf(proposal, ["Proposal", "Why"]) ?? humanize(id),
      status: at.archived ? "archived" : "active", since: src.created(dir), updated: src.modified(dir),
      progress: progressOf(groups), sections, source: src.label,
    };
    return view;
  },
};
