/**
 * Repository configuration used by orqen commands, in two files with English keys:
 *  - orqen/config.yaml: what the 9-step flow needs (project, connectors, workflow, agent, OpenSpec).
 *  - orqen/environment.yaml: how the project starts and is tested (stack, processes, tests).
 * Internally (and in the JSON of `orqen connectors get|set`) the keys keep their original names; see config-keys.ts.
 * Files of earlier versions (Spanish keys, everything in config.yaml) are still read; `orqen update` rewrites them.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseDocument, stringify } from "yaml";
import { z } from "zod";
import { ProcesoEntorno } from "./processes.ts";
import { Stack } from "./stack.ts";
import { ConectoresYaml } from "../connectors/config.ts";
import { CONFIG_KEYS, ENVIRONMENT_KEYS, filePath, STACK_KEYS, toFile, toInternal } from "./config-keys.ts";

export const ARCHIVO_CONFIG = "orqen/config.yaml";
export const ARCHIVO_ENTORNO = "orqen/environment.yaml";

const Prefijo = z.string().trim().regex(/^[A-Za-z][A-Za-z0-9_]{0,19}$/, "Usá letras, números o guion bajo; empezá con una letra (máximo 20 caracteres).").transform((v) => v.toUpperCase());
/** Key prefixes of requests and issues (`requerimientos`/`tickets`: names used by earlier versions). */
export const General = z.object({ prefijos: z.preprocess((v) => {
  if (!v || typeof v !== "object") return v;
  const { requerimientos, tickets, ...rest } = v as Record<string, unknown>;
  return { ...rest, requests: rest.requests ?? requerimientos, issues: rest.issues ?? tickets };
}, z.object({ requests: Prefijo, issues: Prefijo })) });

/** A list of accounts: YAML list or "a, b" text. */
const Cuentas = z.preprocess((v) => typeof v === "string" ? v.split(",").map((s) => s.trim()).filter(Boolean) : v ?? [], z.array(z.string()));
/**
 * How the request flow works in this repository (shared, versioned). A variable in orqen/.env or the environment with the
 * old name (SUPPORT_STAGE, APPROVERS_*, CODE_REVIEW_GATE…) still overrides each value.
 */
export const Flujo = z.object({
  /** SUPPORT_STAGE: new requests go to a support person first (/orqen:support works either way). */
  soporte: z.boolean().default(false),
  /** Accounts of the requests system tool (Jira account id, GitHub login, Asana user id). Empty = anyone. */
  aprobadores: z.object({
    analisis: Cuentas, qa: Cuentas, codigo: Cuentas, cliente: Cuentas, ejecucion: Cuentas,
  }).partial().prefault({}),
  /** Who decides in CODE_REVIEW: github (review on the PR) or ticket (/approve and /reject comments); revisores = GitHub logins that count. */
  code_review: z.object({ gate: z.enum(["github", "ticket"]).default("github"), revisores: Cuentas }).partial().prefault({}),
  /** Branch the integration PR goes to (DEVEL_BRANCH) and the command that opens it (DEVEL_PR_COMMAND). */
  rama_desarrollo: z.string().nullish(),
  comando_pr: z.string().nullish(),
  /** Full test suite run in TESTING (TEST_COMMAND). */
  comando_tests: z.string().nullish(),
  /** Minutes a taken request stays reserved (ORQEN_LOCK_MIN) and seconds between rounds of `orqen cycle --loop` (ORQEN_INTERVAL_SEC). */
  lock_min: z.number().int().positive().nullish(),
  intervalo_seg: z.number().int().positive().nullish(),
});
export type Flujo = z.infer<typeof Flujo>;

export const Config = z.object({
  version: z.literal(1),
  orqen: z.object({ cli: z.string(), kit: z.string() }),
  proyecto: z.object({ nombre: z.string(), rama_base: z.string().default("main") }),
  general: General.optional(),
  flujo: Flujo.optional(),
  agente: z.object({ comando: z.string().nullish() }).default({}),
  openspec: z.object({
    version: z.string().nullish(),
    instalacion: z.enum(["devDependency", "global"]),
    herramientas: z.array(z.string()).default(["claude"]),
  }),
  stack: Stack.prefault({ resumen: "" }),
  /** Spec-driven development tool: auto (detected), openspec, spec-kit… (see src/sdd). */
  sdd: z.object({ proveedor: z.string().default("auto") }).optional(),
  /** Where the tickets live (requests = what the client sees, issues = optional team issues). */
  conectores: ConectoresYaml.nullish(),
  entornos: z.object({
    /** How each part of the project starts (npm run dev, npm start, mvn spring-boot:run…), without Docker in between. */
    procesos: z.array(ProcesoEntorno).default([]),
    variables: z.record(z.string(), z.string()).default({}),
    preparar: z.array(z.string()).default([]),
    migrar: z.array(z.string()).default([]),
    seed: z.array(z.string()).default([]),
    tests: z.object({
      unitarios: z.string().nullish(), integracion: z.string().nullish(),
      e2e: z.string().nullish(), visual: z.string().nullish(),
    }).default({}),
  }).prefault({}),
});
export type Config = z.infer<typeof Config>;

export function rutaConfig(repo: string) { return join(repo, ARCHIVO_CONFIG); }
export function rutaEntorno(repo: string) { return join(repo, ARCHIVO_ENTORNO); }
export function existeConfig(repo: string) { return existsSync(rutaConfig(repo)); }

const leerYaml = (p: string) => (parseDocument(readFileSync(p, "utf8")).toJS() ?? {}) as Record<string, unknown>;

