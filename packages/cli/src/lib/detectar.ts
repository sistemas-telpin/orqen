/**
 * Detección determinística del stack: recorre el repo (hasta 3 niveles) y lee manifiestos conocidos.
 * No adivina: lo que no puede deducir de los archivos lo deja vacío para que lo complete el agente o la persona.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { parse as parseYaml } from "yaml";
import { Stack, type Componente, type Servicio } from "./stack.ts";

const IGNORAR = new Set([
  "node_modules", ".git", "dist", "build", "out", "target", "vendor", ".venv", "venv", "__pycache__",
  ".next", ".nuxt", ".turbo", ".gradle", ".idea", ".vscode", "bin", "obj", "coverage", ".orqen", "openspec", "factory",
]);
const PROFUNDIDAD = 3;

export interface Deteccion { stack: Stack; evidencias: string[] }

const leer = (p: string) => { try { return readFileSync(p, "utf8"); } catch { return ""; } };
const json = (p: string): any => { try { return JSON.parse(leer(p)); } catch { return {}; } };
const norm = (p: string) => (p || ".").replaceAll("\\", "/");
const nombreDe = (repo: string, dir: string) =>
  (relative(repo, dir) ? basename(dir) : basename(repo)).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "app";

function carpetas(repo: string): string[] {
  const out: string[] = [];
  const recorrer = (d: string, n: number) => {
    out.push(d);
    if (n >= PROFUNDIDAD) return;
    let entradas: string[] = [];
    try { entradas = readdirSync(d); } catch { return; }
    for (const e of entradas) {
      if (IGNORAR.has(e) || e.startsWith(".")) continue;
      const p = join(d, e);
      try { if (statSync(p).isDirectory()) recorrer(p, n + 1); } catch { /* sin permisos */ }
    }
  };
  recorrer(repo, 0);
  return out;
}

/** Dependencias (de cualquier ecosistema) que delatan un servicio. */
const PISTAS_SERVICIO: [RegExp, Servicio["tipo"]][] = [
  [/^(pg|postgres|pg-promise|@neondatabase\/serverless|psycopg2?(-binary)?|psycopg|asyncpg|org\.postgresql:postgresql|npgsql(\.entityframeworkcore\.postgresql)?|github\.com\/lib\/pq|github\.com\/jackc\/pgx(\/v\d+)?)$/i, "postgres"],
  [/^(mysql2?|pymysql|mysqlclient|com\.mysql:mysql-connector-j|mysql:mysql-connector-java|github\.com\/go-sql-driver\/mysql|mysql\.data|mysqlconnector)$/i, "mysql"],
  [/^(mariadb|org\.mariadb\.jdbc:mariadb-java-client)$/i, "mariadb"],
  [/^(mssql|tedious|pyodbc|com\.microsoft\.sqlserver:mssql-jdbc|microsoft\.data\.sqlclient|microsoft\.entityframeworkcore\.sqlserver)$/i, "sqlserver"],
  [/^(oracledb|cx_oracle|com\.oracle\.database\.jdbc:ojdbc\d+|oracle\.manageddataaccess(\.core)?)$/i, "oracle"],
  [/^(mongodb|mongoose|pymongo|motor|org\.mongodb:.*|go\.mongodb\.org\/mongo-driver|mongodb\.driver)$/i, "mongodb"],
  [/^(redis|ioredis|@redis\/client|bullmq|bull|org\.springframework\.boot:spring-boot-starter-data-redis|stackexchange\.redis|github\.com\/redis\/go-redis.*)$/i, "redis"],
  [/^(amqplib|amqp-connection-manager|pika|aio-pika|org\.springframework\.boot:spring-boot-starter-amqp|rabbitmq\.client|masstransit\.rabbitmq)$/i, "rabbitmq"],
  [/^(kafkajs|kafka-python|confluent-kafka|org\.springframework\.kafka:spring-kafka|confluent\.kafka|github\.com\/segmentio\/kafka-go)$/i, "kafka"],
  [/^(@elastic\/elasticsearch|elasticsearch|org\.springframework\.boot:spring-boot-starter-data-elasticsearch|nest\.?elasticsearch)$/i, "elasticsearch"],
  [/^(minio|@aws-sdk\/client-s3|boto3)$/i, "minio"],
  [/^(nodemailer)$/i, "mailpit"],
];

