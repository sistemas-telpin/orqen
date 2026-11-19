/**
 * `orqen spec`: the spec of a request (or of a change), whatever SDD tool the project uses, as the neutral model of
 * src/sdd. The desktop app's Spec panel reads `orqen spec <KEY> --json --dir <worktree>`.
 */
import { existsSync } from "node:fs";
import { leerConfig, existeConfig } from "../lib/config.ts";
import { DirSource, GitSource, providerFor, type SpecView, type Source, type TaskGroup } from "../sdd/index.ts";
import { loadConfig } from "../workflow/config.ts";
import { Store, type WorkItem } from "../workflow/store.ts";

export const SPEC_HELP = `  spec [KEY|change] [--json] [--dir <folder>]   The spec of a request or change (any SDD tool: OpenSpec, Spec Kit…); no argument: the list`;

const AFTER_DEVELOPMENT = ["TESTING", "QA_REVIEW", "CODE_REVIEW", "DELIVERY", "ACCEPTANCE", "CLOSED", "EXECUTION", "EXECUTION_APPROVAL", "APPLICATION", "VERIFICATION"];

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return undefined;
  return args.splice(i, 2)[1];
}

/** A request without a spec (direct lane, or analysis not closed): what its analysis left, in the same shape. */
export function analysisView(item: WorkItem): SpecView | undefined {
  const a = item.artifacts?.ANALYSIS;
  if (!a) return undefined;
  const done = AFTER_DEVELOPMENT.includes(item.state);
  const groups: TaskGroup[] = a.plan?.length ? [{ title: "Plan", items: a.plan.map((t: string) => ({ text: t, done })) }] : [];
  const bullets = (xs: string[] = []) => xs.map((x) => `- ${x}`).join("\n");
  const analysis = [
    `## Summary\n\n${a.summary}`,
    a.acceptance_criteria?.length ? `## Acceptance criteria\n\n${bullets(a.acceptance_criteria)}` : "",
    a.decisions?.length ? `## Decisions\n\n${a.decisions.map((d: { question: string; answer: string }) => `- **${d.question}** ${d.answer}`).join("\n")}` : "",
    a.open_questions?.length ? `## Open questions\n\n${bullets(a.open_questions)}` : "",
    a.risks?.length ? `## Risks\n\n${bullets(a.risks)}` : "",
    a.lane ? `## Lane\n\n${a.lane}${a.lane_rationale ? ` — ${a.lane_rationale}` : ""}` : "",
  ].filter(Boolean).join("\n\n");
  return {
    provider: "orqen", providerLabel: "orqen", id: item.key, key: item.key, title: item.title || a.summary?.slice(0, 80) || item.key,
    status: "none", sections: [
      ...(groups.length ? [{ id: "tasks", title: "Tasks", kind: "tasks" as const, groups }] : []),
      { id: "analysis", title: "Analysis", kind: "markdown" as const, markdown: analysis },
    ],
    progress: groups.length ? { done: done ? groups[0].items.length : 0, total: groups[0].items.length } : undefined,
    source: "orqen analysis",
    note: item.lane === "direct" ? "Direct lane: no spec; this is the analysis plan." : "No spec yet: this is what the analysis has so far.",
  };
}

export async function specCommand(args: string[]) {
  const a = [...args];
  const json = a.includes("--json"); if (json) a.splice(a.indexOf("--json"), 1);
  const dir = flag(a, "dir");
  const cfg = loadConfig();
  const repo = cfg.repoPath;
  const chosen = existeConfig(repo) ? leerConfig(repo).sdd?.proveedor : undefined;
  const local: Source[] = [...(dir && existsSync(dir) ? [new DirSource(dir)] : []), new DirSource(repo)];
  const provider = providerFor(local[0], chosen);
  const target = a.find((x) => !x.startsWith("--"));
  const out = (v: unknown, text: () => string) => console.log(json ? JSON.stringify(v, null, 2) : text());

  if (!target) {
    const changes = provider.list(local[0]);
    return out({ provider: provider.id, providerLabel: provider.label, changes }, () =>
      changes.length ? changes.map((c) => `${c.status === "active" ? "●" : "○"} ${c.id}${c.progress ? `  ${c.progress.done}/${c.progress.total}` : ""}  ${c.title}`).join("\n") : `No ${provider.label} changes.`);
  }

  const store = new Store(cfg.stateDir);
  const up = target.toUpperCase();
  const item = store.get(target) ?? store.all().find((r) => r.key.toUpperCase() === up || r.issue?.toUpperCase() === up);
  let view: SpecView | undefined, reason: string | undefined;
  if (item?.change) {
    const sources: Source[] = [...local];
    if (item.branch) sources.push(new GitSource(repo, item.branch), new GitSource(repo, `origin/${item.branch}`));
    for (const s of sources) { view = provider.read(s, item.change); if (view) break; }
    if (view) view.key = item.key;
    else reason = `The change ${item.change} of ${item.key} is not in the worktree, the project or the branch ${item.branch || "(none)"}.`;
  } else if (item) {
    view = analysisView(item);
    if (!view) reason = `${item.key} has no spec yet (state ${item.state}).`;
  } else {
    for (const s of local) { view = provider.read(s, target); if (view) break; }
    if (!view) reason = `No request or ${provider.label} change "${target}".`;
  }
  out({ spec: view ?? null, reason }, () => {
    if (!view) return reason ?? "";
    const p = view.progress ? ` · ${view.progress.done}/${view.progress.total} tasks` : "";
    return [`${view.title}  (${view.providerLabel} · ${view.status}${p})`, view.note ?? "", ...view.sections.map((s) => `  - ${s.title}`)].filter(Boolean).join("\n");
  });
}
