import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

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
