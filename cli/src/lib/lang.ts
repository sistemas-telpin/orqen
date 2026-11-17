/**
 * Language of the person, taken from the operating system: Spanish (es) or English (en, the default for anything else).
 * The tutorial texts use it, and agents use it to talk to the person (`orqen lang`, `language` in the stage context).
 *
 * Order: ORQEN_LANG (override) → Windows display language (Get-UICulture) → macOS AppleLanguages →
 * LC_ALL / LC_MESSAGES / LANG / LANGUAGE → the locale Node reports.
 */
import { spawnSync } from "node:child_process";

export type Idioma = "es" | "en";

/** "es-AR", "es_ES.UTF-8", "Spanish" → es; everything else → en. Empty, "C" and "POSIX" mean nothing. */
export function normalizarIdioma(valor: string | undefined | null): Idioma | undefined {
  const v = (valor ?? "").trim().replace(/^["'(\s]+/, "");
  if (!v || /^(c|posix)([._].*)?$/i.test(v)) return undefined;
  return /^(es|spa|spanish|español)\b|^es[-_]/i.test(v) ? "es" : "en";
}

function correr(cmd: string, args: string[]): string | undefined {
  try {
    const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 5000, windowsHide: true });
    return r.status === 0 ? r.stdout.trim() : undefined;
  } catch { return undefined; }
}

let cache: Idioma | undefined;

export function detectarIdioma(env: NodeJS.ProcessEnv = process.env, plataforma: NodeJS.Platform = process.platform): Idioma {
  if (env === process.env && plataforma === process.platform && cache) return cache;
  const forzado = normalizarIdioma(env.ORQEN_LANG);
  let r = forzado;
  if (!r && plataforma === "win32") r = normalizarIdioma(correr("powershell", ["-NoProfile", "-NonInteractive", "-Command", "(Get-UICulture).Name"]));
  if (!r && plataforma === "darwin") r = normalizarIdioma(correr("defaults", ["read", "-g", "AppleLanguages"])?.match(/"?([A-Za-z]{2}[-_A-Za-z]*)"?/)?.[1]);
  if (!r) for (const k of ["LC_ALL", "LC_MESSAGES", "LANG", "LANGUAGE"]) if ((r = normalizarIdioma(env[k]))) break;
  if (!r) r = normalizarIdioma(Intl.DateTimeFormat().resolvedOptions().locale) ?? "en";
  if (env === process.env && plataforma === process.platform) cache = r;
  return r;
}

export const nombreIdioma = (i: Idioma) => (i === "es" ? "Spanish" : "English");