function servicioPorDependencia(dep: string): Servicio["tipo"] | undefined {
  for (const [re, tipo] of PISTAS_SERVICIO) if (re.test(dep)) return tipo;
  return undefined;
}

function servicioPorImagen(imagen: string): Servicio["tipo"] | undefined {
  const i = imagen.toLowerCase();
  const mapa: [string, Servicio["tipo"]][] = [
    ["postgres", "postgres"], ["postgis", "postgres"], ["mariadb", "mariadb"], ["mysql", "mysql"], ["mssql", "sqlserver"],
    ["oracle", "oracle"], ["mongo", "mongodb"], ["redis", "redis"], ["valkey", "redis"], ["rabbitmq", "rabbitmq"],
    ["kafka", "kafka"], ["redpanda", "kafka"], ["elasticsearch", "elasticsearch"], ["opensearch", "elasticsearch"],
    ["minio", "minio"], ["mailpit", "mailpit"], ["mailhog", "mailpit"],
  ];
  return mapa.find(([k]) => i.includes(k))?.[1];
}

/** ---------- Node / JS ---------- */
function detectarNode(repo: string, dir: string, ev: string[], deps: Set<string>): Componente | undefined {
  const pkg = json(join(dir, "package.json"));
  const todas = { ...pkg.dependencies, ...pkg.devDependencies } as Record<string, string>;
  Object.keys(todas).forEach((d) => deps.add(d));
  const tiene = (...n: string[]) => n.some((x) => x in todas);
  const esRaizMonorepo = !!pkg.workspaces || existsSync(join(dir, "pnpm-workspace.yaml"));
  const scripts = (pkg.scripts ?? {}) as Record<string, string>;
  if (esRaizMonorepo && !tiene("next", "vite", "react", "express", "@nestjs/core", "fastify")) return undefined;

  let framework: string | undefined, tipo: Componente["tipo"] = "libreria", puerto: number | undefined;
  if (tiene("next")) { framework = "next"; tipo = "fullstack"; puerto = 3000; }
  else if (tiene("nuxt")) { framework = "nuxt"; tipo = "fullstack"; puerto = 3000; }
  else if (tiene("@remix-run/react", "@react-router/dev")) { framework = "react-router"; tipo = "fullstack"; puerto = 3000; }
  else if (tiene("astro")) { framework = "astro"; tipo = "frontend"; puerto = 4321; }
  else if (tiene("@angular/core")) { framework = "angular"; tipo = "frontend"; puerto = 4200; }
  else if (tiene("@sveltejs/kit")) { framework = "sveltekit"; tipo = "fullstack"; puerto = 5173; }
  else if (tiene("vite") && tiene("react", "vue", "svelte", "solid-js", "preact")) {
    framework = `${["react", "vue", "svelte", "solid-js", "preact"].find((x) => tiene(x))}+vite`; tipo = "frontend"; puerto = 5173;
  } else if (tiene("react-native", "expo")) { framework = tiene("expo") ? "expo" : "react-native"; tipo = "mobile"; }
  else if (tiene("@nestjs/core")) { framework = "nestjs"; tipo = "backend"; puerto = 3000; }
  else if (tiene("fastify")) { framework = "fastify"; tipo = "backend"; puerto = 3000; }
  else if (tiene("hono")) { framework = "hono"; tipo = "backend"; puerto = 3000; }
  else if (tiene("koa")) { framework = "koa"; tipo = "backend"; puerto = 3000; }
  else if (tiene("express")) { framework = "express"; tipo = "backend"; puerto = 3000; }
  else if (tiene("bullmq", "kafkajs", "amqplib") && !scripts.dev) tipo = "worker";
  else if (scripts.start || scripts.dev) tipo = "otro";

  const pm = gestorNode(repo, dir);
  const run = (s: string) => (pm === "npm" ? `npm run ${s}` : `${pm} ${s}`);
  ev.push(`${norm(relative(repo, join(dir, "package.json")))}: ${framework ?? tipo}`);
  return {
    nombre: nombreDe(repo, dir), tipo, ruta: norm(relative(repo, dir)),
    lenguaje: tiene("typescript") || existsSync(join(dir, "tsconfig.json")) ? "typescript" : "javascript",
    framework, puerto,
    dockerfile: existsSync(join(dir, "Dockerfile")) ? norm(relative(repo, join(dir, "Dockerfile"))) : undefined,
    comandos: {
      instalar: pm === "npm" ? (existsSync(join(dir, "package-lock.json")) ? "npm ci" : "npm install") : `${pm} install`,
      dev: scripts.dev ? run("dev") : scripts.start ? run("start") : undefined,
      build: scripts.build ? run("build") : undefined,
      tests: scripts.test && !/no test specified/.test(scripts.test) ? run("test") : undefined,
    },
  };
}

