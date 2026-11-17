/**
 * Find and install a compatible OpenSpec version, initialize or update it,
 * and merge orqen's rules into the project configuration.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import semver from "semver";
import { isMap, isScalar, isSeq, parseDocument, YAMLMap, YAMLSeq } from "yaml";
import { gestorNode } from "./detect.ts";
import { ejecutar, version } from "./proc.ts";

export const PAQUETE_OPENSPEC = "@fission-ai/openspec";
/** Supported OpenSpec versions with JSON validation, status, and instructions. */
export const RANGO_OPENSPEC = ">=2.0.0 <3.0.0";
export const VERSION_MINIMA = "2.0.0";

export type Instalacion = "devDependency" | "global";

export interface EstadoOpenSpec {
  instalacion: Instalacion | null;
  /** Installed version, local or global. */
  version: string | null;
  /** Version range declared in package.json for a local install. */
  declarada: string | null;
  compatible: boolean;
  inicializado: boolean;  // The openspec directory exists.
}

const leerJson = (p: string): any => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return undefined; } };
export const esRepoNode = (repo: string) => existsSync(join(repo, "package.json"));

export function estadoOpenSpec(repo: string): EstadoOpenSpec {
  const pkg = leerJson(join(repo, "package.json"));
  const declarada = pkg?.devDependencies?.[PAQUETE_OPENSPEC] ?? pkg?.dependencies?.[PAQUETE_OPENSPEC] ?? null;
  const local = leerJson(join(repo, "node_modules", ...PAQUETE_OPENSPEC.split("/"), "package.json"))?.version ?? null;
  let instalacion: Instalacion | null = declarada || local ? "devDependency" : null;
  let v: string | null = local;
  if (!v) {
    const g = version("openspec", ["--version"]);
    if (g) { v = semver.coerce(g)?.version ?? g; instalacion = instalacion ?? "global"; }
  }
  return {
    instalacion, version: v, declarada,
    compatible: !!v && semver.satisfies(semver.coerce(v)?.version ?? "0.0.0", RANGO_OPENSPEC),
    inicializado: existsSync(join(repo, "openspec")),
  };
}

/** Latest compatible version, or null when the registry is unavailable. */
export function ultimaVersionOpenSpec(cwd?: string): string | null {
  const r = ejecutar("npm", ["view", `${PAQUETE_OPENSPEC}@${RANGO_OPENSPEC}`, "version", "--json"], { cwd, timeoutMs: 30_000 });
  if (r.codigo !== 0) return null;
  try {
    const j = JSON.parse(r.stdout);
    const vs: string[] = Array.isArray(j) ? j : [j];
    return semver.maxSatisfying(vs, RANGO_OPENSPEC);
  } catch { return null; }
}

export function comandoAgregarDev(repo: string, paquete: string): [string, string[]] {
  const pm = gestorNode(repo);
  switch (pm) {
    case "pnpm": return ["pnpm", ["add", "-D", paquete]];
    case "yarn": return ["yarn", ["add", "-D", paquete]];
    case "bun": return ["bun", ["add", "-d", paquete]];
    default: return ["npm", ["install", "-D", paquete]];
  }
}

/** Select the OpenSpec command for the installation and package manager. */
export function comandoOpenSpec(repo: string, instalacion: Instalacion): [string, string[]] {
  if (instalacion === "global") return ["openspec", []];
  const pm = gestorNode(repo);
  if (pm === "pnpm") return ["pnpm", ["exec", "openspec"]];
  if (pm === "yarn") return ["yarn", ["openspec"]];
  if (pm === "bun") return ["bunx", ["openspec"]];
  return ["npx", ["--no", "openspec"]];
}

