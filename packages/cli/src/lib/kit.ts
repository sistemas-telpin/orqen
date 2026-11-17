/**
 * Install and update the kit while preserving project edits.
 *
 * Record the last installed content hash in orqen/manifest.json.
 * During update:
 *  - Create missing files.
 *  - Skip files already up to date.
 *  - Replace files that match the saved hash.
 *  - Ask the user how to handle local edits.
 * Manage only the marked AGENTS.md block.
 * Merge additions into OpenSpec config, CLAUDE.md, .gitignore, and marketplace.json.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { TEMPLATES_DIR, VERSION_KIT } from "orqen-kit";
import { fusionarConfigOpenSpec } from "./openspec.ts";
import { stageGuideFile } from "./stage-guides.ts";

export const DIR_ORQEN = "orqen";
export const ARCHIVO_MANIFEST = "orqen/manifest.json";
export const INICIO_BLOQUE = "<!-- orqen:inicio — managed by orqen (edit outside this block; `orqen update` refreshes it) -->";
export const FIN_BLOQUE = "<!-- orqen:fin -->";
export const IGNORAR_GIT = ["orqen/state/", "orqen/tmp/", "orqen/.env"];

export interface Manifest { kit: string; archivos: Record<string, string> }
export interface VariablesKit { RESUMEN_STACK: string; RAMA_BASE: string; AGENTE_CMD: string }

export type Accion = "crear" | "actualizar" | "igual" | "conflicto";
export type Modo = "archivo" | "bloque" | "fusion";
export interface Cambio {
  ruta: string;            // Repository-relative path with forward slashes.
  modo: Modo;
  accion: Accion;
  nuevo: string;           // Proposed full file content.
  actual?: string;         // Current full file content.
  /** Current and proposed content for a managed block conflict. */
  parteActual?: string;
  parteNueva?: string;
  hashNuevo?: string;      // Hash saved to the manifest for managed files.
}

export type Decision = "sobrescribir" | "mantener" | "nuevo";

export const normalizar = (s: string) => s.replace(/\r\n/g, "\n");
export const hash = (s: string) => createHash("sha256").update(normalizar(s)).digest("hex").slice(0, 16);
const leer = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : undefined);

export function leerManifest(repo: string): Manifest {
  try { return JSON.parse(readFileSync(join(repo, ARCHIVO_MANIFEST), "utf8")); }
  catch { return { kit: "0.0.0", archivos: {} }; }
}

function escribir(repo: string, ruta: string, contenido: string) {
  const p = join(repo, ruta);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, contenido);
}

function render(texto: string, vars: VariablesKit) {
  return normalizar(texto).replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? (vars as any)[k] : m));
}

function listar(dir: string): string[] {
  const out: string[] = [];
  const rec = (d: string) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) rec(p); else out.push(relative(dir, p).replaceAll("\\", "/"));
    }
  };
  rec(dir);
  return out.sort();
}

/** Map repository paths to rendered kit contents. */
export function archivosDelKit(vars: VariablesKit, repo: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of listar(join(TEMPLATES_DIR, "stages"))) out[`${DIR_ORQEN}/stages/${stageGuideFile(join(repo, DIR_ORQEN, "stages"), f)}`] = render(readFileSync(join(TEMPLATES_DIR, "stages", f), "utf8"), vars);
  for (const f of listar(join(TEMPLATES_DIR, "plugin"))) out[`${DIR_ORQEN}/plugin/${f}`] = render(readFileSync(join(TEMPLATES_DIR, "plugin", f), "utf8"), vars);
  out[`${DIR_ORQEN}/work/README.md`] = render(readFileSync(join(TEMPLATES_DIR, "work", "README.md"), "utf8"), vars);
  out[`${DIR_ORQEN}/.env.example`] = render(readFileSync(join(TEMPLATES_DIR, "env.example"), "utf8"), vars);
  return out;
}

export function bloqueAgents(vars: VariablesKit): string {
  return render(readFileSync(join(TEMPLATES_DIR, "AGENTS.md"), "utf8"), vars).trim();
}

/** Extract the marked orqen block if present. */
export function extraerBloque(texto: string): string | undefined {
  const t = normalizar(texto);
  const i = t.indexOf("<!-- orqen:inicio"), f = t.indexOf(FIN_BLOQUE);
  if (i < 0 || f < i) return undefined;
  const desde = t.indexOf("\n", i) + 1;
  return t.slice(desde, f).trim();
}

export function reemplazarBloque(texto: string | undefined, bloque: string): string {
  const envuelto = `${INICIO_BLOQUE}\n\n${bloque}\n\n${FIN_BLOQUE}`;
  if (!texto?.trim()) return `# AGENTS.md\n\n${envuelto}\n`;
  const t = normalizar(texto);
  const i = t.indexOf("<!-- orqen:inicio"), f = t.indexOf(FIN_BLOQUE);
  if (i >= 0 && f > i) return t.slice(0, i) + envuelto + t.slice(f + FIN_BLOQUE.length);
  return t.trimEnd() + "\n\n" + envuelto + "\n";
}

function claudeMd(actual: string | undefined) {
  if (!actual) return "@AGENTS.md\n";
  return /^@AGENTS\.md\s*$/m.test(actual) ? actual : normalizar(actual).trimEnd() + "\n\n@AGENTS.md\n";
}

function gitignore(actual: string | undefined) {
  const t = normalizar(actual ?? "");
  const lineas = t.split("\n").map((l) => l.trim());
  const faltan = IGNORAR_GIT.filter((l) => !lineas.includes(l));
  if (!faltan.length) return t;
  return (t.trimEnd() ? t.trimEnd() + "\n\n" : "") + "# orqen (local state and temporary files)\n" + faltan.join("\n") + "\n";
}

