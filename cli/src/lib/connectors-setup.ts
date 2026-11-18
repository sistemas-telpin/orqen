/**
 * `orqen connectors setup`: asks where the requests and the optional
 * issues live. Returns resource configuration and shared provider credentials.
 */
import { execFileSync } from "node:child_process";
import type { ConectorYaml, ConectoresYaml } from "../connectors/config.ts";
import { confirmar, elegir, gris, secreto, texto, textoValidado } from "../ui/console.ts";

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
        return { tipo: "jira", ...(credenciales ? { credenciales } : {}), filtro, ...(b?.transiciones ? { transiciones: b.transiciones } : {}) };
      }
      const proyecto = (await texto("Jira project key where the team's issues are created", String(b?.proyecto ?? ""), false, "DEV")).toUpperCase();
      return { tipo: "jira", ...(credenciales ? { credenciales } : {}), proyecto, tipo_ticket: b?.tipo_ticket ?? "Task", vinculo: b?.vinculo ?? "Relates", ...(b?.transiciones ? { transiciones: b.transiciones } : {}) };
    }
    if (kind === "github") {
      const b = same("github");
      const repoGh = await textoValidado("GitHub repository (owner/name)", b?.repo ?? originRepo(repo),
        (x) => (/^[\w.-]+\/[\w.-]+$/.test(x) ? undefined : "Use owner/name, e.g. my-org/my-repo"), "my-org/my-repo");
      const proj = await texto(`GitHub Project number ${gris("(empty: issues only)")}`, b?.proyecto ? String(b.proyecto) : "", false);
      const token = await secreto(`GitHub token ${gris(previo("GITHUB_TOKEN") ? "(Enter to keep it)" : "(Enter to use your `gh` session)")}`);
      if (token) out.GITHUB_TOKEN = token;
      return {
        tipo: "github", repo: repoGh, ...(proj ? { proyecto: Number(proj), campo: b?.campo ?? "Status", ...(b?.estado ? { estado: b.estado } : {}) } : {}),
        ...(role === "requests" ? { filtro: b?.filtro ?? "is:open label:orqen" } : { etiquetas: b?.etiquetas ?? ["orqen"] }),
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
