import assert from "node:assert/strict";
import { test } from "node:test";
import { parse } from "yaml";
import { generarCompose } from "../src/lib/compose.ts";
import { entornosDesdeStack } from "../src/lib/config.ts";
import { detectar } from "../src/lib/detect.ts";
import { MONOREPO, repoTemporal } from "./helpers.ts";

test("detects components, services, and tests in a Node monorepo", () => {
  const { stack, evidencias } = detectar(repoTemporal(MONOREPO));
  const nombres = stack.componentes.map((c) => c.nombre).sort();
  assert.deepEqual(nombres, ["api", "web"]);
  const web = stack.componentes.find((c) => c.nombre === "web")!;
  assert.equal(web.tipo, "frontend");
  assert.equal(web.framework, "react+vite");
  assert.equal(web.comandos.dev, "pnpm dev");
  const api = stack.componentes.find((c) => c.nombre === "api")!;
  assert.equal(api.framework, "nestjs");
  assert.equal(api.dockerfile, "apps/api/Dockerfile");
  assert.deepEqual(stack.servicios.map((s) => s.tipo).sort(), ["postgres", "redis"]);
  assert.equal(stack.migraciones, "npx prisma migrate deploy");
  assert.equal(stack.tests.e2e, "pnpm exec playwright test");
  assert.equal(stack.tests.visual, "pnpm exec playwright test --grep @visual");
  assert.equal(stack.tests.unitarios, "pnpm test", "uses the root test script");
  assert.equal(stack.instalar, "pnpm install");
  assert.ok(evidencias.some((e) => e.includes("schema.prisma")));
});

test("runs component test scripts from the root when the root has no test script", () => {
  const raiz = { ...(MONOREPO["package.json"] as object), scripts: {} };
  const { stack } = detectar(repoTemporal({ ...MONOREPO, "package.json": raiz }));
  assert.equal(stack.tests.unitarios, "pnpm --dir apps/api test && pnpm --dir apps/web test");
  const e = entornosDesdeStack(stack);
  assert.deepEqual(e.preparar, ["pnpm install"], "a root install is enough for a Node monorepo");
});

test("detects Spring Boot, PostgreSQL, and existing Compose services", () => {
  const repo = repoTemporal({
    "pom.xml": `<project><dependencies>
      <dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-web</artifactId></dependency>
      <dependency><groupId>org.postgresql</groupId><artifactId>postgresql</artifactId></dependency>
    </dependencies></project>`,
    "mvnw": "#!/bin/sh\n",
    "docker-compose.yml": "services:\n  cola:\n    image: rabbitmq:3-management\n    ports: ['5672:5672']\n",
  });
  const { stack } = detectar(repo);
  assert.equal(stack.componentes[0].framework, "spring-boot");
  assert.equal(stack.componentes[0].comandos.tests, "./mvnw -B test");
  assert.deepEqual(stack.servicios.map((s) => `${s.nombre}:${s.tipo}`).sort(), ["cola:rabbitmq", "db:postgres"]);
});

test("detects an empty stack for an empty repository", () => {
  const { stack } = detectar(repoTemporal({ "README.md": "hola" }));
  assert.equal(stack.componentes.length, 0);
  assert.equal(stack.servicios.length, 0);
});

test("Compose services have health checks and apps use the apps profile", () => {
  const { stack } = detectar(repoTemporal(MONOREPO));
  const doc = parse(generarCompose(stack, "orqen-pagos"));
  assert.equal(doc.name, "orqen-pagos");
  assert.equal(doc.services.db.image, "postgres:17-alpine");
  assert.ok(doc.services.db.healthcheck.test.join(" ").includes("pg_isready"));
  assert.ok(doc.services.cache.healthcheck);
  assert.deepEqual(doc.services.api.profiles, ["apps"]);
  assert.deepEqual(doc.services.api.build, { context: "./apps/api", dockerfile: "Dockerfile" });
  assert.equal(doc.services.api.depends_on.db.condition, "service_healthy");
  assert.equal(doc.services.api.environment.DATABASE_URL, "postgresql://orqen:orqen@db:5432/orqen");
  assert.equal(doc.services.web.image, "node:22-alpine");
  assert.deepEqual(doc.services.web.volumes, ["./apps/web:/app", "/app/node_modules"]);

  const e = entornosDesdeStack(stack);
  assert.equal(e.variables.DATABASE_URL, "postgresql://orqen:orqen@localhost:5432/orqen");
  assert.equal(e.variables.REDIS_URL, "redis://localhost:6379");
  assert.deepEqual(e.migrar, ["npx prisma migrate deploy"]);
});
