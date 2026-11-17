/**
 * Genera docker-compose.orqen.yml a partir del stack:
 *  - servicios (DB, colas, caches...) siempre, con healthcheck para que `up --wait` sepa cuándo están listos;
 *  - apps (componentes con puerto) bajo el perfil "apps": se levantan para e2e / visual, conectadas a los servicios.
 */
import { stringify } from "yaml";
import { defServicio, type Componente, type Stack } from "./stack.ts";

export const ARCHIVO_COMPOSE = "docker-compose.orqen.yml";
export const PERFIL_APPS = "apps";

const IMAGEN_POR_LENGUAJE: Record<string, string> = {
  typescript: "node:22-alpine", javascript: "node:22-alpine",
  python: "python:3.12-slim", java: "eclipse-temurin:21-jdk", kotlin: "eclipse-temurin:21-jdk",
  go: "golang:1.23", csharp: "mcr.microsoft.com/dotnet/sdk:8.0", php: "php:8.3-cli", ruby: "ruby:3.3",
};

function serviciosCompose(stack: Stack) {
  const out: Record<string, any> = {};
  for (const s of stack.servicios) {
    const def = defServicio(s);
    const imagen = s.imagen ?? def?.imagen;
    if (!imagen) continue;
    const puerto = s.puerto ?? def?.puerto;
    const svc: Record<string, any> = { image: imagen };
    const env = { ...def?.variables, ...s.variables };
    if (Object.keys(env).length) svc.environment = env;
    if (puerto) svc.ports = [`${puerto}:${def?.puerto ?? puerto}`];
    if (s.tipo === "kafka") svc.environment = {
      KAFKA_NODE_ID: "1", KAFKA_PROCESS_ROLES: "broker,controller",
      KAFKA_LISTENERS: "PLAINTEXT://:9092,CONTROLLER://:9093",
      KAFKA_ADVERTISED_LISTENERS: `PLAINTEXT://localhost:${puerto ?? 9092}`,
      KAFKA_CONTROLLER_LISTENER_NAMES: "CONTROLLER", KAFKA_CONTROLLER_QUORUM_VOTERS: "1@localhost:9093",
      KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: "1", ...s.variables,
    };
    if (s.tipo === "minio") svc.command = "server /data --console-address :9001";
    if (def?.healthcheck) svc.healthcheck = { test: def.healthcheck, interval: "5s", timeout: "5s", retries: 30, start_period: "10s" };
    out[s.nombre] = svc;
  }
  return out;
}

/** Variables que ve una app dentro de la red de compose (host = nombre del servicio). */
function variablesInternas(stack: Stack): Record<string, string> {
  const out: Record<string, string> = {};
  for (const s of stack.servicios) {
    const def = defServicio(s);
    if (def?.url) Object.assign(out, def.url(s.nombre, def.puerto));
  }
  return out;
}

function appCompose(c: Componente, stack: Stack, dependencias: string[]) {
  const svc: Record<string, any> = { profiles: [PERFIL_APPS] };
  if (c.dockerfile) {
    const ctx = c.ruta === "." ? "." : `./${c.ruta}`;
    const df = c.ruta === "." ? c.dockerfile : c.dockerfile.replace(new RegExp(`^${c.ruta}/`), "");
    svc.build = { context: ctx, dockerfile: df };
  } else {
    const imagen = IMAGEN_POR_LENGUAJE[c.lenguaje];
    if (!imagen || !c.comandos.dev) return undefined;
    const node = imagen.startsWith("node");
    svc.image = imagen;
    svc.working_dir = "/app";
    svc.volumes = [`./${c.ruta === "." ? "" : c.ruta}:/app`.replace(/\/:/, ":"), ...(node ? ["/app/node_modules"] : [])];
    const instalar = c.comandos.instalar ? `${c.comandos.instalar} && ` : "";
    svc.command = ["sh", "-c", `${node ? "corepack enable && " : ""}${instalar}${c.comandos.dev}`];
  }
  if (c.puerto) {
    svc.ports = [`${c.puerto}:${c.puerto}`];
    svc.environment = { PORT: String(c.puerto), HOST: "0.0.0.0", ...variablesInternas(stack) };
  } else if (stack.servicios.length) svc.environment = variablesInternas(stack);
  if (dependencias.length) svc.depends_on = Object.fromEntries(dependencias.map((d) => [d, { condition: "service_healthy" }]));
  return svc;
}

export function generarCompose(stack: Stack, nombreProyecto: string): string {
  const services: Record<string, any> = serviciosCompose(stack);
  const conHealth = Object.entries(services).filter(([, s]) => s.healthcheck).map(([n]) => n);
  const sinApp: string[] = [];
  for (const c of stack.componentes) {
    if (!["frontend", "backend", "fullstack", "worker"].includes(c.tipo)) continue;
    const svc = appCompose(c, stack, conHealth);
    if (svc && !services[c.nombre]) services[c.nombre] = svc;
    else if (!svc) sinApp.push(c.nombre);
  }
  const cabecera = [
    "# Generado por `orqen init`. Entornos para que los agentes corran el proyecto y sus tests sin intervención.",
    "#   orqen entorno levantar            → servicios (DB, colas...) con healthcheck",
    `#   orqen entorno levantar --apps     → además las apps (perfil "${PERFIL_APPS}"), para e2e / visual`,
    "# Podés editarlo: `orqen update` no lo pisa sin preguntarte.",
    ...(sinApp.length ? [`# Sin contenedor (se corren en la máquina): ${sinApp.join(", ")}`] : []),
    "",
  ].join("\n");
  if (!Object.keys(services).length) return cabecera + `name: ${nombreProyecto}\nservices: {}\n`;
  return cabecera + stringify({ name: nombreProyecto, services }, { lineWidth: 0 });
}
