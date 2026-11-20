/** Shared provider accounts for this user. Repository .env files remain a compatibility fallback. */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { completarEnv, leerEnv, parsearEnv } from "./env.ts";
import { type ConectoresYaml, credentialsPrefix } from "../connectors/config.ts";

const userDir = () => process.env.ORQEN_USER_CONFIG_DIR || join(homedir(), ".orqen");
export function providerFile() { return join(userDir(), "credentials.env"); }
/** Name used by earlier versions: still read when credentials.env does not exist, and replaced by it on the next save. */
const legacyFile = () => join(userDir(), "providers.env");

function sharedProviders(): Record<string, string> {
  const file = existsSync(providerFile()) ? providerFile() : existsSync(legacyFile()) ? legacyFile() : undefined;
  return file ? parsearEnv(readFileSync(file, "utf8")) : {};
}

/**
 * Credentials by precedence: the environment (CI, a shell export) → the shared provider file → old copies in the repository's
 * orqen/.env. loadConfig loads orqen/.env into process.env, so a variable whose value is the one in orqen/.env counts as that
 * old copy, not as the environment. Drafts can still override all of them for testing.
 */
export function providerEnv(repo: string, environment: NodeJS.ProcessEnv = process.env): Record<string, string | undefined> {
  const local = leerEnv(repo) ?? {};
  const real = Object.fromEntries(Object.entries(environment).filter(([k, v]) => v !== undefined && v !== "" && local[k] !== v));
  return { ...environment, ...local, ...sharedProviders(), ...real };
}

export function saveProviders(connectors: ConectoresYaml, draft: Record<string, string>, current: Record<string, string | undefined>) {
  const keys = new Set<string>();
  for (const c of [connectors.requests, connectors.issues]) if (c) {
    const prefix = credentialsPrefix(c);
    if (c.tipo === "github") keys.add("GH_TOKEN");
    for (const suffix of c.tipo === "jira" ? ["URL", "USER", "TOKEN", "DEPLOYMENT"] : ["TOKEN"]) keys.add(`${prefix}_${suffix}`);
  }
  const values = sharedProviders();
  for (const key of keys) {
    const value = draft[key] || values[key] || current[key];
    if (value && !/your-company|tu-empresa|^changeme$|^xxx+$/i.test(value)) values[key] = value;
  }
  const file = providerFile();
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file + ".tmp", completarEnv("# orqen provider accounts for this user. Never commit this file.\n", values), { mode: 0o600 });
  renameSync(file + ".tmp", file);
  chmodSync(file, 0o600);
  rmSync(legacyFile(), { force: true });   // everything it had is now in credentials.env
  return keys;
}
