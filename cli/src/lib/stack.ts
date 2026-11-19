/**
 * Project stack model populated by detection and refined by the agent.
 * Used to generate Docker Compose and repository environment commands.
 */
import { z } from "zod";

export const TIPOS_COMPONENTE = ["frontend", "backend", "fullstack", "worker", "mobile", "libreria", "otro"] as const;
export const TIPOS_SERVICIO = [
  "postgres", "mysql", "mariadb", "sqlserver", "oracle", "mongodb", "redis",
  "rabbitmq", "kafka", "elasticsearch", "minio", "mailpit", "otro",
] as const;

const opcional = z.string().min(1).nullish();

export const Componente = z.object({
  nombre: z.string().min(1).describe("Short lowercase identifier used as the Compose service name"),
  tipo: z.enum(TIPOS_COMPONENTE),
  ruta: z.string().describe("Directory relative to the repository root ('.' for the root)"),
  lenguaje: z.string().describe("e.g. typescript, java, python, csharp, go"),
  framework: opcional.describe("e.g. react+vite, next, angular, nestjs, express, spring-boot, django, fastapi, aspnet"),
  puerto: z.number().int().positive().nullish(),
  dockerfile: opcional.describe("Relative path to the Dockerfile, if present"),
  comandos: z.object({
    instalar: opcional,
    dev: opcional.describe("Command that starts it for development (npm run dev, npm start, mvn spring-boot:run…)"),
    build: opcional,
    tests: opcional,
  }).default({}),
});
export type Componente = z.infer<typeof Componente>;

export const Servicio = z.object({
  nombre: z.string().min(1).describe("Compose service name, such as db, cache, or queue"),
  tipo: z.enum(TIPOS_SERVICIO),
  imagen: opcional.describe("Docker image. Defaults to the image in the orqen catalog."),
  puerto: z.number().int().positive().nullish(),
  variables: z.record(z.string(), z.string()).default({}),
  motivo: opcional.describe("Why the service is needed, including the relevant dependency or file"),
});
export type Servicio = z.infer<typeof Servicio>;

export const Tests = z.object({
  unitarios: opcional,
  integracion: opcional,
  e2e: opcional,
  visual: opcional.describe("Visual or UI tests (e.g. Playwright screenshots)"),
});
export type Tests = z.infer<typeof Tests>;

export const Stack = z.object({
  resumen: z.string().describe("One or two sentences describing the project and its structure"),
  gestor_paquetes: opcional.describe("pnpm, npm, yarn, bun, maven, gradle, pip, poetry, uv, dotnet, go..."),
  instalar: opcional.describe("Root dependency installation command for a monorepo, replacing the per-component commands for that ecosystem"),
  componentes: z.array(Componente).default([]),
  servicios: z.array(Servicio).default([])
    .describe("What the project needs besides its code (databases, queues, caches). orqen does not install them: variables must point to them, or a process can start them"),
  tests: Tests.default({}),
  migraciones: opcional.describe("Command to apply migrations against running services"),
  seed: opcional.describe("Command to seed test data"),
  variables: z.record(z.string(), z.string()).default({})
    .describe("Variables for apps and tests connecting to services from the host (localhost)"),
  notas: z.array(z.string()).default([]).describe("Assumptions, risks, or remaining manual setup"),
});
export type Stack = z.infer<typeof Stack>;

export const stackVacio = (): Stack => Stack.parse({ resumen: "" });

export function esquemaStackJson() {
  return z.toJSONSchema(Stack, { io: "input" });
}

/** Render the stack summary for AGENTS.md and the CLI. */
export function resumenStack(stack: Stack): string {
  const l: string[] = [];
  if (stack.resumen) l.push(stack.resumen, "");
  if (stack.componentes.length) {
    l.push("| Component | Type | Path | Technology | Port |", "|---|---|---|---|---|");
    for (const c of stack.componentes)
      l.push(`| ${c.nombre} | ${c.tipo} | \`${c.ruta}\` | ${[c.lenguaje, c.framework].filter(Boolean).join(" / ")} | ${c.puerto ?? "—"} |`);
    l.push("");
  }
  const arrancan = stack.componentes.filter((c) => c.comandos.dev && ["frontend", "backend", "fullstack", "worker"].includes(c.tipo));
  if (arrancan.length) l.push("How it starts:", ...arrancan.map((c) => `- ${c.nombre}: \`${c.comandos.dev}\`${c.ruta && c.ruta !== "." ? ` (in \`${c.ruta}\`)` : ""}${c.puerto ? ` → :${c.puerto}` : ""}`), "");
  if (stack.servicios.length)
    l.push(`Needs: ${stack.servicios.map((s) => `${s.nombre} (${s.tipo})`).join(", ")}.`, "");
  const t = Object.entries(stack.tests).filter(([, v]) => v);
  if (t.length) l.push("Tests:", ...t.map(([k, v]) => `- ${k}: \`${v}\``), "");
  if (stack.notas.length) l.push("Notes:", ...stack.notas.map((n) => `- ${n}`), "");
  return l.join("\n").trim() || "_No stack detected. Fill in `orqen/environment.yaml`._";
}
