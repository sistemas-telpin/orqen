#!/usr/bin/env node
/**
 * ORQEN CLI.
 *   orqen init [dir]      inicializa orqen en un repo (stack + entornos con IA, OpenSpec, kit)
 *   orqen update [dir]    actualiza la CLI, OpenSpec y el kit sin pisar lo que editó el equipo
 *   orqen entorno <cmd>   levantar / tests / estado / bajar (lo usan los agentes)
 */
import { parseArgs } from "node:util";
import { entorno } from "./comandos/entorno.ts";
import { init } from "./comandos/init.ts";
import { update } from "./comandos/update.ts";
import { VERSION_CLI } from "./lib/sistema.ts";
import { logo } from "./ui/logo.ts";

/** Comandos del proceso REC (hoy en rec/): se migran a orqen en la parte 2. */
const PROCESO = ["pendientes", "analizar", "carril", "tomar", "completar", "esquema", "bloquear", "liberar", "buscar", "estado", "ciclo"];

const AYUDA = `
Uso: orqen <comando> [opciones]

Comandos:
  init [dir]              Inicializa ORQEN en el repo (por defecto, la carpeta actual)
      --yes, -y           No pregunta: usa los valores por defecto (conflictos → deja .orqen-nuevo)
      --sin-ia            No usa un agente; solo detección automática
      --profundo          El agente explora el repo con sus herramientas (más preciso, tarda minutos)
      --sin-animacion     Logo estático
      --agente "<cmd>"    Comando headless del agente (ej. "claude -p --permission-mode acceptEdits")
      --herramientas a,b  Herramientas para \`openspec init\` (claude,codex,cursor,github-copilot...)
      --sin-openspec      No instala ni inicializa OpenSpec
  update [dir]            Actualiza la CLI, OpenSpec y el kit
      --yes, -y  --sin-cli  --sin-openspec  --sin-kit
  entorno <cmd>           preparar | levantar [--apps] | tests [tipo...] | estado | bajar
  --version, -v           Versión
  --help, -h              Esta ayuda

Próximamente (proceso REC): ${PROCESO.join(", ")}
`;

async function main() {
  const { values: v, positionals } = parseArgs({
    allowPositionals: true,
    strict: false,
    options: {
      yes: { type: "boolean", short: "y" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
      "sin-ia": { type: "boolean" },
      profundo: { type: "boolean" },
      "sin-animacion": { type: "boolean" },
      agente: { type: "string" },
      herramientas: { type: "string" },
      "sin-openspec": { type: "boolean" },
      "sin-cli": { type: "boolean" },
      "sin-kit": { type: "boolean" },
      apps: { type: "boolean" },
      dir: { type: "string" },
    },
  });
  const [cmd, ...resto] = positionals;
  if (v.version) return console.log(VERSION_CLI);
  if (!cmd || v.help) { console.log(logo() + AYUDA); return; }

  switch (cmd) {
    case "init":
      return init({
        dir: (v.dir as string) ?? resto[0], yes: !!v.yes, sinIa: !!v["sin-ia"], profundo: !!v.profundo, sinAnimacion: !!v["sin-animacion"], agente: v.agente as string | undefined,
        sinOpenspec: !!v["sin-openspec"],
        herramientas: typeof v.herramientas === "string" ? v.herramientas.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
      });
    case "update":
      return update({ dir: (v.dir as string) ?? resto[0], yes: !!v.yes, sinCli: !!v["sin-cli"], sinOpenspec: !!v["sin-openspec"], sinKit: !!v["sin-kit"], sinAnimacion: !!v["sin-animacion"] });
    case "entorno":
      return entorno(resto[0], resto.slice(1), { dir: v.dir as string | undefined, apps: !!v.apps });
    default:
      if (PROCESO.includes(cmd)) {
        console.error(`\`orqen ${cmd}\` todavía no está migrado a la CLI de orqen (llega en la parte 2). Mientras tanto: ./rec/bin/rec ${cmd}`);
      } else console.error(`Comando desconocido: ${cmd}\n${AYUDA}`);
      process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(`✘ ${(e as Error).message}`);
  process.exitCode = 1;
});
