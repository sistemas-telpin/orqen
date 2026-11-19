/**
 * orqen env: start the project and run its tests without a person at the keyboard (used by the workflow and agents).
 *   setup            install dependencies (entornos.preparar)
 *   up [--all]       start the processes (npm run dev, npm start…) and wait until they are ready; then migrations and seed.
 *                    --all: also the processes that are only for e2e / visual tests (e.g. the frontend)
 *   test [type...]   unit / integration / e2e / visual with the variables of orqen/environment.yaml
 *                    `-- <args>`: appended to the command of the requested type (e.g. only the e2e of a change)
 *   status           which processes are running
 *   down             stop the processes orqen started
 */
import { resolve } from "node:path";
import { leerConfig, type Config } from "../lib/config.ts";
import { ejecutarLinea } from "../lib/proc.ts";
import { bajarProcesos, estadoProcesos, levantarProcesos } from "../lib/processes.ts";
import { pc } from "../ui/console.ts";

const TIPOS = ["unitarios", "integracion", "e2e", "visual"] as const;
type TipoTest = (typeof TIPOS)[number];
/** Test types as people write them (orqen/environment.yaml uses unit / integration); the Spanish names still work. */
const NOMBRE: Record<TipoTest, string> = { unitarios: "unit", integracion: "integration", e2e: "e2e", visual: "visual" };
const tipoDe = (s: string) => (Object.entries(NOMBRE).find(([, en]) => en === s)?.[0] ?? s) as TipoTest;

const titulo = (s: string) => console.log(`\n${pc.bold(pc.magenta("▸"))} ${pc.bold(s)}`);

async function correr(repo: string, cfg: Config, lineas: string[], etiqueta: string): Promise<boolean> {
  const env = { ...process.env, ...cfg.entornos.variables };
  for (const l of lineas) {
    titulo(`${etiqueta}: ${l}`);
    const c = await ejecutarLinea(l, { cwd: repo, env });
    if (c !== 0) { console.error(pc.red(`✘ ${etiqueta} failed (exit code ${c}): ${l}`)); return false; }
  }
  return true;
}

/** Quotes an argument for the shell line only when it needs it. */
const citar = (a: string) => /^[\w@%+=:,./-]+$/.test(a) ? a : `"${a.replace(/(["\\$`])/g, "\\$1")}"`;

export async function entorno(sub: string | undefined, resto: string[], o: { dir?: string; todos?: boolean; json?: boolean; extra?: string[] }) {
  const repo = resolve(o.dir ?? process.cwd());
  const cfg = leerConfig(repo);
  const e = cfg.entornos;
  let ok = true;
  switch (sub) {
    case "setup":
      ok = await correr(repo, cfg, e.preparar, "install dependencies");
      break;
    case "up": {
      if (!e.procesos.length) console.log(pc.dim("No processes configured in orqen/environment.yaml (processes)."));
      const r = await levantarProcesos(repo, e.procesos, e.variables, { todos: o.todos, alAvanzar: (m) => titulo(m) });
      if (!r.ok) {
        console.error(pc.red(`✘ ${r.detalle}`));
        if (r.salida) console.error(pc.dim(r.salida));
        ok = false;
        break;
      }
      ok = await correr(repo, cfg, e.migrar, "run migrations") && await correr(repo, cfg, e.seed, "seed");
      if (ok) {
        console.log(pc.green(`\n✔ ${r.detalle}`));
        const vars = Object.entries(e.variables);
        if (vars.length) console.log(pc.dim(vars.map(([k, v]) => `  ${k}=${v}`).join("\n")));
        console.log(pc.dim("  To stop them: orqen env down"));
      }
      break;
    }
    case "test": {
      const pedidos = (resto.length ? resto.map(tipoDe) : TIPOS.filter((t) => e.tests[t])) as TipoTest[];
      const invalidos = pedidos.filter((t) => !TIPOS.includes(t));
      if (invalidos.length) throw new Error(`Invalid test type: ${invalidos.join(", ")}. Options: ${Object.values(NOMBRE).join(", ")}`);
      if (!pedidos.length) throw new Error("No test commands are configured in orqen/environment.yaml (tests).");
      const extra = o.extra ?? [];
      if (extra.length && !resto.length)
        throw new Error("Name the test type the arguments after `--` are for, e.g. orqen env test e2e -- tests/login.spec.ts");
      const resultados: [string, boolean | null][] = [];
      for (const t of pedidos) {
        const cmd = e.tests[t];
        if (!cmd) { resultados.push([NOMBRE[t], null]); continue; }
        const linea = extra.length ? `${cmd} ${extra.map(citar).join(" ")}` : cmd;
        resultados.push([NOMBRE[t], await correr(repo, cfg, [linea], `tests ${NOMBRE[t]}`)]);
      }
      console.log("\n" + resultados.map(([t, r]) => `${r === null ? pc.yellow("–") : r ? pc.green("✔") : pc.red("✘")} ${t}${r === null ? pc.dim(" (no command configured in orqen/environment.yaml)") : ""}`).join("\n"));
      ok = resultados.every(([, r]) => r !== false);
      break;
    }
    case "status": {
      const st = await estadoProcesos(repo, e.procesos);
      if (o.json) { console.log(JSON.stringify({ processes: st, variables: e.variables, tests: e.tests }, null, 2)); break; }
      if (!st.length) console.log(pc.dim("No processes configured in orqen/environment.yaml (processes)."));
      for (const x of st)
        console.log(`${x.corriendo ? pc.green("●") : pc.dim("○")} ${x.nombre.padEnd(16)} ${pc.dim(x.comando)}${x.puerto ? pc.dim(` :${x.puerto}`) : ""}${x.cuando === "e2e" ? pc.dim("  (e2e only)") : ""}${x.log ? pc.dim(`\n    log: ${x.log}`) : ""}`);
      break;
    }
    case "down": {
      const bajados = bajarProcesos(repo);
      console.log(bajados.length ? pc.green(`✔ Stopped: ${bajados.join(", ")}`) : pc.dim("No processes started by orqen are running."));
      break;
    }
    default:
      console.log([
        "Usage: orqen env <command>",
        "  setup            install dependencies (entornos.preparar)",
        "  up [--all]       start the processes and wait until they are ready, then migrate and seed (--all: include e2e-only processes)",
        "  test [type...]   unit | integration | e2e | visual (default: all configured tests)",
        "                   -- <args>: appended to that type's command, e.g. orqen env test e2e -- tests/login.spec.ts",
        "  status           show which processes are running and where their logs are",
        "  down             stop the processes orqen started",
      ].join("\n"));
      if (sub) process.exitCode = 1;
      return;
  }
  if (!ok) process.exitCode = 1;
}
