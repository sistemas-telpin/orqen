/**
 * orqen.yaml: la configuración de orqen en el repo (versionada). La lee `orqen entorno` y la usará el resto de los comandos.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseDocument, stringify } from "yaml";
import { z } from "zod";
import { ARCHIVO_COMPOSE } from "./compose.ts";
import { Stack, variablesHost } from "./stack.ts";

export const ARCHIVO_CONFIG = "orqen.yaml";

export const Config = z.object({
  version: z.literal(1),
  orqen: z.object({ cli: z.string(), kit: z.string() }),
  proyecto: z.object({ nombre: z.string(), rama_base: z.string().default("main") }),
  agente: z.object({ comando: z.string().nullish() }).default({}),
  openspec: z.object({
    version: z.string().nullish(),
    instalacion: z.enum(["devDependency", "global"]),
    herramientas: z.array(z.string()).default(["claude"]),
  }),
  stack: Stack,
  entornos: z.object({
    compose: z.string().default(ARCHIVO_COMPOSE),
    variables: z.record(z.string(), z.string()).default({}),
    preparar: z.array(z.string()).default([]),
    migrar: z.array(z.string()).default([]),
    seed: z.array(z.string()).default([]),
    tests: z.object({
      unitarios: z.string().nullish(), integracion: z.string().nullish(),
      e2e: z.string().nullish(), visual: z.string().nullish(),
    }).default({}),
  }),
});
export type Config = z.infer<typeof Config>;

export function rutaConfig(repo: string) { return join(repo, ARCHIVO_CONFIG); }
export function existeConfig(repo: string) { return existsSync(rutaConfig(repo)); }

export function leerConfig(repo: string): Config {
  const p = rutaConfig(repo);
  if (!existsSync(p)) throw new Error(`No hay ${ARCHIVO_CONFIG} en ${repo}. Corré \`orqen init\` primero.`);
  const r = Config.safeParse(parseDocument(readFileSync(p, "utf8")).toJS());
  if (!r.success) throw new Error(`${ARCHIVO_CONFIG} inválido:\n- ${r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n- ")}`);
  return r.data;
}

/** `cd <ruta> && cmd` portable (sh y cmd.exe). */
export function enRuta(ruta: string, cmd: string) {
  return ruta === "." || !ruta ? cmd : `cd ${ruta} && ${cmd}`;
}

/** Arma la sección entornos a partir del stack. */
export function entornosDesdeStack(stack: Stack): Config["entornos"] {
  const esNode = (c: { lenguaje: string }) => ["typescript", "javascript"].includes(c.lenguaje);
  const raizNode = !!stack.instalar && /^(pnpm|npm|yarn|bun)\b/.test(stack.instalar);
  const preparar = [...new Set([
    ...(stack.instalar ? [stack.instalar] : []),
    ...stack.componentes
      .filter((c) => c.comandos.instalar && !(raizNode && esNode(c)))
      .map((c) => enRuta(c.ruta, c.comandos.instalar!)),
  ])];
  return {
    compose: ARCHIVO_COMPOSE,
    variables: variablesHost(stack),
    preparar,
    migrar: stack.migraciones ? [stack.migraciones] : [],
    seed: stack.seed ? [stack.seed] : [],
    tests: { ...stack.tests },
  };
}

export function serializarConfig(c: Config): string {
  const limpio = JSON.parse(JSON.stringify(c, (_k, v) => (v === null ? undefined : v))); // saca null / undefined
  return [
    "# Configuración de ORQEN para este repo. Generada por `orqen init`; editala libremente.",
    "# entornos: lo que usan los agentes para levantar el proyecto y correr tests (`orqen entorno ...`).",
    stringify(limpio, { lineWidth: 0 }),
  ].join("\n");
}

export function escribirConfig(repo: string, c: Config) {
  writeFileSync(rutaConfig(repo), serializarConfig(c));
}

/** Actualiza solo la sección orqen (versiones) preservando comentarios y orden del archivo. */
export function actualizarVersiones(repo: string, v: { cli?: string; kit?: string; openspec?: string }) {
  const p = rutaConfig(repo);
  const doc = parseDocument(readFileSync(p, "utf8"));
  if (v.cli) doc.setIn(["orqen", "cli"], v.cli);
  if (v.kit) doc.setIn(["orqen", "kit"], v.kit);
  if (v.openspec) doc.setIn(["openspec", "version"], v.openspec);
  writeFileSync(p, doc.toString({ lineWidth: 0 }));
}