export const MARKETPLACE = ".claude-plugin/marketplace.json";
export function marketplace(actual: string | undefined): { texto: string; nombre: string } {
  let j: any = {};
  try { j = actual ? JSON.parse(actual) : {}; } catch { j = {}; }
  j.name ??= "orqen";
  j.owner ??= { name: "Telpin" };
  j.plugins = Array.isArray(j.plugins) ? j.plugins : [];
  const entrada = {
    name: "orqen", source: `./${DIR_ORQEN}/plugin`,
    description: "ORQEN: /orqen:analyze (analyst interview, lane, spec, and SIS) and /orqen:implement",
  };
  const i = j.plugins.findIndex((p: any) => p?.name === "orqen");
  if (i >= 0) j.plugins[i] = { ...j.plugins[i], ...entrada }; else j.plugins.push(entrada);
  return { texto: JSON.stringify(j, null, 2) + "\n", nombre: j.name };
}

export interface OpcionesPlan {
  /** Additional files generated outside the kit, such as Compose configuration. */
  extra?: Record<string, string>;
  /** Include merges into user-managed files. */
  fusiones?: boolean;
}

export function planificar(repo: string, vars: VariablesKit, o: OpcionesPlan = {}): Cambio[] {
  const manifest = leerManifest(repo);
  const cambios: Cambio[] = [];

  const archivos = { ...archivosDelKit(vars, repo), ...o.extra };
  for (const [ruta, nuevo] of Object.entries(archivos)) {
    const actual = leer(join(repo, ruta));
    const h = hash(nuevo);
    let accion: Accion;
    if (actual === undefined) accion = "crear";
    else if (normalizar(actual) === nuevo) accion = "igual";
    else if (manifest.archivos[ruta] === hash(actual)) accion = "actualizar";
    else accion = "conflicto";
    cambios.push({ ruta, modo: "archivo", accion, nuevo, actual, hashNuevo: h });
  }

  // Managed AGENTS.md block
  {
    const ruta = "AGENTS.md", clave = "AGENTS.md#orqen";
    const actual = leer(join(repo, ruta));
    const bloque = bloqueAgents(vars);
    const hoy = actual ? extraerBloque(actual) : undefined;
    const nuevo = reemplazarBloque(actual, bloque);
    let accion: Accion;
    if (actual === undefined) accion = "crear";
    else if (hoy === bloque) accion = "igual";
    else if (hoy === undefined || manifest.archivos[clave] === hash(hoy)) accion = "actualizar";
    else accion = "conflicto";
    cambios.push({ ruta, modo: "bloque", accion, nuevo, actual, parteActual: hoy, parteNueva: bloque, hashNuevo: hash(bloque) });
  }

  if (o.fusiones !== false) {
    const fusion = (ruta: string, f: (a: string | undefined) => string) => {
      const actual = leer(join(repo, ruta));
      const nuevo = f(actual);
      cambios.push({ ruta, modo: "fusion", accion: actual === undefined ? "crear" : normalizar(actual) === normalizar(nuevo) ? "igual" : "actualizar", nuevo, actual });
    };
    fusion("CLAUDE.md", claudeMd);
    fusion(".gitignore", gitignore);
    fusion(MARKETPLACE, (a) => marketplace(a).texto);
    if (existsSync(join(repo, "openspec"))) {
      const frag = readFileSync(join(TEMPLATES_DIR, "openspec", "config.yaml"), "utf8");
      fusion("openspec/config.yaml", (a) => fusionarConfigOpenSpec(a ?? "", frag));
    }
  }
  return cambios;
}

export interface Resultado { ruta: string; accion: Accion | "mantenido" | "guardado-al-lado"; detalle?: string }

/**
 * Apply the plan using the supplied conflict resolver.
 */
export async function aplicar(
  repo: string,
  cambios: Cambio[],
  resolver: (c: Cambio) => Promise<Decision>,
): Promise<Resultado[]> {
  const manifest = leerManifest(repo);
  const out: Resultado[] = [];
  for (const c of cambios) {
    const clave = c.modo === "bloque" ? `${c.ruta}#orqen` : c.ruta;
    if (c.accion === "igual") {
      if (c.hashNuevo) manifest.archivos[clave] = c.hashNuevo;
      out.push({ ruta: c.ruta, accion: "igual" });
      continue;
    }
    if (c.accion === "conflicto") {
      const d = await resolver(c);
      if (d === "mantener") { out.push({ ruta: c.ruta, accion: "mantenido" }); continue; }
      if (d === "nuevo") {
        const lado = c.modo === "bloque" ? `${c.ruta}.orqen-new.md` : `${c.ruta}.orqen-new`;
        escribir(repo, lado, c.modo === "bloque" ? c.parteNueva! + "\n" : c.nuevo);
        out.push({ ruta: c.ruta, accion: "guardado-al-lado", detalle: lado });
        continue;
      }
    }
    escribir(repo, c.ruta, c.nuevo);
    if (c.hashNuevo) manifest.archivos[clave] = c.hashNuevo;
    out.push({ ruta: c.ruta, accion: c.accion });
  }
  manifest.kit = VERSION_KIT;
  escribir(repo, ARCHIVO_MANIFEST, JSON.stringify(manifest, null, 2) + "\n");

  // Create a Git-ignored orqen/.env from the example if needed.
  const env = join(repo, DIR_ORQEN, ".env"), ejemplo = join(repo, DIR_ORQEN, ".env.example");
  if (!existsSync(env) && existsSync(ejemplo)) writeFileSync(env, readFileSync(ejemplo, "utf8"));
  return out;
}
