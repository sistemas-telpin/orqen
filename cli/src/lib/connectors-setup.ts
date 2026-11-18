/**
 * `orqen connectors setup`: asks where the requests and the optional
 * issues live. Returns resource configuration and shared provider credentials.
 */
import { execFileSync } from "node:child_process";
import { connectorSettings, type ConectorYaml, type ConectoresYaml } from "../connectors/config.ts";
import { GithubTracker } from "../connectors/github.ts";
import { checkDraft, type CheckResult, type Draft } from "./connectors-edit.ts";
import { confirmar, elegir, gris, p, pc, secreto, texto, textoValidado } from "../ui/console.ts";

type Kind = ConectorYaml["tipo"];
export interface ConnectorsAnswer { conectores: ConectoresYaml; env: Record<string, string> }

const TOOLS: { value: Kind; label: string; hint: string }[] = [
  { value: "jira", label: "Jira", hint: "Cloud or Server / Data Center" },
  { value: "github", label: "GitHub", hint: "Issues, optionally on a GitHub Project" },
  { value: "asana", label: "Asana", hint: "tasks of a project" },
];

/** owner/name of the origin remote, to propose it. */
function originRepo(repo: string): string {
  try {
    const url = execFileSync("git", ["remote", "get-url", "origin"], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return url.match(/github\.com[:/]([^/]+\/[^/.]+?)(\.git)?$/)?.[1] ?? "";
  } catch { return ""; }
}

/** Provider credentials that are still missing from the effective user settings. */
export function missingSecrets(c: ConectoresYaml | null | undefined, env: Record<string, string | undefined>): string[] {
  const out = new Set<string>();
  for (const x of [c?.requests, c?.issues]) {
    if (!x) continue;
    const p = x.credenciales || (x.tipo === "jira" ? "JIRA" : x.tipo === "github" ? "GITHUB" : "ASANA");
    const need = x.tipo === "jira" ? [...(x.url ? [] : [`${p}_URL`]), `${p}_USER`, `${p}_TOKEN`] : x.tipo === "github" ? [] : [`${p}_TOKEN`];
    for (const k of need) if (!env[k] || /your-company|tu-empresa/.test(env[k]!)) out.add(k);
  }
  return [...out];
}

export async function askConnectors(repo: string, prev: ConectoresYaml | null | undefined, env: Record<string, string | undefined>): Promise<ConnectorsAnswer> {
  const out: Record<string, string> = {};
  const previo = (k: string) => (env[k] && !/your-company|tu-empresa/.test(env[k]) ? env[k] : "");

  async function jiraCredentials(prefix: string) {
    out[`${prefix}_URL`] = (await textoValidado("Jira URL", previo(`${prefix}_URL`),
      (x) => (/^https?:\/\/[^\s/]+\.[^\s]+$/.test(x) ? undefined : "Enter a URL, for example https://your-company.atlassian.net"),
      "https://your-company.atlassian.net")).replace(/\/+$/, "");
    out[`${prefix}_DEPLOYMENT`] = await elegir("Jira Cloud or Server / Data Center?", [
      { value: "cloud", label: "Cloud", hint: "*.atlassian.net" }, { value: "server", label: "Server / Data Center" },
    ], (previo(`${prefix}_DEPLOYMENT`) as "cloud" | "server") || (/atlassian\.net/.test(out[`${prefix}_URL`]) ? "cloud" : "server"), false);
    out[`${prefix}_USER`] = await textoValidado("Jira account that posts comments and creates tickets (bot email)", previo(`${prefix}_USER`),
      (x) => (x ? undefined : "Enter a Jira account"), "bot@your-company.com");
    const token = await secreto(`API token for this account ${gris(previo(`${prefix}_TOKEN`) ? "(Enter to keep the existing token)" : "(Enter to skip)")}`);
    if (token) out[`${prefix}_TOKEN`] = token;
  }

  async function ask(role: "requests" | "issues", kind: Kind, before?: ConectorYaml | null, other?: ConectorYaml): Promise<ConectorYaml> {
    const same = (k: Kind) => before?.tipo === k ? before : undefined;
    if (kind === "jira") {
      const b = same("jira");
      let credenciales = b?.credenciales ?? undefined;
      if (role === "issues" && other?.tipo === "jira") {
        if (!(await confirmar("Same Jira and account as requests?", true, false))) credenciales = "JIRA_INTERNAL";
      } else if (role === "issues") credenciales = undefined;
      const p = credenciales || "JIRA";
      if (role === "requests" || credenciales) await jiraCredentials(p);
      if (role === "requests") {
        const key = (await texto("Jira project key where the client's requests arrive", String(b?.proyecto ?? ""), false, "SOP")).toUpperCase();
        const filtro = await texto(`Which requests does orqen handle? ${gris("(JQL)")}`,
          b?.filtro ?? `${key ? `project = ${key} AND ` : ""}labels = orqen AND statusCategory != Done`, false);
        return { tipo: "jira", ...(credenciales ? { credenciales } : {}), ...(key ? { proyecto: key } : {}), filtro, ...(b?.transiciones ? { transiciones: b.transiciones } : {}) };
      }
      const proyecto = (await texto("Jira project key where the team's issues are created", String(b?.proyecto ?? ""), false, "DEV")).toUpperCase();
      return { tipo: "jira", ...(credenciales ? { credenciales } : {}), proyecto, tipo_ticket: b?.tipo_ticket ?? "Task", vinculo: b?.vinculo ?? "Relates", ...(b?.transiciones ? { transiciones: b.transiciones } : {}) };
    }
    if (kind === "github") {
      const b = same("github");
      const repoGh = await textoValidado("GitHub repository (owner/name)", b?.repo ?? originRepo(repo),
        (x) => (/^[\w.-]+\/[\w.-]+$/.test(x) ? undefined : "Use owner/name, e.g. my-org/my-repo"), "my-org/my-repo");
      const token = await secreto(`GitHub token ${gris(previo("GITHUB_TOKEN") ? "(Enter to keep it)" : "(Enter to use your `gh` session)")}`);
      if (token) out.GITHUB_TOKEN = token;
      const proj = await textoValidado(`GitHub Project number ${gris("(the number in the project URL; empty: issues only)")}`, b?.proyecto ? String(b.proyecto) : "",
        (x) => (!x || /^\d+$/.test(x) ? undefined : "Use the number of the project, e.g. 7 for github.com/orgs/my-org/projects/7"));
      let estado: string | undefined;
      if (proj) {
        // Which column of the project holds the work for orqen; "any" takes every open issue of the project.
        try {
          const settings = connectorSettings({ tipo: "github", repo: repoGh, proyecto: Number(proj), campo: b?.campo ?? "Status" }, { ...env, ...out });
          const columns = settings.kind === "github" ? await new GithubTracker(settings).statuses() : [];
          if (columns.length) {
            const pick = await elegir(role === "requests" ? "Which project column holds the requests for orqen?" : "Which project column holds the issues for orqen?", [
              { value: "__any", label: "Any column", hint: "every open issue of the project" }, ...columns,
            ], b?.estado && columns.some((c) => c.value === b.estado) ? b.estado : "__any", false);
            estado = pick === "__any" ? undefined : pick;
          }
        } catch (e) { p.log.warn(`Could not read the columns of project ${proj}: ${(e as Error).message.slice(0, 200)}`); }
      }
      const defaultFilter = proj ? "is:open" : "is:open label:orqen";
      const filtro = role === "requests"
        ? await texto(`Which issues are requests? ${gris(proj ? "(GitHub search, e.g. label:bug; is:open = all of the project)" : "(GitHub search)")}`,
          b?.filtro && !(proj && b.filtro === "is:open label:orqen") ? b.filtro : defaultFilter, false)
        : undefined;
      return {
        tipo: "github", repo: repoGh, ...(proj ? { proyecto: Number(proj), campo: b?.campo ?? "Status", ...(estado ? { estado } : {}) } : {}),
        ...(role === "requests" ? { filtro: filtro || defaultFilter } : { etiquetas: b?.etiquetas ?? ["orqen"] }),
        ...(b?.transiciones ? { transiciones: b.transiciones } : {}),
      };
    }
    const b = same("asana");
    const proyecto = await textoValidado("Asana project id (the number in the project URL)", b?.proyecto ? String(b.proyecto) : "",
      (x) => (/^\d+$/.test(x) ? undefined : "Use the numeric id, e.g. 1204567890123456"));
    const token = await secreto(`Asana personal access token ${gris(previo("ASANA_TOKEN") ? "(Enter to keep it)" : "(Enter to skip)")}`);
    if (token) out.ASANA_TOKEN = token;
    return { tipo: "asana", proyecto, ...(role === "requests" ? { filtro: b?.filtro ?? "orqen" } : {}), ...(b?.transiciones ? { transiciones: b.transiciones } : {}) };
  }

  const reqKind = await elegir("Requests system: where do customer requests arrive?", TOOLS, prev?.requests.tipo ?? "jira", false);
  const requests = await ask("requests", reqKind, prev?.requests);
  const issKind = await elegir("Issues system: where does the team track development issues?", [
    { value: "none" as const, label: "Nowhere else", hint: "work directly on the requests" }, ...TOOLS,
  ], prev?.issues?.tipo ?? "none", false);
  const issues = issKind === "none" ? undefined : await ask("issues", issKind, prev?.issues, requests);
  return { conectores: { requests, ...(issues ? { issues } : {}) }, env: out };
}

/** One line per connector with the result of checking it against the tool. */
export function checkSummary(result: CheckResult[]): string {
  return result.filter((r) => r.configured).map((r) => {
    const name = r.role === "requests" ? "Requests" : "Issues";
    return `${r.ok ? pc.green("✔") : pc.red("✘")} ${name}: ${r.label ?? r.kind} ${gris(r.detail ?? "")}`;
  }).join("\n");
}

/**
 * `orqen init`: asks for the connectors and checks them against the tool before saving anything.
 * Returns the draft to save, or undefined to keep what the repository already had (or nothing).
 */
export async function setupConnectorsStep(repo: string, prev: ConectoresYaml | null | undefined, env: Record<string, string | undefined>): Promise<Draft | undefined> {
  const now = await elegir("Connectors: where do the requests (and the team's issues) live?", prev
    ? [
      { value: "keep", label: "Keep the current connectors", hint: `${prev.requests.tipo}${prev.issues ? ` + ${prev.issues.tipo}` : ""}` },
      { value: "setup", label: "Configure them again" },
    ]
    : [
      { value: "setup", label: "Configure now", hint: "Jira, GitHub or Asana" },
      { value: "keep", label: "Later", hint: "orqen connectors setup" },
    ], prev ? "keep" : "setup", false);
  if (now === "keep") return undefined;
  let before = prev;
  const typed: Record<string, string> = {};
  for (;;) {
    const answer = await askConnectors(repo, before, { ...env, ...typed });
    Object.assign(typed, answer.env);
    const s = p.spinner();
    s.start("Checking the connectors…");
    let result: CheckResult[];
    try { result = await checkDraft({ conectores: answer.conectores, env: typed }, env); }
    catch (e) { result = [{ role: "requests", configured: true, kind: answer.conectores.requests.tipo, ok: false, detail: (e as Error).message }]; }
    const ok = result.every((r) => !r.configured || r.ok);
    s.stop(ok ? "Connectors checked" : "Some connectors could not be checked");
    p.note(checkSummary(result), "Connectors");
    if (ok) return { conectores: answer.conectores, env: typed };
    const next = await elegir("What do you want to do?", [
      { value: "retry", label: "Fix the values" },
      { value: "save", label: "Save them anyway", hint: "check later with orqen connectors" },
      { value: "skip", label: "Skip connectors for now", hint: "orqen connectors setup" },
    ], "retry", false);
    if (next === "save") return { conectores: answer.conectores, env: typed };
    if (next === "skip") return undefined;
    before = answer.conectores;
  }
}
