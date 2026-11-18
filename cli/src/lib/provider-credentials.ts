/** Shared provider accounts for this user. Repository .env files remain a compatibility fallback. */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { completarEnv, leerEnv, parsearEnv } from "./env.ts";
import { type ConectoresYaml, credentialsPrefix } from "../connectors/config.ts";

export function providerFile() { return join(process.env.ORQEN_USER_CONFIG_DIR || join(homedir(), ".orqen"), "providers.env"); }

function sharedProviders(): Record<string, string> {
  return existsSync(providerFile()) ? parsearEnv(readFileSync(providerFile(), "utf8")) : {};
}

/** Shared credentials take precedence over old repository copies; drafts can still override them for testing. */
export function providerEnv(repo: string, environment: NodeJS.ProcessEnv = process.env): Record<string, string | undefined> {
  return { ...environment, ...(leerEnv(repo) ?? {}), ...sharedProviders() };
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
  writeFileSync(file + ".tmp", completarEnv("# ORQEN provider accounts for this user. Never commit this file.\n", values), { mode: 0o600 });
  renameSync(file + ".tmp", file);
  chmodSync(file, 0o600);
  return keys;
}
