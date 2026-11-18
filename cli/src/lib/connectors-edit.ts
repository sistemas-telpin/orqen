/**
 * Connectors editing for the desktop app (Settings → Connectors → Configure):
 *   `orqen connectors get --json`  current `conectores` block + the related orqen/.env values (tokens masked)
 *   `orqen connectors check -`     checks a draft ({"conectores": …, "env": …} on stdin) without saving it
 *   `orqen connectors set -`       saves it (workflow.ts)
 */
import { connectorSettings, ConectoresYaml, credentialsPrefix, type ConectorYaml } from "../connectors/config.ts";
export { credentialsPrefix } from "../connectors/config.ts";
import { trackerFor } from "../connectors/index.ts";
import { GithubTracker } from "../connectors/github.ts";
import { checkFailure } from "../connectors/types.ts";

type Env = Record<string, string | undefined>;

/** Values left by the .env template: treated as empty. */
const PLACEHOLDER = /your-company|tu-empresa|^changeme$|^xxx+$/i;
const SECRET = /TOKEN|SECRET|PASSWORD/;

/** Shows a secret only by its end: ••••a1b2. */
export function mask(v: string): string {
  return v.length > 8 ? `••••${v.slice(-4)}` : "••••";
}

export interface ConnectorsView {
  conectores: ConectoresYaml | null;
  /** Non-secret values (URL, user, deployment…). */
  env: Record<string, string>;
  /** Secrets that are set, masked. */
  secrets: Record<string, string>;
}

/** What the app needs to fill the editor. Never returns a secret in clear. */
export function connectorsView(conectores: ConectoresYaml | null | undefined, env: Env): ConnectorsView {
  const prefixes = new Set(["JIRA", "JIRA_INTERNAL", "GITHUB", "ASANA"]);
  for (const c of [conectores?.externo, conectores?.interno]) if (c) prefixes.add(credentialsPrefix(c));
  const out: ConnectorsView = { conectores: conectores ?? null, env: {}, secrets: {} };
  for (const [k, v] of Object.entries(env)) {
    if (!v || PLACEHOLDER.test(v)) continue;
    if (![...prefixes].some((p) => k.startsWith(`${p}_`)) && k !== "GH_TOKEN") continue;
    if (SECRET.test(k)) out.secrets[k] = mask(v);
    else out.env[k] = v;
  }
  return out;
}

export interface Draft { conectores: ConectoresYaml; env: Record<string, string> }

/** Validates the JSON the app sends ({"conectores": {...}, "env": {...}}); empty env values mean "keep the current one". */
export function parseDraft(input: unknown): Draft {
  const raw = (input ?? {}) as { conectores?: unknown; env?: Record<string, unknown> };
  const parsed = ConectoresYaml.safeParse(raw.conectores);
  if (!parsed.success) throw new Error(`Invalid connectors: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  const env = Object.fromEntries(Object.entries(raw.env ?? {}).filter(([, v]) => typeof v === "string" && v.trim() !== "").map(([k, v]) => [k, (v as string).trim()]));
  return { conectores: parsed.data, env };
}

export interface CheckResult { role: "external" | "internal"; configured: boolean; kind?: string; label?: string; ok?: boolean; detail?: string }

/** Lists choices using draft credentials, without requiring a repository or saving the draft. */
export async function githubChoices(draft: Draft, current: Env, role: string, resource: string) {
  if (role !== "external" && role !== "internal") throw new Error("Expected external or internal connector role");
  if (resource !== "repositories" && resource !== "projects" && resource !== "statuses") throw new Error("Expected repositories or projects or statuses");
  const c = role === "external" ? draft.conectores.externo : draft.conectores.interno;
  if (c?.tipo !== "github") throw new Error("Select a GitHub connector first");
  const settings = connectorSettings(c, { ...current, ...draft.env });
  if (settings.kind !== "github") throw new Error("Expected GitHub settings");
  const tracker = new GithubTracker(settings);
  try {
    const items = resource === "repositories" ? await tracker.repositories() : resource === "statuses" ? await tracker.statuses() : await tracker.projects(c.duenio_proyecto || settings.repo.split("/")[0]);
    return { ok: true, items };
  } catch (e) { return { ok: false, detail: checkFailure(e, "https://api.github.com") }; }
}

/** Checks each connector of the draft against the tool, with the draft secrets over the current ones. Saves nothing. */
export async function checkDraft(draft: Draft, current: Env): Promise<CheckResult[]> {
  const env = { ...current, ...draft.env };
  const one = async (role: "external" | "internal", c: ConectorYaml | null | undefined): Promise<CheckResult> => {
    if (!c) return { role, configured: false };
    const t = trackerFor(connectorSettings(c, env));
    return { role, configured: true, kind: t.kind, label: t.label, ...(await t.check()) };
  };
  return [await one("external", draft.conectores.externo), await one("internal", draft.conectores.interno)];
}