/** config.yaml + environment.yaml (when present) with the internal key names. environment.yaml wins over the stack/entornos of an old config.yaml. */
export function leerConfig(repo: string): Config {
  const p = rutaConfig(repo);
  if (!existsSync(p)) throw new Error(`Missing ${ARCHIVO_CONFIG} in ${repo}. Run \`orqen init\` first.`);
  const raw = toInternal(leerYaml(p), CONFIG_KEYS);
  if (existsSync(rutaEntorno(repo))) {
    const { stack, ...env } = leerYaml(rutaEntorno(repo));
    if (stack !== undefined) raw.stack = toInternal(stack, STACK_KEYS);
    if (Object.keys(env).length) raw.entornos = toInternal(env, ENVIRONMENT_KEYS);
  }
  const r = Config.safeParse(raw);
  if (!r.success) {
    const where = (path: PropertyKey[]) => path[0] === "stack" ? `${ARCHIVO_ENTORNO}: ${filePath(path, { stack: { as: "stack", keys: STACK_KEYS } })}`
      : path[0] === "entornos" ? `${ARCHIVO_ENTORNO}: ${filePath(path.slice(1), ENVIRONMENT_KEYS)}` : `${ARCHIVO_CONFIG}: ${filePath(path, CONFIG_KEYS)}`;
    throw new Error(`Invalid orqen configuration:\n- ${r.error.issues.map((i) => `${where(i.path)}: ${i.message}`).join("\n- ")}`);
  }
  return r.data;
}

/** Whether config.yaml still has the format of earlier versions (Spanish keys, or the stack and environment inside). */
export function configVieja(repo: string): boolean {
  if (!existeConfig(repo)) return false;
  const top = Object.keys(leerYaml(rutaConfig(repo)));
  return top.some((k) => ["proyecto", "agente", "conectores", "flujo", "stack", "entornos"].includes(k));
}

/** Run the command from a relative directory in sh or cmd.exe. */
export function enRuta(ruta: string, cmd: string) {
  return ruta === "." || !ruta ? cmd : `cd ${ruta} && ${cmd}`;
}

/** Build the environment configuration from the detected stack. */
export function entornosDesdeStack(stack: Stack): Config["entornos"] {
  const esNode = (c: { lenguaje: string }) => ["typescript", "javascript"].includes(c.lenguaje);
  const raizNode = !!stack.instalar && /^(pnpm|npm|yarn|bun)\b/.test(stack.instalar);
  const preparar = [...new Set([
    ...(stack.instalar ? [stack.instalar] : []),
    ...stack.componentes
      .filter((c) => c.comandos.instalar && !(raizNode && esNode(c)))
      .map((c) => enRuta(c.ruta, c.comandos.instalar!)),
  ])];
  // Each component that can be started is a process: the frontend only for e2e / visual tests; backend and workers always.
  const procesos: ProcesoEntorno[] = stack.componentes
    .filter((c) => c.comandos.dev && ["frontend", "backend", "fullstack", "worker"].includes(c.tipo))
    .map((c) => ProcesoEntorno.parse({
      nombre: c.nombre, comando: c.comandos.dev, ruta: c.ruta || ".",
      puerto: c.tipo === "worker" ? undefined : c.puerto ?? undefined,
      cuando: c.tipo === "frontend" ? "e2e" : "siempre",
      espera_seg: ["java", "kotlin", "csharp"].includes(c.lenguaje) ? 300 : 120,
    }));
  return {
    procesos,
    variables: { ...stack.variables },
    preparar,
    migrar: stack.migraciones ? [stack.migraciones] : [],
    seed: stack.seed ? [stack.seed] : [],
    tests: { ...stack.tests },
  };
}

const limpiar = (v: unknown) => JSON.parse(JSON.stringify(v, (_k, x) => (x === null ? undefined : x)));   // omit null and undefined

/** The two files, with English keys: config.yaml (the flow) and environment.yaml (stack and how the project starts). */
export function serializarConfig(c: Config): { config: string; entorno: string } {
  const { stack, entornos, ...flujo } = limpiar(c) as Config;
  return {
    config: [
      "# orqen configuration for the 9-step flow: project, connectors (where the tickets live) and workflow. Edit as needed.",
      "# Tokens never go here: they live in ~/.orqen/credentials.env. How the project starts is in orqen/environment.yaml.",
      stringify(toFile(flujo, CONFIG_KEYS), { lineWidth: 0 }),
    ].join("\n"),
    entorno: [
      "# How the project starts and is tested (orqen env, development and TESTING). Generated by `orqen init`; edit as needed.",
      "# stack: what was detected · processes: how each part starts · tests: the suites.",
      stringify({ stack: toFile(stack, STACK_KEYS), ...toFile(entornos, ENVIRONMENT_KEYS) }, { lineWidth: 0 }),
    ].join("\n"),
  };
}

export function escribirConfig(repo: string, c: Config) {
  mkdirSync(dirname(rutaConfig(repo)), { recursive: true });
  const s = serializarConfig(c);
  writeFileSync(rutaConfig(repo), s.config);
  writeFileSync(rutaEntorno(repo), s.entorno);
}

/** Update version fields while preserving comments and key order. */
export function actualizarVersiones(repo: string, v: { cli?: string; kit?: string; openspec?: string }) {
  const p = rutaConfig(repo);
  const doc = parseDocument(readFileSync(p, "utf8"));
  if (v.cli) doc.setIn(["orqen", "cli"], v.cli);
  if (v.kit) doc.setIn(["orqen", "kit"], v.kit);
  if (v.openspec) doc.setIn(["openspec", "version"], v.openspec);
  writeFileSync(p, doc.toString({ lineWidth: 0 }));
}