export function gestorNode(repo: string, dir = repo): "pnpm" | "yarn" | "bun" | "npm" {
  for (const d of [dir, repo]) {
    if (existsSync(join(d, "pnpm-lock.yaml"))) return "pnpm";
    if (existsSync(join(d, "yarn.lock"))) return "yarn";
    if (existsSync(join(d, "bun.lockb")) || existsSync(join(d, "bun.lock"))) return "bun";
    if (existsSync(join(d, "package-lock.json"))) return "npm";
  }
  const pm = String(json(join(repo, "package.json")).packageManager ?? "");
  if (pm.startsWith("pnpm")) return "pnpm";
  if (pm.startsWith("yarn")) return "yarn";
  return "npm";
}

/** ---------- Java ---------- */
function detectarJava(repo: string, dir: string, ev: string[], deps: Set<string>): Componente | undefined {
  const pom = leer(join(dir, "pom.xml"));
  const gradle = leer(join(dir, "build.gradle")) + leer(join(dir, "build.gradle.kts"));
  if (!pom && !gradle) return undefined;
  for (const m of pom.matchAll(/<groupId>([^<]+)<\/groupId>\s*<artifactId>([^<]+)<\/artifactId>/g)) deps.add(`${m[1]}:${m[2]}`);
  for (const m of gradle.matchAll(/["']([\w.-]+:[\w.-]+)(?::[^"']*)?["']/g)) deps.add(m[1]);
  const spring = /spring-boot/.test(pom + gradle);
  const maven = !!pom, wrapper = existsSync(join(dir, maven ? "mvnw" : "gradlew"));
  const cmd = maven ? (wrapper ? "./mvnw" : "mvn") : (wrapper ? "./gradlew" : "gradle");
  ev.push(`${norm(relative(repo, dir))}/${maven ? "pom.xml" : "build.gradle"}: ${spring ? "spring-boot" : "java"}`);
  return {
    nombre: nombreDe(repo, dir), tipo: spring ? "backend" : "libreria", ruta: norm(relative(repo, dir)),
    lenguaje: /kotlin/.test(pom + gradle) ? "kotlin" : "java", framework: spring ? "spring-boot" : undefined,
    puerto: spring ? 8080 : undefined,
    dockerfile: existsSync(join(dir, "Dockerfile")) ? norm(relative(repo, join(dir, "Dockerfile"))) : undefined,
    comandos: maven
      ? { instalar: `${cmd} -B -DskipTests dependency:go-offline`, dev: spring ? `${cmd} spring-boot:run` : undefined, build: `${cmd} -B package -DskipTests`, tests: `${cmd} -B test` }
      : { instalar: `${cmd} dependencies`, dev: spring ? `${cmd} bootRun` : undefined, build: `${cmd} build -x test`, tests: `${cmd} test` },
  };
}

