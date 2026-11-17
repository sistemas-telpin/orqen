/**
 * Read and write Git-ignored Jira credentials, project settings, and approvers in orqen/.env.
 * `orqen init` lo genera a partir de orqen/.env.example con lo que la persona contesta.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const RUTA_ENV = "orqen/.env";

const LINEA = /^([A-Z][A-Z0-9_]*)=(.*)$/;

/** Separate the value from an inline comment while respecting quotes. */
function partirValor(resto: string): { valor: string; comentario: string } {
  const t = resto.trimStart();
  if (t.startsWith('"') || t.startsWith("'")) {
    const fin = t.indexOf(t[0], 1);
    if (fin > 0) return { valor: t.slice(1, fin), comentario: t.slice(fin + 1) };
  }
  const m = resto.match(/^(.*?)(\s+#.*)?$/)!;
  return { valor: m[1].trim(), comentario: m[2] ?? "" };
}

export function parsearEnv(texto: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const l of texto.split(/\r?\n/)) {
    const m = l.match(LINEA);
    if (m) out[m[1]] = partirValor(m[2]).valor;
  }
  return out;
}

const escribirValor = (v: string) => (/#|^\s|\s$|"/.test(v) ? `'${v}'` : v);

/** Replace selected values while preserving comments and other lines. */
export function completarEnv(plantilla: string, valores: Record<string, string | undefined>): string {
  const usados = new Set<string>();
  const lineas = plantilla.replace(/\r\n/g, "\n").split("\n").map((l) => {
    const m = l.match(LINEA);
    if (!m || valores[m[1]] === undefined) return l;
    usados.add(m[1]);
    const { comentario } = partirValor(m[2]);
    return `${m[1]}=${escribirValor(valores[m[1]]!)}${comentario}`;
  });
  const extra = Object.entries(valores).filter(([k, v]) => v !== undefined && !usados.has(k)).map(([k, v]) => `${k}=${escribirValor(v!)}`);
  return [...lineas, ...extra].join("\n").replace(/\n*$/, "\n");
}

export function leerEnv(repo: string): Record<string, string> | undefined {
  const p = join(repo, RUTA_ENV);
  return existsSync(p) ? parsearEnv(readFileSync(p, "utf8")) : undefined;
}

export function escribirEnv(repo: string, plantilla: string, valores: Record<string, string | undefined>) {
  const p = join(repo, RUTA_ENV);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, completarEnv(plantilla, valores));
}

export const jqlDeProyecto = (proyecto: string) => `project = ${proyecto} AND labels = rec-agente AND statusCategory != Done`;
/** Proyecto de un JQL del estilo "project = REC AND ..." (para proponerlo como valor por defecto). */
export const proyectoDeJql = (jql: string | undefined) => jql?.match(/project\s*=\s*"?([A-Za-z][\w-]*)"?/i)?.[1];
