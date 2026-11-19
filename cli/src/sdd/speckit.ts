/**
 * GitHub Spec Kit: specs/<NNN-feature>/ (spec.md, plan.md, tasks.md, research.md, data-model.md, quickstart.md,
 * contracts/). Here mostly to keep the model honest: a second tool with another layout fits without changing anything else.
 */
import { fileTitle, humanize, mdSection, parseTasks, progressOf, titleOf } from "./common.ts";
import type { SddProvider, SpecSection, SpecSummary } from "./types.ts";

const ROOT = "specs";
const ORDER = ["tasks.md", "spec.md", "plan.md", "research.md", "data-model.md", "quickstart.md"];
const isFeature = (src: Parameters<SddProvider["detect"]>[0], id: string) => src.list(`${ROOT}/${id}`).some((n) => n === "spec.md" || n === "plan.md");

export const speckit: SddProvider = {
  id: "spec-kit",
  label: "Spec Kit",
  detect: (src) => src.list(".specify").length > 0 || src.list(ROOT).some((n) => n.endsWith("/") && isFeature(src, n.slice(0, -1))),
  list(src) {
    return src.list(ROOT).filter((n) => n.endsWith("/") && isFeature(src, n.slice(0, -1))).map((n): SpecSummary => {
      const id = n.slice(0, -1), dir = `${ROOT}/${id}`;
      return { id, title: titleOf(src.read(`${dir}/spec.md`), ["Feature Specification"]) ?? humanize(id), status: "active", progress: progressOf(parseTasks(src.read(`${dir}/tasks.md`) ?? "")), updated: src.modified(dir) };
    }).sort((a, b) => (b.updated ?? "").localeCompare(a.updated ?? ""));
  },
  read(src, id) {
    if (!isFeature(src, id)) return undefined;
    const dir = `${ROOT}/${id}`;
    const names = src.list(dir).filter((n) => n.toLowerCase().endsWith(".md"));
    names.sort((a, b) => (ORDER.indexOf(a) < 0 ? 99 : ORDER.indexOf(a)) - (ORDER.indexOf(b) < 0 ? 99 : ORDER.indexOf(b)) || a.localeCompare(b));
    const sections: SpecSection[] = [];
    let groups = parseTasks("");
    for (const n of names) {
      const md = src.read(`${dir}/${n}`);
      if (md === undefined) continue;
      if (n === "tasks.md") { groups = parseTasks(md); sections.push({ id: "tasks", title: "Tasks", kind: "tasks", groups, file: `${dir}/${n}` }); }
      else sections.push(mdSection(n.replace(/\.md$/i, "").toLowerCase(), n === "spec.md" ? "Spec" : fileTitle(n), md, `${dir}/${n}`));
    }
    const contracts = src.list(`${dir}/contracts`).filter((n) => !n.endsWith("/"));
    if (contracts.length) sections.push({ id: "contracts", title: "Contracts", kind: "specs", specs: contracts.map((n) => ({ name: n, markdown: "```\n" + (src.read(`${dir}/contracts/${n}`) ?? "") + "\n```" })) });
    return {
      provider: "spec-kit", providerLabel: "Spec Kit", id, title: titleOf(src.read(`${dir}/spec.md`), ["Feature Specification"]) ?? humanize(id),
      status: "active", since: src.created(dir), updated: src.modified(dir), progress: progressOf(groups), sections, source: src.label,
    };
  },
};
