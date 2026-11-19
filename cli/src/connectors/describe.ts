/** Human names and example keys of each connector (tutorial, `orqen connectors`). */
import type { ConnectorKind } from "./types.ts";
import type { ConnectorSettings } from "./config.ts";

export const nombreHerramienta = (k: ConnectorKind) => ({ jira: "Jira", github: "GitHub", asana: "Asana", local: "tickets locales" })[k];

/** Example key: Jira uses the project key (from `proyecto` or the JQL), GitHub/Asana their prefix. */
export function ejemploClave(s: ConnectorSettings, n: number): string {
  if (s.kind === "jira") {
    if (s.prefix) return `${s.prefix}-${n}`;
    const p = s.project || s.query.match(/project\s*=\s*"?([A-Za-z][\w-]*)"?/i)?.[1] || "SOP";
    return `${p.toUpperCase()}-${n}`;
  }
  if (s.kind === "github" || s.kind === "local") return `${s.prefix}-${n}`;
  return `${s.prefix}-1204${n}`;
}
