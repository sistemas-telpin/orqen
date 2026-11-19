/**
 * Connector settings: `conectores` in orqen/config.yaml (what and where) + shared provider credentials in ~/.orqen/credentials.env.
 *
 *   conectores:
 *     requests:                    # where the client's requests arrive (what the client sees)
 *       tipo: jira                 # jira | github | asana
 *       filtro: project = SOP AND labels = orqen AND statusCategory != Done
 *     issues:                      # optional: the team's issues, one created per request when the analysis closes
 *       tipo: github
 *       repo: my-org/my-repo
 *       proyecto: 7                # GitHub Projects number (optional)
 *
 * `externo`/`interno` (earlier names of requests/issues) are still accepted.
 * Without `conectores`, the variables used by earlier versions of orqen/.env are still read (see legacy.ts).
 */
import { z } from "zod";

export const KINDS = ["jira", "github", "asana"] as const;

/** One connector with its internal key names (config.yaml uses English keys: see lib/config-keys.ts). */
export const ConectorYaml = z.object({
  tipo: z.enum(KINDS),
  /** Prefix of the shared provider credential variables (default JIRA / GITHUB / ASANA). */
  credenciales: z.string().nullish(),
  /** Jira: base URL (can also come from <CREDENCIALES>_URL). */
  url: z.string().nullish(),
  /** Which tickets orqen handles: JQL (Jira), GitHub search qualifiers, or an Asana tag. */
  filtro: z.string().nullish(),
  /** GitHub Project status whose issues are shown in Pending. Separate from issue search qualifiers. */
  estado: z.string().nullish(),
  /** Jira: project key where the issue is created. GitHub: Projects (v2) number. Asana: project gid. */
  proyecto: z.union([z.string(), z.number()]).nullish(),
  /** Jira: issue types for the issue and the link type between both. */
  tipo_ticket: z.string().nullish(),
  tipo_operativo: z.string().nullish(),
  vinculo: z.string().nullish(),
  /** GitHub: owner/repo where issues are read and created. */
  repo: z.string().nullish(),
  /** GitHub: owner of the project (org or user; default the repo owner) and the single-select field moved by `transiciones`. */
  duenio_proyecto: z.string().nullish(),
  campo: z.string().nullish(),
  /** GitHub/Asana: labels (GitHub) or tag (Asana) put on created tickets and used by the default filter. */
  etiquetas: z.array(z.string()).nullish(),
  /** Legacy key prefix. New settings use general.prefijos, independently of the provider. */
  prefijo: z.string().nullish(),
  /** orqen state → status / column / section name in the tool. */
  transiciones: z.record(z.string(), z.string()).nullish(),
});
export type ConectorYaml = z.infer<typeof ConectorYaml>;

/** `requests` and `issues`; `externo`/`interno` are the names used by earlier versions. */
export const ConectoresYaml = z.preprocess((v) => {
  if (!v || typeof v !== "object") return v;
  const { externo, interno, ...rest } = v as Record<string, unknown>;
  return { ...rest, requests: rest.requests ?? externo, issues: rest.issues ?? interno };
}, z.object({ requests: ConectorYaml, issues: ConectorYaml.nullish() }));
export type ConectoresYaml = z.infer<typeof ConectoresYaml>;

interface Base { transitions: Record<string, string> }
export interface JiraSettings extends Base {
  kind: "jira"; url: string; user: string; token: string; deployment: "cloud" | "server";
  query: string; project: string; issueType: string; operationalType: string; linkType: string;
  prefix?: string;
}
export interface GithubSettings extends Base {
  kind: "github"; token: string; repo: string; query: string; prefix: string; labels: string[];
  project?: { owner: string; number: number; field: string };
  status?: string;
}
export interface AsanaSettings extends Base {
  kind: "asana"; token: string; project: string; tag: string; prefix: string;
}
export type ConnectorSettings = JiraSettings | GithubSettings | AsanaSettings;
export interface ConnectorsSettings { requests: ConnectorSettings; issues?: ConnectorSettings; legacy?: string[] }

export const DEFAULT_LABEL = "orqen";

type Env = Record<string, string | undefined>;

export function credentialsPrefix(c: Pick<ConectorYaml, "tipo" | "credenciales">): string {
  return c.credenciales || (c.tipo === "jira" ? "JIRA" : c.tipo === "github" ? "GITHUB" : "ASANA");
}

export function connectorSettings(c: ConectorYaml, env: Env, prefix?: string): ConnectorSettings {
  const transitions = { ...(c.transiciones ?? {}) };
  if (c.tipo === "jira") {
    const p = credentialsPrefix(c);
    const project = c.proyecto ? String(c.proyecto) : "";
    return {
      kind: "jira", transitions, ...(prefix ? { prefix: prefix.toUpperCase() } : {}),
      url: c.url || env[`${p}_URL`] || "", user: env[`${p}_USER`] || "", token: env[`${p}_TOKEN`] || "",
      deployment: (env[`${p}_DEPLOYMENT`] || (/atlassian\.net/.test(c.url || env[`${p}_URL`] || "") ? "cloud" : "server")) === "server" ? "server" : "cloud",
      query: c.filtro || (project ? `project = ${project} AND labels = ${DEFAULT_LABEL} AND statusCategory != Done` : `labels = ${DEFAULT_LABEL} AND statusCategory != Done`),
      project, issueType: c.tipo_ticket || "Task", operationalType: c.tipo_operativo || c.tipo_ticket || "Task", linkType: c.vinculo || "Relates",
    };
  }
  if (c.tipo === "github") {
    const p = credentialsPrefix(c);
    const repo = c.repo || "";
    const labels = c.etiquetas?.length ? c.etiquetas : [DEFAULT_LABEL];
    return {
      kind: "github", transitions, repo, labels,
      token: env[`${p}_TOKEN`] || env.GH_TOKEN || "",
      // With a GitHub Project the project itself says which issues are requests: no label is required by default.
      query: c.filtro || (c.estado || c.proyecto ? "is:open" : `is:open ${labels.map((l) => `label:${l}`).join(" ")}`),
      ...(c.estado ? { status: c.estado } : {}),
      prefix: (prefix || c.prefijo || "GH").toUpperCase(),
      project: c.proyecto ? { owner: c.duenio_proyecto || repo.split("/")[0], number: Number(c.proyecto), field: c.campo || "Status" } : undefined,
    };
  }
  const p = credentialsPrefix(c);
  return {
    kind: "asana", transitions,
    token: env[`${p}_TOKEN`] || "", project: c.proyecto ? String(c.proyecto) : "",
    tag: c.filtro || c.etiquetas?.[0] || DEFAULT_LABEL, prefix: (prefix || c.prefijo || "AS").toUpperCase(),
  };
}

/** Key of a ticket in GitHub/Asana: <PREFIX>-<number|gid>. */
export const keyOf = (prefix: string, id: string | number) => `${prefix}-${id}`;
export function idOf(prefix: string, key: string): string {
  const m = key.match(/^([A-Za-z][\w]*)-(\d+)$/);
  if (!m || m[1].toUpperCase() !== prefix) throw new Error(`${key} is not a ${prefix}-<number> key`);
  return m[2];
}
