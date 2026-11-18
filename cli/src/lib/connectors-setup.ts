/**
 * `orqen init` / `orqen connectors setup`: asks where the external ticket (what the client sees) and the optional
 * internal ticket (the team's) live. Returns the `conectores` block for config.yaml and the secrets for orqen/.env.
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

/** Secrets that each connector needs and are still missing in orqen/.env. */
export function missingSecrets(c: ConectoresYaml | null | undefined, env: Record<string, string | undefined>): string[] {
  const out = new Set<string>();
  for (const x of [c?.externo, c?.interno]) {
    if (!x) continue;
    const p = x.credenciales || (x.tipo === "jira" ? "JIRA" : x.tipo === "github" ? "GITHUB" : "ASANA");
    const need = x.tipo === "jira" ? [...(x.url ? [] : [`${p}_URL`]), `${p}_USER`, `${p}_TOKEN`] : x.tipo === "github" ? [] : [`${p}_TOKEN`];
    for (const k of need) if (!env[k] || /your-company|tu-empresa/.test(env[k]!)) out.add(k);
  }
  return [...out];
}

export async function askConnectors(repo: string, prev: ConectoresYaml | null | undefined, env: Record<string, string>): Promise<ConnectorsAnswer> {
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

  async function ask(role: "externo" | "interno", kind: Kind, before?: ConectorYaml | null, other?: ConectorYaml): Promise<ConectorYaml> {
    const same = (k: Kind) => before?.tipo === k ? before : undefined;
    if (kind === "jira") {
      const b = same("jira");
      let credenciales = b?.credenciales ?? undefined;
      if (role === "interno" && other?.tipo === "jira") {
        if (!(await confirmar("Same Jira and account as requirements?", true, false))) credenciales = "JIRA_INTERNAL";
      } else if (role === "interno") credenciales = undefined;
      const p = credenciales || "JIRA";
      if (role === "externo" || credenciales) await jiraCredentials(p);
      if (role === "externo") {
        const key = (await texto("Jira project key where the client's requests arrive", String(b?.proyecto ?? ""), false, "SOP")).toUpperCase();
        const filtro = await texto(`Which requests does orqen handle? ${gris("(JQL)")}`,
          b?.filtro ?? `${key ? `project = ${key} AND ` : ""}labels = orqen AND statusCategory != Done`, false);
        return { tipo: "jira", ...(credenciales ? { credenciales } : {}), filtro, ...(b?.transiciones ? { transiciones: b.transiciones } : {}) };
      }
      const proyecto = (await texto("Jira project key where the team's tickets are created", String(b?.proyecto ?? ""), false, "DEV")).toUpperCase();
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
        tipo: "github", repo: repoGh, ...(proj ? { proyecto: Number(proj), campo: b?.campo ?? "Status" } : {}),
        ...(role === "externo" ? { filtro: b?.filtro ?? "is:open label:orqen" } : { etiquetas: b?.etiquetas ?? ["orqen"] }),
        ...(b?.transiciones ? { transiciones: b.transiciones } : {}),
      };
    }
    const b = same("asana");
    const proyecto = await textoValidado("Asana project id (the number in the project URL)", b?.proyecto ? String(b.proyecto) : "",
      (x) => (/^\d+$/.test(x) ? undefined : "Use the numeric id, e.g. 1204567890123456"));
    const token = await secreto(`Asana personal access token ${gris(previo("ASANA_TOKEN") ? "(Enter to keep it)" : "(Enter to skip)")}`);
    if (token) out.ASANA_TOKEN = token;
    return { tipo: "asana", proyecto, ...(role === "externo" ? { filtro: b?.filtro ?? "orqen" } : {}), ...(b?.transiciones ? { transiciones: b.transiciones } : {}) };
  }

  const extKind = await elegir("Where do customer requirements arrive?", TOOLS, prev?.externo.tipo ?? "jira", false);
  const externo = await ask("externo", extKind, prev?.externo);
  const intKind = await elegir("Where does the team track development tickets?", [
    { value: "none" as const, label: "Nowhere else", hint: "work directly on requirements" }, ...TOOLS,
  ], prev?.interno?.tipo ?? "none", false);
  const interno = intKind === "none" ? undefined : await ask("interno", intKind, prev?.interno, externo);
  return { conectores: { externo, ...(interno ? { interno } : {}) }, env: out };
}
