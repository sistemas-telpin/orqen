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
    dev: opcional,
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
  servicios: z.array(Servicio).default([]),
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

/** Service catalog containing images, ports, variables, and health checks. */
export interface DefServicio {
  imagen: string; puerto: number; variables: Record<string, string>;
  healthcheck?: string[]; url?: (host: string, puerto: number) => Record<string, string>;
}

const CLAVE = "orqen";
export const CATALOGO: Record<Exclude<Servicio["tipo"], "otro">, DefServicio> = {
  postgres: {
    imagen: "postgres:17-alpine", puerto: 5432,
    variables: { POSTGRES_USER: CLAVE, POSTGRES_PASSWORD: CLAVE, POSTGRES_DB: CLAVE },
    healthcheck: ["CMD-SHELL", `pg_isready -U ${CLAVE} -d ${CLAVE}`],
    url: (h, p) => ({ DATABASE_URL: `postgresql://${CLAVE}:${CLAVE}@${h}:${p}/${CLAVE}` }),
  },
  mysql: {
    imagen: "mysql:8.4", puerto: 3306,
    variables: { MYSQL_ROOT_PASSWORD: CLAVE, MYSQL_DATABASE: CLAVE, MYSQL_USER: CLAVE, MYSQL_PASSWORD: CLAVE },
    healthcheck: ["CMD-SHELL", `mysqladmin ping -h 127.0.0.1 -u${CLAVE} -p${CLAVE} --silent`],
    url: (h, p) => ({ DATABASE_URL: `mysql://${CLAVE}:${CLAVE}@${h}:${p}/${CLAVE}` }),
  },
  mariadb: {
    imagen: "mariadb:11", puerto: 3306,
    variables: { MARIADB_ROOT_PASSWORD: CLAVE, MARIADB_DATABASE: CLAVE, MARIADB_USER: CLAVE, MARIADB_PASSWORD: CLAVE },
    healthcheck: ["CMD", "healthcheck.sh", "--connect", "--innodb_initialized"],
    url: (h, p) => ({ DATABASE_URL: `mysql://${CLAVE}:${CLAVE}@${h}:${p}/${CLAVE}` }),
  },
  sqlserver: {
    imagen: "mcr.microsoft.com/mssql/server:2022-latest", puerto: 1433,
    variables: { ACCEPT_EULA: "Y", MSSQL_SA_PASSWORD: "Orqen#2026!", MSSQL_PID: "Developer" },
    healthcheck: ["CMD-SHELL", `/opt/mssql-tools18/bin/sqlcmd -C -S localhost -U sa -P "$$MSSQL_SA_PASSWORD" -Q "SELECT 1" || exit 1`],
    url: (h, p) => ({ DATABASE_URL: `sqlserver://${h}:${p};user=sa;password=Orqen#2026!;trustServerCertificate=true` }),
  },
  oracle: {
    imagen: "gvenzl/oracle-free:23-slim", puerto: 1521,
    variables: { ORACLE_PASSWORD: CLAVE, APP_USER: CLAVE, APP_USER_PASSWORD: CLAVE },
    healthcheck: ["CMD", "healthcheck.sh"],
    url: (h, p) => ({ DATABASE_URL: `oracle://${CLAVE}:${CLAVE}@${h}:${p}/FREEPDB1` }),
  },
  mongodb: {
    imagen: "mongo:8", puerto: 27017, variables: {},
    healthcheck: ["CMD", "mongosh", "--quiet", "--eval", "db.adminCommand('ping')"],
    url: (h, p) => ({ MONGODB_URI: `mongodb://${h}:${p}/${CLAVE}` }),
  },
  redis: {
    imagen: "redis:7-alpine", puerto: 6379, variables: {},
    healthcheck: ["CMD", "redis-cli", "ping"],
    url: (h, p) => ({ REDIS_URL: `redis://${h}:${p}` }),
  },
  rabbitmq: {
    imagen: "rabbitmq:4-management-alpine", puerto: 5672, variables: {},
    healthcheck: ["CMD", "rabbitmq-diagnostics", "-q", "ping"],
    url: (h, p) => ({ AMQP_URL: `amqp://guest:guest@${h}:${p}` }),
  },
  kafka: {
    imagen: "apache/kafka:3.9.1", puerto: 9092, variables: {},
    healthcheck: ["CMD-SHELL", "/opt/kafka/bin/kafka-broker-api-versions.sh --bootstrap-server localhost:9092 > /dev/null 2>&1"],
    url: (h, p) => ({ KAFKA_BROKERS: `${h}:${p}` }),
  },
  elasticsearch: {
    imagen: "docker.elastic.co/elasticsearch/elasticsearch:8.15.3", puerto: 9200,
    variables: { "discovery.type": "single-node", "xpack.security.enabled": "false", ES_JAVA_OPTS: "-Xms512m -Xmx512m" },
    healthcheck: ["CMD-SHELL", "curl -fs http://localhost:9200/_cluster/health || exit 1"],
    url: (h, p) => ({ ELASTICSEARCH_URL: `http://${h}:${p}` }),
  },
  minio: {
    imagen: "minio/minio:latest", puerto: 9000,
    variables: { MINIO_ROOT_USER: CLAVE, MINIO_ROOT_PASSWORD: `${CLAVE}-secreto` },
    healthcheck: ["CMD", "mc", "ready", "local"],
    url: (h, p) => ({ S3_ENDPOINT: `http://${h}:${p}` }),
  },
  mailpit: {
    imagen: "axllent/mailpit:latest", puerto: 1025, variables: {},
    url: (h, p) => ({ SMTP_HOST: h, SMTP_PORT: String(p) }),
  },
};

export function defServicio(s: Servicio): DefServicio | undefined {
  return s.tipo === "otro" ? undefined : CATALOGO[s.tipo];
}

/** Host connection variables for running services. */
export function variablesHost(stack: Stack): Record<string, string> {
  const out: Record<string, string> = {};
  for (const s of stack.servicios) {
    const def = defServicio(s);
    const puerto = s.puerto ?? def?.puerto;
    if (def?.url && puerto) Object.assign(out, def.url("localhost", puerto));
  }
  return { ...out, ...stack.variables };
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
  if (stack.servicios.length)
    l.push(`Services: ${stack.servicios.map((s) => `${s.nombre} (${s.tipo})`).join(", ")}.`, "");
  const t = Object.entries(stack.tests).filter(([, v]) => v);
  if (t.length) l.push("Tests:", ...t.map(([k, v]) => `- ${k}: \`${v}\``), "");
  if (stack.notas.length) l.push("Notes:", ...stack.notas.map((n) => `- ${n}`), "");
  return l.join("\n").trim() || "_No stack detected. Fill in `orqen/config.yaml`._";
}
