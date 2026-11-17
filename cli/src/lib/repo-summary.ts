/**
 * Summarize the directory tree and key stack files for quick analysis.
 * The agent receives this summary in a single prompt without using tools.
 *
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const IGNORAR = new Set([
  "node_modules", ".git", "dist", "build", "out", "target", "vendor", ".venv", "venv", "__pycache__", ".next", ".nuxt",
  ".turbo", ".gradle", ".idea", ".vscode", "obj", "coverage", "orqen", "factory", ".agents", ".claude", "lib", "libs",
  "classes", "logs", "tmp", "temp", ".cache", "screenshots", "videos",
]);

/** Files that indicate the stack, in priority order. */
const CLAVES: RegExp[] = [
  /^package\.json$/, /^pnpm-workspace\.yaml$/, /^(pom\.xml|build\.gradle(\.kts)?|settings\.gradle(\.kts)?|build\.xml)$/,
  /^(requirements.*\.txt|pyproject\.toml|Pipfile)$/, /\.csproj$/, /\.sln$/, /^go\.mod$/, /^composer\.json$/, /^Gemfile$/, /^Cargo\.toml$/,
  /^(docker-)?compose.*\.ya?ml$/, /^Dockerfile(\..+)?$/, /^\.env\.(example|sample|template)$/,
  /^(playwright|cypress|jest|vitest|karma)\.config\.[cm]?[jt]s$/, /^cypress\.json$/,
  /^schema\.prisma$/, /^(application|bootstrap)(-[\w]+)?\.(properties|ya?ml)$/, /^(persistence|hibernate\.cfg|context|web)\.xml$/,
  /^(appsettings(\.\w+)?\.json|settings\.py|database\.yml)$/,
  /^(\.gitlab-ci\.yml|Jenkinsfile|azure-pipelines\.yml|bitbucket-pipelines\.yml|Makefile)$/,
  /^README(\.md|\.txt)?$/i,
];

const MAX_ARBOL = 350;         // entries
const MAX_ARCHIVO = 2500;      // characters per file
const MAX_TOTAL = 45_000;      // total content characters
const PROFUNDIDAD_ARBOL = 3;
const PROFUNDIDAD_CLAVES = 5;

export interface ResumenRepo { arbol: string; archivos: { ruta: string; contenido: string }[] }

export function resumirRepo(repo: string): ResumenRepo {
  const arbol: string[] = [];
  const candidatos: { ruta: string; prioridad: number; nivel: number }[] = [];
  const recorrer = (dir: string, nivel: number) => {
    let entradas: string[] = [];
    try { entradas = readdirSync(dir).sort(); } catch { return; }
    let archivosMostrados = 0;
    for (const e of entradas) {
      const p = join(dir, e), rel = relative(repo, p).replaceAll("\\", "/");
      let st; try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) {
        if (IGNORAR.has(e) || (e.startsWith(".") && e !== ".github")) continue;
        if (nivel < PROFUNDIDAD_ARBOL && arbol.length < MAX_ARBOL) arbol.push(`${"  ".repeat(nivel)}${e}/`);
        if (nivel < PROFUNDIDAD_CLAVES) recorrer(p, nivel + 1);
      } else {
        const prioridad = CLAVES.findIndex((re) => re.test(e));
        const workflow = rel.startsWith(".github/workflows/");
        if ((prioridad >= 0 || workflow) && st.size < 400_000) candidatos.push({ ruta: rel, prioridad: workflow ? CLAVES.length : prioridad, nivel });
        if (nivel <= PROFUNDIDAD_ARBOL && arbol.length < MAX_ARBOL && archivosMostrados < 12) {
          arbol.push(`${"  ".repeat(nivel)}${e}`);
          archivosMostrados++;
        }
      }
    }
  };
  recorrer(repo, 0);

  // Prefer files closest to the root, then use file type priority.
  candidatos.sort((a, b) => a.nivel - b.nivel || a.prioridad - b.prioridad || a.ruta.localeCompare(b.ruta));
  const archivos: ResumenRepo["archivos"] = [];
  let total = 0;
  for (const c of candidatos) {
    if (total >= MAX_TOTAL || archivos.length >= 40) break;
    let t = "";
    try { t = readFileSync(join(repo, c.ruta), "utf8"); } catch { continue; }
    if (/\u0000/.test(t.slice(0, 1000))) continue;
    if (/package\.json$/.test(c.ruta)) t = compactarPackage(t);
    const tope = /README/i.test(c.ruta) ? 1500 : MAX_ARCHIVO;
    const recorte = t.length > tope ? t.slice(0, tope) + `\n… (truncated from ${t.length} characters)` : t;
    archivos.push({ ruta: c.ruta, contenido: recorte });
    total += recorte.length;
  }
  return { arbol: arbol.join("\n"), archivos };
}

/** Keep only the name, scripts, dependencies, and workspaces from package.json. */
function compactarPackage(t: string): string {
  try {
    const j = JSON.parse(t);
    const dep = (o: any) => (o ? Object.keys(o).join(", ") : undefined);
    return JSON.stringify({
      name: j.name, packageManager: j.packageManager, workspaces: j.workspaces, scripts: j.scripts,
      dependencies: dep(j.dependencies), devDependencies: dep(j.devDependencies),
    }, null, 1);
  } catch { return t; }
}

export function resumenComoTexto(r: ResumenRepo): string {
  return [
    "Repository tree (truncated):", "```", r.arbol, "```", "",
    "Key files:",
    ...r.archivos.flatMap((a) => [`--- ${a.ruta} ---`, a.contenido, ""]),
  ].join("\n");
}
