/**
 * Tools: the catalog of stacks orqen knows how to create and run (`cli/tools/<id>/` in a private GitHub clone).
 *
 * Each tool has a `tool.yaml` with:
 *   - requisitos   commands it needs (node, mvn, docker…), with an optional minimum version
 *   - parametros   extra questions for `orqen bootstrap` (ports, Java package…)
 *   - scaffold     steps to create the code: copy files (`copiar`), run official generators (`correr`), write files (`archivo`)
 *   - tools        scripts copied to the project's `orqen/tools/` folder (e.g. the database script)
 *   - db           database settings written to `orqen/tools/db.json`
 *   - stack / entornos   what goes into orqen/config.yaml: how each part starts, variables, migrations and tests
 *
 * `{{VARIABLES}}` are replaced in tool.yaml, in copied file contents and in their paths.
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import semver from "semver";
import { parse } from "yaml";
import { z } from "zod";
import { ProcesoEntorno } from "./processes.ts";
import { version } from "./proc.ts";
import { Stack } from "./stack.ts";

// Source and compiled modules have the same depth beneath the CLI installation.
export const TOOLS_DIR = resolve(process.env.ORQEN_TOOLS_DIR || fileURLToPath(new URL("../../tools/", import.meta.url)));

const Requisito = z.object({ comando: z.string(), version: z.string().nullish(), ayuda: z.string().nullish() });
const Parametro = z.object({
  id: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  pregunta: z.string(),
  tipo: z.enum(["texto", "puerto", "paquete_java"]).default("texto"),
  defecto: z.union([z.string(), z.number()]).transform(String),
});
const Paso = z.union([
  z.object({ copiar: z.string() }),
  z.object({ correr: z.string(), en: z.string().nullish(), descripcion: z.string().nullish() }),
  z.object({ archivo: z.string(), contenido: z.string() }),
]);
export const Tool = z.object({
  id: z.string(),
  nombre: z.string(),
  descripcion: z.string(),
  requisitos: z.array(Requisito).default([]),
  parametros: z.array(Parametro).default([]),
  scaffold: z.array(Paso).default([]),
  tools: z.array(z.string()).default([]),
  db: z.object({
    engine: z.enum(["postgres", "sqlserver"]),
    port: z.number().int().positive(),
    database: z.string(),
    user: z.string(),
    password: z.string(),
    image: z.string().nullish(),
  }).nullish(),
  stack: Stack,
  entornos: z.object({
    procesos: z.array(ProcesoEntorno).default([]),
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
export type Tool = z.infer<typeof Tool>;
export type Variables = Record<string, string>;

export const render = (texto: string, vars: Variables) =>
  texto.replace(/\{\{([A-Z][A-Z0-9_]*)\}\}/g, (m, k) => (k in vars ? vars[k] : m));

// Normalize line endings: on Windows, Git may check the catalog out with CRLF.
const leerYaml = (id: string, dir = TOOLS_DIR) => readFileSync(join(dir, id, "tool.yaml"), "utf8").replace(/\r\n/g, "\n");

export interface ResumenTool { id: string; nombre: string; descripcion: string }

/** Available tools (folders with a tool.yaml; `_shared` and others starting with `_` are not tools). */
export function listarTools(dir = TOOLS_DIR): ResumenTool[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((d) => !d.startsWith("_") && existsSync(join(dir, d, "tool.yaml")))
    .sort()
    .map((id) => {
      // Placeholders are not valid YAML everywhere: read only the top-level text fields.
      const y = leerYaml(id, dir);
      const campo = (k: string) => y.match(new RegExp(`^${k}:\\s*(.+)$`, "m"))?.[1].trim().replace(/^["']|["']$/g, "") ?? "";
      return { id, nombre: campo("nombre") || id, descripcion: campo("descripcion") };
    });
}

/** Text-only view of the tool's parameters (before the person answers them). */
export function parametrosDe(id: string, base: Variables): z.infer<typeof Parametro>[] {
  const y = leerYaml(id);
  const bloque = y.match(/^parametros:\n((?:[ \t]+.*\n?)*)/m)?.[1] ?? "";
  const doc = parse(`parametros:\n${render(bloque, base)}`) as { parametros?: unknown };
  return z.array(Parametro).parse(doc.parametros ?? []);
}

export function cargarTool(id: string, vars: Variables): Tool {
  const r = Tool.safeParse(parse(render(leerYaml(id), vars)));
  if (!r.success) throw new Error(`tools/${id}/tool.yaml is invalid:\n- ${r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n- ")}`);
  return r.data;
}

/** Variables every tool can use. */
export function variablesBase(nombre: string): Variables {
  const id = nombre.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "proyecto";
  const java = id.replace(/-/g, "").replace(/^[^a-z]+/, "") || "app";
  // Local development container only; meets SQL Server's complexity rules.
  const password = `Orqen-${randomBytes(6).toString("hex")}-Db1`;
  return { PROYECTO: nombre.trim(), PROYECTO_ID: id, PROYECTO_JAVA: java, DB_PASSWORD: password };
}

export function validarParametro(tipo: string, v: string): string | undefined {
  if (tipo === "puerto") {
    const n = Number(v);
    return Number.isInteger(n) && n > 0 && n < 65536 ? undefined : "A port is a number between 1 and 65535";
  }
  if (tipo === "paquete_java") return /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(v) ? undefined : "Use a Java package such as com.company.project";
  return v ? undefined : "Required";
}

export interface Requerimiento { comando: string; ok: boolean; detalle: string; ayuda?: string }

export function chequearRequisitos(tool: Pick<Tool, "requisitos">): Requerimiento[] {
  return tool.requisitos.map((r) => {
    const v = version(r.comando);
    if (v === null) return { comando: r.comando, ok: false, detalle: "not found", ayuda: r.ayuda ?? undefined };
    const num = semver.coerce(v.replace(/^.*?(\d)/, "$1"))?.version;
    const ok = !r.version || (!!num && semver.satisfies(num, r.version));
    return { comando: r.comando, ok, detalle: num ? `${num}${ok ? "" : ` (needs ${r.version})`}` : v, ayuda: ok ? undefined : r.ayuda ?? undefined };
  });
}

function listar(dir: string, base = dir): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? listar(p, base) : [p.slice(base.length + 1)];
  });
}