export function instalarOpenSpec(repo: string, instalacion: Instalacion, versionObjetivo: string) {
  const paquete = `${PAQUETE_OPENSPEC}@^${versionObjetivo}`;
  const [cmd, args] = instalacion === "devDependency"
    ? comandoAgregarDev(repo, paquete)
    : (version("pnpm") ? ["pnpm", ["add", "-g", paquete]] as [string, string[]] : ["npm", ["install", "-g", paquete]] as [string, string[]]);
  const r = ejecutar(cmd, args, { cwd: repo, timeoutMs: 10 * 60_000 });
  if (r.codigo !== 0) throw new Error(`Failed to run \`${cmd} ${args.join(" ")}\`:\n${(r.stderr || r.stdout).trim().slice(-2000)}`);
  return `${cmd} ${args.join(" ")}`;
}

export function inicializarOpenSpec(repo: string, instalacion: Instalacion, herramientas: string[]) {
  const [cmd, base] = comandoOpenSpec(repo, instalacion);
  const args = [...base, "init", "--tools", herramientas.length ? herramientas.join(",") : "none", "--language", "English", "--no-animation", "--no-copilot-cloud"];
  const r = ejecutar(cmd, args, { cwd: repo, timeoutMs: 5 * 60_000, entrada: "" });
  if (r.codigo !== 0) throw new Error(`Failed to run \`openspec init\`:\n${(r.stderr || r.stdout).trim().slice(-2000)}`);
}

export function actualizarArchivosOpenSpec(repo: string, instalacion: Instalacion) {
  const [cmd, base] = comandoOpenSpec(repo, instalacion);
  const r = ejecutar(cmd, [...base, "update"], { cwd: repo, timeoutMs: 5 * 60_000, entrada: "" });
  if (r.codigo !== 0) throw new Error(`Failed to run \`openspec update\`:\n${(r.stderr || r.stdout).trim().slice(-2000)}`);
}

/**
 * Merge orqen's context, rules, and operations while preserving comments.
 * - Append context lines that are missing.
 * - Append rules and operation guidance that are missing.

 */
export function fusionarConfigOpenSpec(actual: string, fragmento: string): string {
  const doc = parseDocument(actual || "schema: spec-driven\n");
  const frag = parseDocument(fragmento).toJS() as Record<string, any>;
  if (!doc.has("schema") && frag.schema) doc.set("schema", frag.schema);

  if (typeof frag.context === "string") {
    const ctx = String(doc.get("context") ?? "");
    const lineas = ctx.split("\n").map((l) => l.trim());
    const faltan = frag.context.split("\n").filter((l: string) => l.trim() && !lineas.includes(l.trim()));
    if (faltan.length) doc.set("context", (ctx.trimEnd() ? ctx.trimEnd() + "\n" : "") + faltan.join("\n") + "\n");
  }

  const fusionar = (ruta: string[], valor: any) => {
    if (Array.isArray(valor)) {
      const nodo = doc.getIn(ruta, true);
      const existentes = isSeq(nodo) ? (nodo as YAMLSeq).items.map((i) => (isScalar(i) ? String(i.value) : String(i))) : [];
      const seq = isSeq(nodo) ? (nodo as YAMLSeq) : new YAMLSeq();
      for (const v of valor) if (!existentes.includes(String(v))) seq.add(doc.createNode(v));
      if (!isSeq(nodo)) doc.setIn(ruta, seq);
    } else if (valor && typeof valor === "object") {
      const nodo = doc.getIn(ruta, true);
      if (!isMap(nodo)) doc.setIn(ruta, new YAMLMap());
      for (const [k, v] of Object.entries(valor)) fusionar([...ruta, k], v);
    }
  };
  for (const k of ["rules", "operations"]) if (frag[k]) fusionar([k], frag[k]);
  return doc.toString({ lineWidth: 0 });
}

export function aplicarFragmentoOpenSpec(repo: string, fragmento: string): boolean {
  const p = join(repo, "openspec", "config.yaml");
  const actual = existsSync(p) ? readFileSync(p, "utf8") : "";
  const nuevo = fusionarConfigOpenSpec(actual, fragmento);
  if (nuevo === actual) return false;
  writeFileSync(p, nuevo);
  return true;
}
