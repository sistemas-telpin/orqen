/** Commands for preparing, testing, and shutting down a project environment. */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { PERFIL_APPS } from "../lib/compose.ts";
import { leerConfig, type Config } from "../lib/config.ts";
import { ejecutarLinea, version } from "../lib/proc.ts";
import { pc } from "../ui/console.ts";

const TIPOS = ["unitarios", "integracion", "e2e", "visual"] as const;
type TipoTest = (typeof TIPOS)[number];

const titulo = (s: string) => console.log(`\n${pc.bold(pc.magenta("▸"))} ${pc.bold(s)}`);

function compose(cfg: Config, args: string, apps = false) {
  return `docker compose -f "${cfg.entornos.compose}"${apps ? ` --profile ${PERFIL_APPS}` : ""} ${args}`;
}

async function correr(repo: string, cfg: Config, lineas: string[], etiqueta: string): Promise<boolean> {
  const env = { ...process.env, ...cfg.entornos.variables };
  for (const l of lineas) {
    titulo(`${etiqueta}: ${l}`);
    const c = await ejecutarLinea(l, { cwd: repo, env });
    if (c !== 0) { console.error(pc.red(`✘ ${etiqueta} failed (exit code ${c}): ${l}`)); return false; }
  }
  return true;
}

function requiereDocker(repo: string, cfg: Config) {
  if (!version("docker", ["compose", "version", "--short"])) throw new Error("Docker Compose is unavailable. Install Docker (Docker Desktop on Windows or macOS).");
  if (!existsSync(join(repo, cfg.entornos.compose))) throw new Error(`Missing ${cfg.entornos.compose}. Run \`orqen init\` or check entornos.compose in orqen/config.yaml.`);
}

export async function entorno(sub: string | undefined, resto: string[], o: { dir?: string; apps?: boolean }) {
  const repo = resolve(o.dir ?? process.cwd());
  const cfg = leerConfig(repo);
  const e = cfg.entornos;
  let ok = true;
  switch (sub) {
    case "setup":
      ok = await correr(repo, cfg, e.preparar, "install dependencies");
      break;
    case "up": {
      requiereDocker(repo, cfg);
      ok = await correr(repo, cfg, [compose(cfg, "up -d --wait --remove-orphans", o.apps)], "start services")
        && await correr(repo, cfg, e.migrar, "run migrations")
        && await correr(repo, cfg, e.seed, "seed");
      if (ok) {
        const vars = Object.entries(e.variables);
        console.log(pc.green("\n✔ Environment ready."));
        if (vars.length) console.log(pc.dim(vars.map(([k, v]) => `  ${k}=${v}`).join("\n")));
      }
      break;
    }
    case "test": {
      const pedidos = (resto.length ? resto : TIPOS.filter((t) => e.tests[t])) as TipoTest[];
      const invalidos = pedidos.filter((t) => !TIPOS.includes(t));
      if (invalidos.length) throw new Error(`Invalid test type: ${invalidos.join(", ")}. Options: ${TIPOS.join(", ")}`);
      if (!pedidos.length) throw new Error("No test commands are configured in orqen/config.yaml (entornos.tests).");
      const resultados: [string, boolean | null][] = [];
      for (const t of pedidos) {
        const cmd = e.tests[t];
        if (!cmd) { resultados.push([t, null]); continue; }
        resultados.push([t, await correr(repo, cfg, [cmd], `tests ${t}`)]);
      }
      console.log("\n" + resultados.map(([t, r]) => `${r === null ? pc.yellow("–") : r ? pc.green("✔") : pc.red("✘")} ${t}${r === null ? pc.dim(" (no command configured in orqen/config.yaml)") : ""}`).join("\n"));
      ok = resultados.every(([, r]) => r !== false);
      break;
    }
    case "status":
      requiereDocker(repo, cfg);
      ok = await correr(repo, cfg, [compose(cfg, "ps", true)], "status");
      break;
    case "down":
      requiereDocker(repo, cfg);
      ok = await correr(repo, cfg, [compose(cfg, "down -v --remove-orphans", true)], "stop services");
      break;
    default:
      console.log([
        "Usage: orqen env <command>",
        "  setup            install dependencies (entornos.preparar)",
        "  up [--apps]      start services, wait for health checks, migrate, and seed (--apps: include apps)",
        "  test [type...]   unitarios | integracion | e2e | visual (default: all configured tests)",
        "  status           show environment containers",
        "  down             stop containers and remove volumes",
      ].join("\n"));
      if (sub) process.exitCode = 1;
      return;
  }
  if (!ok) process.exitCode = 1;
}
