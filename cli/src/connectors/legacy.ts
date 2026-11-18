/**
 * Compatibility with the orqen/.env of earlier versions, where the requests were always read from Jira
 * with REC_JQL and the issue was always created in SIS_PROJECT. Used only when config.yaml has no
 * `conectores`. `orqen update` offers to move these values to config.yaml.
 */
import { type ConnectorsSettings, type JiraSettings, DEFAULT_LABEL } from "./config.ts";

type Env = Record<string, string | undefined>;

/** Variables from earlier versions and what replaces them. */
export const LEGACY_VARS: Record<string, string> = {
  REC_JQL: "conectores.requests.filtro",
  JIRA_TRANSITIONS: "conectores.requests.transiciones",
  SIS_PROJECT: "conectores.issues.proyecto",
  SIS_TYPE: "conectores.issues.tipo_ticket",
  SIS_TYPE_OPERATIONAL: "conectores.issues.tipo_operativo",
  SIS_LINK: "conectores.issues.vinculo",
  SIS_TRANSITIONS: "conectores.issues.transiciones",
  REC_AGENT: "ORQEN_AGENT", REC_ANALYST: "ORQEN_ANALYST", REC_SUPPORT: "ORQEN_SUPPORT",
  REC_LOCK_MIN: "ORQEN_LOCK_MIN", REC_STATE_DIR: "ORQEN_STATE_DIR", REC_INTERVAL_SEC: "ORQEN_INTERVAL_SEC",
};

const split = (v: string) => v.split(",").map((s) => s.trim()).filter(Boolean);
export const kv = (v = "") => Object.fromEntries(split(v).map((p) => p.split("=").map((s) => s.trim())));

/** Reads a variable by its new name, falling back to the old one. */
export function envWithLegacy(env: Env, name: string, legacy: string, def = ""): string {
  return env[name] ?? env[legacy] ?? def;
}

export const legacyVarsIn = (env: Env) => Object.keys(LEGACY_VARS).filter((k) => env[k] !== undefined && env[k] !== "");

/** Connectors from the old variables (Jira only). */
export function legacyConnectors(env: Env): ConnectorsSettings {
  const used = legacyVarsIn(env);
  const base = {
    url: env.JIRA_URL ?? "", user: env.JIRA_USER ?? "", token: env.JIRA_TOKEN ?? "",
    deployment: (env.JIRA_DEPLOYMENT ?? "cloud") === "server" ? "server" as const : "cloud" as const,
  };
  const requests: JiraSettings = {
    kind: "jira", ...base,
    query: env.REC_JQL || `labels = ${DEFAULT_LABEL} AND statusCategory != Done`,
    project: "", issueType: "Task", operationalType: "Task", linkType: "Relates",
    transitions: kv(env.JIRA_TRANSITIONS),
  };
  // Before, the issue always existed: keep it when the .env comes from that version.
  const hadIssues = used.some((k) => k.startsWith("SIS_") || k === "REC_JQL");
  const issues: JiraSettings | undefined = hadIssues ? {
    kind: "jira", ...base, query: "",
    project: env.SIS_PROJECT || "SIS", issueType: env.SIS_TYPE || "Task",
    operationalType: env.SIS_TYPE_OPERATIONAL || env.SIS_TYPE || "Task", linkType: env.SIS_LINK || "Relates",
    transitions: kv(env.SIS_TRANSITIONS),
  } : undefined;
  return { requests, issues, legacy: used };
}

/** The `conectores` block equivalent to the old variables (for `orqen update`). */
export function legacyToYaml(env: Env) {
  const s = legacyConnectors(env);
  const ext = s.requests as JiraSettings, int = s.issues as JiraSettings | undefined;
  return {
    requests: { tipo: "jira", filtro: ext.query, ...(Object.keys(ext.transitions).length ? { transiciones: ext.transitions } : {}) },
    ...(int ? { issues: {
      tipo: "jira", proyecto: int.project, tipo_ticket: int.issueType, tipo_operativo: int.operationalType, vinculo: int.linkType,
      ...(Object.keys(int.transitions).length ? { transiciones: int.transitions } : {}),
    } } : {}),
  };
}
