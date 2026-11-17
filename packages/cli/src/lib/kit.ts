/**
 * Instala / actualiza el kit de orqen en un repo sin pisar lo que el equipo personalizó.
 *
 * Cada archivo administrado se registra en orqen/manifest.json con el hash de lo que orqen escribió.
 * Al actualizar:
 *  - si el archivo no existe → se crea;
 *  - si su contenido es igual al nuevo → nada;
 *  - si su hash coincide con el del manifest (nadie lo tocó) → se reemplaza;
 *  - si no → conflicto: se le pregunta a la persona (sobrescribir / mantener / dejar la versión nueva al lado).
 * AGENTS.md se maneja como un bloque entre marcadores (el resto del archivo es del equipo).
 * openspec/config.yaml, CLAUDE.md, .gitignore y marketplace.json se fusionan (solo agregan).
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { DIR_PLANTILLAS, VERSION_KIT } from "orqen-kit";
import { fusionarConfigOpenSpec } from "./openspec.ts";

export const DIR_ORQEN = "orqen";
export const ARCHIVO_MANIFEST = "orqen/manifest.json";
export const INICIO_BLOQUE = "<!-- orqen:inicio — bloque administrado por orqen (`orqen update` lo actualiza; editá fuera del bloque) -->";
export const FIN_BLOQUE = "<!-- orqen:fin -->";
export const IGNORAR_GIT = ["orqen/state/", "orqen/tmp/", "orqen/.env"];

export interface Manifest { kit: string; archivos: Record<string, string> }
export interface VariablesKit { RESUMEN_STACK: string; RAMA_BASE: string; AGENTE_CMD: string }

export type Accion = "crear" | "actualizar" | "igual" | "conflicto";
export type Modo = "archivo" | "bloque" | "fusion";
export interface Cambio {
  ruta: string;            // relativa al repo, con /
  modo: Modo;
  accion: Accion;
  nuevo: string;           // contenido final que se escribiría (archivo completo)
  actual?: string;         // contenido actual (archivo completo)
  /** Para conflictos de bloque: lo que hay hoy y lo que habría dentro del bloque. */
  parteActual?: string;
  parteNueva?: string;
  hashNuevo?: string;      // lo que se guarda en el manifest (null para fusiones)
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

/** Archivos completos que vienen del kit: ruta en el repo → contenido. */
export function archivosDelKit(vars: VariablesKit): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of listar(join(DIR_PLANTILLAS, "etapas"))) out[`${DIR_ORQEN}/stages/${f}`] = render(readFileSync(join(DIR_PLANTILLAS, "etapas", f), "utf8"), vars);
  for (const f of listar(join(DIR_PLANTILLAS, "plugin"))) out[`${DIR_ORQEN}/plugin/${f}`] = render(readFileSync(join(DIR_PLANTILLAS, "plugin", f), "utf8"), vars);
  out[`${DIR_ORQEN}/work/README.md`] = render(readFileSync(join(DIR_PLANTILLAS, "work", "README.md"), "utf8"), vars);
  out[`${DIR_ORQEN}/.env.example`] = render(readFileSync(join(DIR_PLANTILLAS, "env.example"), "utf8"), vars);
  return out;
}

export function bloqueAgents(vars: VariablesKit): string {
  return render(readFileSync(join(DIR_PLANTILLAS, "AGENTS.md"), "utf8"), vars).trim();
}

/** Extrae el bloque de orqen de un AGENTS.md (o undefined si no lo tiene). */
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
  return (t.trimEnd() ? t.trimEnd() + "\n\n" : "") + "# orqen (estado local y temporales)\n" + faltan.join("\n") + "\n";
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
    description: "ORQEN: /orqen:analyze (grilling con el analista, carril, spec, SIS) y /orqen:implement",
  };
  const i = j.plugins.findIndex((p: any) => p?.name === "orqen");
  if (i >= 0) j.plugins[i] = { ...j.plugins[i], ...entrada }; else j.plugins.push(entrada);
  return { texto: JSON.stringify(j, null, 2) + "\n", nombre: j.name };
}

export interface OpcionesPlan {
  /** Archivos completos generados fuera del kit (ej. docker-compose.orqen.yml en init). */
  extra?: Record<string, string>;
  /** Incluir las fusiones de archivos del equipo (openspec/config.yaml, CLAUDE.md, .gitignore, marketplace). */
  fusiones?: boolean;
}

export function planificar(repo: string, vars: VariablesKit, o: OpcionesPlan = {}): Cambio[] {
  const manifest = leerManifest(repo);
  const cambios: Cambio[] = [];

  const archivos = { ...archivosDelKit(vars), ...o.extra };
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

  // AGENTS.md (bloque)
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
      const frag = readFileSync(join(DIR_PLANTILLAS, "openspec", "config.yaml"), "utf8");
      fusion("openspec/config.yaml", (a) => fusionarConfigOpenSpec(a ?? "", frag));
    }
  }
  return cambios;
}

export interface Resultado { ruta: string; accion: Accion | "mantenido" | "guardado-al-lado"; detalle?: string }

/**
 * Aplica el plan. `resolver` decide cada conflicto (en modo no interactivo conviene "nuevo": no pisa nada).
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
        const lado = c.modo === "bloque" ? `${c.ruta}.orqen-nuevo.md` : `${c.ruta}.orqen-nuevo`;
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

  // orqen/.env local (ignorado por git) a partir del ejemplo
  const env = join(repo, DIR_ORQEN, ".env"), ejemplo = join(repo, DIR_ORQEN, ".env.example");
  if (!existsSync(env) && existsSync(ejemplo)) writeFileSync(env, readFileSync(ejemplo, "utf8"));
  return out;
}
