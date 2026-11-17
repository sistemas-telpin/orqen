/**
 * orqen env — lo que usan los agentes para levantar el proyecto y correr tests sin una persona.
 *   setup            instala dependencias de cada componente (entornos.preparar)
 *   up [--apps]      docker compose up --wait (+ perfil apps) y después migraciones y seed
 *   test [tipo...]   corre unitarios / integracion / e2e / visual con las variables de entornos.variables
 *   status           docker compose ps
 *   down             docker compose down -v
 */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { PERFIL_APPS } from "../lib/compose.ts";
import { leerConfig, type Config } from "../lib/config.ts";
import { ejecutarLinea, version } from "../lib/proc.ts";
import { pc } from "../ui/consola.ts";

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
    if (c !== 0) { console.error(pc.red(`✘ ${etiqueta} falló (código ${c}): ${l}`)); return false; }
  }
  return true;
}

function requiereDocker(repo: string, cfg: Config) {
  if (!version("docker", ["compose", "version", "--short"])) throw new Error("Docker Compose no está disponible en esta máquina. Instalá Docker (Desktop en Windows/macOS).");
  if (!existsSync(join(repo, cfg.entornos.compose))) throw new Error(`No existe ${cfg.entornos.compose}. Corré \`orqen init\` o revisá entornos.compose en orqen/config.yaml.`);
}

export async function entorno(sub: string | undefined, resto: string[], o: { dir?: string; apps?: boolean }) {
  const repo = resolve(o.dir ?? process.cwd());
  const cfg = leerConfig(repo);
  const e = cfg.entornos;
  let ok = true;
  switch (sub) {
    case "setup":
      ok = await correr(repo, cfg, e.preparar, "preparar");
      break;
    case "up": {
      requiereDocker(repo, cfg);
      ok = await correr(repo, cfg, [compose(cfg, "up -d --wait --remove-orphans", o.apps)], "levantar")
        && await correr(repo, cfg, e.migrar, "migrar")
        && await correr(repo, cfg, e.seed, "seed");
      if (ok) {
        const vars = Object.entries(e.variables);
        console.log(pc.green("\n✔ Entorno listo."));
        if (vars.length) console.log(pc.dim(vars.map(([k, v]) => `  ${k}=${v}`).join("\n")));
      }
      break;
    }
    case "test": {
      const pedidos = (resto.length ? resto : TIPOS.filter((t) => e.tests[t])) as TipoTest[];
      const invalidos = pedidos.filter((t) => !TIPOS.includes(t));
      if (invalidos.length) throw new Error(`Tipo de test inválido: ${invalidos.join(", ")}. Opciones: ${TIPOS.join(", ")}`);
      if (!pedidos.length) throw new Error("No hay comandos de tests en orqen/config.yaml (entornos.tests).");
      const resultados: [string, boolean | null][] = [];
      for (const t of pedidos) {
        const cmd = e.tests[t];
        if (!cmd) { resultados.push([t, null]); continue; }
        resultados.push([t, await correr(repo, cfg, [cmd], `tests ${t}`)]);
      }
      console.log("\n" + resultados.map(([t, r]) => `${r === null ? pc.yellow("–") : r ? pc.green("✔") : pc.red("✘")} ${t}${r === null ? pc.dim(" (sin comando en orqen/config.yaml)") : ""}`).join("\n"));
      ok = resultados.every(([, r]) => r !== false);
      break;
    }
    case "status":
      requiereDocker(repo, cfg);
      ok = await correr(repo, cfg, [compose(cfg, "ps", true)], "estado");
      break;
    case "down":
      requiereDocker(repo, cfg);
      ok = await correr(repo, cfg, [compose(cfg, "down -v --remove-orphans", true)], "bajar");
      break;
    default:
      console.log([
        "Uso: orqen env <comando>",
        "  setup            instala dependencias (entornos.preparar)",
        "  up [--apps]      servicios con healthcheck + migraciones + seed (--apps: también las apps)",
        "  test [tipo...]   unitarios | integracion | e2e | visual (por defecto, todos los configurados)",
        "  status           contenedores del entorno",
        "  down             baja todo y borra los volúmenes",
      ].join("\n"));
      if (sub) process.exitCode = 1;
      return;
  }
  if (!ok) process.exitCode = 1;
}
