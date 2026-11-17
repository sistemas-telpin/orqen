import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { stringify } from "yaml";

/** Create a temporary repository from a path-to-content map. Serialize objects as JSON. */
export function repoTemporal(archivos: Record<string, string | object> = {}, git = true): string {
  const dir = mkdtempSync(join(tmpdir(), "orqen-test-"));
  for (const [ruta, c] of Object.entries(archivos)) {
    const p = join(dir, ruta);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, typeof c === "string" ? c : JSON.stringify(c, null, 2));
  }
  if (git) execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  return dir;
}

/** Example monorepo with React and Vite, a NestJS API, PostgreSQL via Prisma, Redis, and Playwright. */
export const MONOREPO = {
  "package.json": { name: "pagos", private: true, workspaces: ["apps/*"], devDependencies: { "@playwright/test": "^1.50.0" }, scripts: { test: "pnpm -r test" } },
  "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
  "pnpm-workspace.yaml": "packages:\n  - apps/*\n",
  "apps/web/package.json": { name: "web", scripts: { dev: "vite", build: "vite build", test: "vitest run" }, dependencies: { react: "^19.0.0" }, devDependencies: { vite: "^6.0.0", vitest: "^3.0.0", typescript: "^5.0.0" } },
  "apps/api/package.json": { name: "api", scripts: { start: "nest start", test: "jest" }, dependencies: { "@nestjs/core": "^11.0.0", "@prisma/client": "^6.0.0", ioredis: "^5.0.0" }, devDependencies: { prisma: "^6.0.0", jest: "^29.0.0" } },
  "apps/api/prisma/schema.prisma": 'datasource db {\n  provider = "postgresql"\n  url = env("DATABASE_URL")\n}\n',
  "apps/api/Dockerfile": "FROM node:22-alpine\n",
  "e2e/visual.spec.ts": "test('home', async ({ page }) => { await expect(page).toHaveScreenshot(); });\n",
  "README.md": "# Plataforma de Pagos\n",
};

/** A synthetic catalog: public CLI tests never depend on an organization's stacks. */
export function catalogoTemporal(): string {
  const tool = {
    id: "example", nombre: "Example stack", descripcion: "Synthetic test catalog",
    parametros: [{ id: "PORT", pregunta: "Port", tipo: "puerto", defecto: 4567 }],
    scaffold: [{ copiar: "scaffold" }], tools: ["_shared/db.mjs"],
    db: { engine: "postgres", port: 5432, database: "{{PROYECTO_ID}}", user: "app", password: "{{DB_PASSWORD}}" },
    stack: { resumen: "Example {{PROYECTO}}", componentes: [], servicios: [] },
    entornos: { procesos: [], tests: { unitarios: "node --test" } },
  };
  const dir = repoTemporal({
    "example/tool.yaml": stringify(tool),
    "example/scaffold/README.md": "# {{PROYECTO}}\nPort: {{PORT}}\n",
    "example/scaffold/gitignore": "node_modules/\n",
    "_shared/db.mjs": "// Synthetic database script for CLI installation tests.\n",
  });
  execFileSync("git", ["-c", "core.autocrlf=false", "add", "."], { cwd: dir });
  execFileSync("git", ["-c", "user.name=orqen-test", "-c", "user.email=test@example.com", "commit", "-qm", "Synthetic catalog"], { cwd: dir });
  execFileSync("git", ["remote", "add", "origin", "https://github.com/example/catalog.git"], { cwd: dir });
  return dir;
}