/** Copy a tool folder into the project, replacing {{VARIABLES}} in paths and contents. */
export function copiarCarpeta(origen: string, destino: string, vars: Variables): string[] {
  const escritos: string[] = [];
  for (const rel of listar(origen)) {
    // npm never publishes .gitignore / .npmrc files, so the catalog stores them without the dot.
    const relDestino = render(rel.replaceAll("\\", "/"), vars).replace(/(^|\/)(gitignore|npmrc)$/, "$1.$2");
    const p = join(destino, relDestino);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, render(readFileSync(join(origen, rel), "utf8"), vars));
    escritos.push(relDestino);
  }
  return escritos;
}

/** Copy the tool scripts to the project's orqen/tools/ folder and write orqen/tools/db.json. */
export function instalarTools(proyecto: string, tool: Pick<Tool, "id" | "tools" | "db">, vars: Variables): string[] {
  const dir = join(proyecto, "orqen", "tools");
  mkdirSync(dir, { recursive: true });
  const escritos: string[] = [];
  for (const rel of tool.tools) {
    const nombre = basename(rel);
    writeFileSync(join(dir, nombre), readFileSync(join(TOOLS_DIR, rel), "utf8"));
    escritos.push(`orqen/tools/${nombre}`);
  }
  if (tool.db) {
    writeFileSync(join(dir, "db.json"), JSON.stringify({ ...tool.db, container: `${vars.PROYECTO_ID}-db` }, null, 2) + "\n");
    escritos.push("orqen/tools/db.json");
  }
  writeFileSync(join(dir, "README.md"), [
    "# orqen/tools",
    "",
    `Scripts that start this project's environments (tool \`${tool.id}\` from orqen). orqen runs them on its own`,
    "(`orqen env up`, `orqen take`); you can also run them by hand.",
    "",
    ...(tool.db ? [
      "| Command | What it does |", "|---|---|",
      `| \`node orqen/tools/db.mjs up\` | Starts ${tool.db.engine === "postgres" ? "PostgreSQL" : "SQL Server"} in Docker on port ${tool.db.port} and waits until it is ready |`,
      "| `node orqen/tools/db.mjs down` | Stops it (the data is kept) |",
      "| `node orqen/tools/db.mjs reset` | Deletes the container and its data |",
      "| `node orqen/tools/db.mjs status` | Shows whether it is running |",
      "",
      "Settings: `orqen/tools/db.json` (if you change the port, change it in `orqen/config.yaml` too).",
    ] : []),
    "",
  ].join("\n"));
  escritos.push("orqen/tools/README.md");
  return escritos;
}

/** The orqen process that runs the database tool (orqen starts it and stops the container cleanly). */
export const PROCESO_DB = {
  nombre: "db", comando: "node orqen/tools/db.mjs up", detener: "node orqen/tools/db.mjs down",
  listo_si: "orqen-db: ready", cuando: "siempre", espera_seg: 300,
} as const;