/** ---------- Python ---------- */
function detectarPython(repo: string, dir: string, ev: string[], deps: Set<string>): Componente | undefined {
  const req = leer(join(dir, "requirements.txt")), pyproject = leer(join(dir, "pyproject.toml"));
  if (!req && !pyproject) return undefined;
  for (const l of req.split(/\r?\n/)) { const m = l.trim().match(/^([A-Za-z0-9_.\-]+)/); if (m) deps.add(m[1].toLowerCase()); }
  for (const m of pyproject.matchAll(/^\s*["']?([A-Za-z0-9_.\-]+)\s*(?:[<>=~!^"'\[]|$)/gm)) deps.add(m[1].toLowerCase());
  const t = (req + pyproject).toLowerCase();
  const framework = t.includes("django") ? "django" : t.includes("fastapi") ? "fastapi" : t.includes("flask") ? "flask" : undefined;
  const pm = existsSync(join(dir, "uv.lock")) ? "uv" : existsSync(join(dir, "poetry.lock")) ? "poetry" : "pip";
  const pre = pm === "uv" ? "uv run " : pm === "poetry" ? "poetry run " : "";
  ev.push(`${norm(relative(repo, dir))}/${req ? "requirements.txt" : "pyproject.toml"}: ${framework ?? "python"}`);
  return {
    nombre: nombreDe(repo, dir), tipo: framework ? "backend" : "libreria", ruta: norm(relative(repo, dir)),
    lenguaje: "python", framework, puerto: framework === "django" ? 8000 : framework === "fastapi" ? 8000 : framework === "flask" ? 5000 : undefined,
    dockerfile: existsSync(join(dir, "Dockerfile")) ? norm(relative(repo, join(dir, "Dockerfile"))) : undefined,
    comandos: {
      instalar: pm === "uv" ? "uv sync" : pm === "poetry" ? "poetry install" : req ? "pip install -r requirements.txt" : "pip install -e .",
      dev: framework === "django" ? `${pre}python manage.py runserver 0.0.0.0:8000`
        : framework === "fastapi" ? `${pre}uvicorn main:app --reload --host 0.0.0.0` : framework === "flask" ? `${pre}flask run --host 0.0.0.0` : undefined,
      tests: t.includes("pytest") ? `${pre}pytest` : framework === "django" ? `${pre}python manage.py test` : undefined,
    },
  };
}

/** ---------- .NET, Go, PHP, Ruby ---------- */
function detectarOtros(repo: string, dir: string, ev: string[], deps: Set<string>): Componente | undefined {
  const archivos = (() => { try { return readdirSync(dir); } catch { return []; } })();
  const ruta = norm(relative(repo, dir));
  const dockerfile = archivos.includes("Dockerfile") ? norm(relative(repo, join(dir, "Dockerfile"))) : undefined;
  const csproj = archivos.find((f) => f.endsWith(".csproj"));
  if (csproj) {
    const x = leer(join(dir, csproj));
    for (const m of x.matchAll(/PackageReference Include="([^"]+)"/g)) deps.add(m[1].toLowerCase());
    const web = /Microsoft\.NET\.Sdk\.Web/.test(x), test = /Microsoft\.NET\.Test\.Sdk/.test(x);
    ev.push(`${ruta}/${csproj}: ${web ? "aspnet" : test ? "tests .NET" : ".NET"}`);
    if (test) return undefined;
    return { nombre: nombreDe(repo, dir), tipo: web ? "backend" : "libreria", ruta, lenguaje: "csharp", framework: web ? "aspnet" : undefined,
      puerto: web ? 8080 : undefined, dockerfile, comandos: { instalar: "dotnet restore", dev: web ? "dotnet watch run" : undefined, build: "dotnet build", tests: "dotnet test" } };
  }
  if (archivos.includes("go.mod")) {
    const x = leer(join(dir, "go.mod"));
    for (const m of x.matchAll(/^\s*([\w.\-/]+)\s+v[\d.]+/gm)) deps.add(m[1]);
    const fw = ["gin-gonic/gin", "labstack/echo", "gofiber/fiber", "go-chi/chi"].find((f) => x.includes(f));
    ev.push(`${ruta}/go.mod: ${fw ?? "go"}`);
    return { nombre: nombreDe(repo, dir), tipo: fw ? "backend" : "otro", ruta, lenguaje: "go", framework: fw?.split("/")[1], puerto: fw ? 8080 : undefined,
      dockerfile, comandos: { instalar: "go mod download", dev: "go run .", build: "go build ./...", tests: "go test ./..." } };
  }
  if (archivos.includes("composer.json")) {
    const c = json(join(dir, "composer.json")); const r = { ...c.require, ...c["require-dev"] };
    Object.keys(r).forEach((d) => deps.add(d));
    const laravel = "laravel/framework" in r;
    ev.push(`${ruta}/composer.json: ${laravel ? "laravel" : "php"}`);
    return { nombre: nombreDe(repo, dir), tipo: "backend", ruta, lenguaje: "php", framework: laravel ? "laravel" : undefined, puerto: 8000, dockerfile,
      comandos: { instalar: "composer install", dev: laravel ? "php artisan serve --host 0.0.0.0" : undefined, tests: laravel ? "php artisan test" : "vendor/bin/phpunit" } };
  }
  if (archivos.includes("Gemfile")) {
    const g = leer(join(dir, "Gemfile"));
    for (const m of g.matchAll(/gem ["']([^"']+)["']/g)) deps.add(m[1]);
    const rails = /gem ["']rails["']/.test(g);
    ev.push(`${ruta}/Gemfile: ${rails ? "rails" : "ruby"}`);
    return { nombre: nombreDe(repo, dir), tipo: rails ? "backend" : "libreria", ruta, lenguaje: "ruby", framework: rails ? "rails" : undefined, puerto: rails ? 3000 : undefined,
      dockerfile, comandos: { instalar: "bundle install", dev: rails ? "bin/rails server -b 0.0.0.0" : undefined, tests: rails ? "bin/rails test" : "bundle exec rspec" } };
  }
  return undefined;
}

/** Servicios declarados en docker-compose existentes. */
function serviciosDeCompose(repo: string, ev: string[]): Servicio[] {
  const out: Servicio[] = [];
  for (const f of ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml", "docker-compose.dev.yml"]) {
    const t = leer(join(repo, f));
    if (!t) continue;
    let doc: any;
    try { doc = parseYaml(t); } catch { continue; }
    for (const [nombre, s] of Object.entries<any>(doc?.services ?? {})) {
      const tipo = s?.image ? servicioPorImagen(String(s.image)) : undefined;
      if (!tipo) continue;
      const puerto = Number(String((s.ports ?? [])[0] ?? "").split(":").pop()?.split("/")[0]) || undefined;
      const env = Array.isArray(s.environment)
        ? Object.fromEntries(s.environment.map((e: string) => e.split("=")).map(([k, ...v]: string[]) => [k, v.join("=")]))
        : (s.environment ?? {});
      out.push({ nombre, tipo, imagen: String(s.image), puerto, variables: Object.fromEntries(Object.entries(env).map(([k, v]) => [k, String(v)])), motivo: `declarado en ${f}` });
      ev.push(`${f}: servicio ${nombre} (${tipo})`);
    }
  }
  return out;
}

/** Proveedor de Prisma (schema.prisma) — más fiable que la dependencia. */
function prisma(dirs: string[], deps: Set<string>, ev: string[], repo: string) {
  for (const d of dirs) {
    const p = join(d, "prisma", "schema.prisma");
    const t = leer(p);
    const m = t.match(/provider\s*=\s*"(postgresql|mysql|sqlserver|mongodb|sqlite)"/);
    if (m) {
      deps.add({ postgresql: "pg", mysql: "mysql2", sqlserver: "mssql", mongodb: "mongodb", sqlite: "" }[m[1]] ?? "");
      ev.push(`${norm(relative(repo, p))}: provider ${m[1]}`);
      return { migraciones: "npx prisma migrate deploy", seed: /"seed"/.test(leer(join(d, "package.json"))) ? "npx prisma db seed" : undefined };
    }
  }
  return {};
}

export function detectar(repo: string): Deteccion {
  const ev: string[] = [];
  const deps = new Set<string>();
  const dirs = carpetas(repo);
  const componentes: Componente[] = [];
  for (const d of dirs) {
    const c = (existsSync(join(d, "package.json")) ? detectarNode(repo, d, ev, deps) : undefined)
      ?? detectarJava(repo, d, ev, deps) ?? detectarPython(repo, d, ev, deps) ?? detectarOtros(repo, d, ev, deps);
    if (c && !componentes.some((x) => x.nombre === c.nombre)) componentes.push(c);
    else if (c) componentes.push({ ...c, nombre: `${c.nombre}-${componentes.length}` });
  }

  const extra = prisma(dirs, deps, ev, repo);
  const servicios = serviciosDeCompose(repo, ev);
  const tiposVistos = new Set(servicios.map((s) => s.tipo));
  const nombres: Partial<Record<Servicio["tipo"], string>> = {
    postgres: "db", mysql: "db", mariadb: "db", sqlserver: "db", oracle: "db", mongodb: "mongo", redis: "cache",
    rabbitmq: "cola", kafka: "kafka", elasticsearch: "busqueda", minio: "s3", mailpit: "mail",
  };
  for (const d of deps) {
    const tipo = servicioPorDependencia(d);
    if (!tipo || tiposVistos.has(tipo)) continue;
    tiposVistos.add(tipo);
    let nombre = nombres[tipo] ?? tipo;
    if (servicios.some((s) => s.nombre === nombre)) nombre = tipo;
    servicios.push({ nombre, tipo, puerto: undefined, variables: {}, motivo: `dependencia ${d}` });
    ev.push(`dependencia ${d} → ${tipo}`);
  }

  // Tests e2e / visuales
  const tests: Stack["tests"] = {};
  const pkgRaiz = json(join(repo, "package.json"));
  const testRaiz = pkgRaiz.scripts?.test && !/no test specified/.test(pkgRaiz.scripts.test);
  const conTests = componentes.filter((c) => c.comandos.tests && c.ruta !== ".");
  const pmRaiz = gestorNode(repo);
  if (testRaiz) tests.unitarios = pmRaiz === "npm" ? "npm test" : `${pmRaiz} test`;
  else if (componentes.find((c) => c.ruta === ".")?.comandos.tests) tests.unitarios = componentes.find((c) => c.ruta === ".")!.comandos.tests;
  else if (conTests.length) tests.unitarios = conTests.map((c) => enCarpeta(c)).join(" && ");
  const pm = gestorNode(repo);
  const exec = pm === "npm" ? "npx" : pm === "yarn" ? "yarn" : pm === "bun" ? "bunx" : "pnpm exec";
  if (deps.has("@playwright/test")) {
    tests.e2e = `${exec} playwright test`;
    ev.push("dependencia @playwright/test → e2e");
    const visual = dirs.some((d) => /toHaveScreenshot|toMatchSnapshot/.test(leerTestsPlaywright(d)));
    if (visual) tests.visual = `${exec} playwright test --grep @visual`;
  } else if (deps.has("cypress")) { tests.e2e = `${exec} cypress run`; ev.push("dependencia cypress → e2e"); }

  const vars: Record<string, string> = {};
  for (const f of [".env.example", ".env.sample", ".env.template"]) {
    for (const l of leer(join(repo, f)).split(/\r?\n/)) {
      const m = l.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/);
      if (m && !/SECRET|TOKEN|PASSWORD|KEY/.test(m[1])) vars[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
    if (Object.keys(vars).length) { ev.push(`${f}: ${Object.keys(vars).length} variables`); break; }
  }

  const stack = Stack.parse({
    resumen: componentes.length
      ? `Proyecto con ${componentes.length} componente(s): ${componentes.map((c) => `${c.nombre} (${c.framework ?? c.lenguaje})`).join(", ")}.`
      : "",
    gestor_paquetes: componentes.length ? (existsSync(join(repo, "package.json")) ? pm : undefined) : undefined,
    instalar: existsSync(join(repo, "package.json")) ? (pm === "npm" ? (existsSync(join(repo, "package-lock.json")) ? "npm ci" : "npm install") : `${pm} install`) : undefined,
    componentes, servicios, tests,
    migraciones: extra.migraciones, seed: extra.seed,
    variables: {}, notas: [],
  });
  return { stack, evidencias: ev };
}

/** Test de un componente corrible desde la raíz (sh y cmd.exe): flags de carpeta del gestor o cd ida y vuelta. */
function enCarpeta(c: Componente): string {
  const cmd = c.comandos.tests!;
  const m = cmd.match(/^(pnpm|npm|yarn)\s+(.*)$/);
  if (m) return m[1] === "pnpm" ? `pnpm --dir ${c.ruta} ${m[2]}` : m[1] === "npm" ? `npm --prefix ${c.ruta} ${m[2]}` : `yarn --cwd ${c.ruta} ${m[2]}`;
  const vuelta = c.ruta.split("/").map(() => "..").join("/");
  return `cd ${c.ruta} && ${cmd} && cd ${vuelta}`;
}

function leerTestsPlaywright(dir: string): string {
  let t = "";
  for (const sub of ["e2e", "tests", "test", "playwright"]) {
    const d = join(dir, sub);
    if (!existsSync(d)) continue;
    try { for (const f of readdirSync(d)) if (/\.(spec|test)\.[jt]s$/.test(f)) t += leer(join(d, f)); } catch { /* */ }
  }
  return t;
}
