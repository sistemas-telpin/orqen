#!/usr/bin/env node
/**
 * ORQEN CLI.
 *   orqen init [dir]      inicializa orqen en un repo (stack + entornos con IA, OpenSpec, kit)
 *   orqen update [dir]    actualiza la CLI, OpenSpec y el kit sin pisar lo que editó el equipo
 *   orqen env <cmd>   levantar / tests / estado / bajar (lo usan los agentes)
 *   orqen analyze | carril | tomar | completar | estado | ciclo …   proceso REC (ver comandos/proceso.ts)
 */
import { parseArgs } from "node:util";
import { entorno } from "./comandos/entorno.ts";
import { init } from "./comandos/init.ts";
import { AYUDA_PROCESO, COMANDOS_PROCESO, proceso } from "./comandos/proceso.ts";
import { update } from "./comandos/update.ts";
import { VERSION_CLI } from "./lib/sistema.ts";
import { logo } from "./ui/logo.ts";


const AYUDA = `
Uso: orqen <comando> [opciones]

Comandos:
  init [dir]              Inicializa ORQEN en el repo (por defecto, la carpeta actual)
      --yes, -y           No pregunta: usa los valores por defecto (conflictos → deja .orqen-nuevo)
      --no-ai             No usa un agente; solo detección automática
      --deep              El agente explora el repo con sus herramientas (más preciso, tarda minutos)
      --no-animation      Logo estático
      --agent "<cmd>"     Comando headless del agente (ej. "claude -p --permission-mode acceptEdits")
      --tools a,b         Herramientas para \`openspec init\` (claude,codex,cursor,github-copilot...)
      --no-openspec       No instala ni inicializa OpenSpec
  update [dir]            Actualiza la CLI, OpenSpec y el kit
      --yes, -y  --no-cli  --no-openspec  --no-kit
  env <cmd>               setup | up [--apps] | test [tipo...] | status | down
  --version, -v           Versión
  --help, -h              Esta ayuda

${AYUDA_PROCESO}
`;

async function main() {
  // Los comandos del proceso REC tienen sus propios flags (--agent, --analyst, --json, --loop).
  const crudos = process.argv.slice(2);
  if (COMANDOS_PROCESO.includes(crudos[0])) return proceso(crudos[0], crudos.slice(1));
  const { values: v, positionals } = parseArgs({
    allowPositionals: true,
    strict: false,
    options: {
      yes: { type: "boolean", short: "y" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
      "no-ai": { type: "boolean" },
      deep: { type: "boolean" },
      "no-animation": { type: "boolean" },
      agent: { type: "string" },
      tools: { type: "string" },
      "no-openspec": { type: "boolean" },
      "no-cli": { type: "boolean" },
      "no-kit": { type: "boolean" },
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
        dir: (v.dir as string) ?? resto[0], yes: !!v.yes, sinIa: !!v["no-ai"], profundo: !!v.deep, sinAnimacion: !!v["no-animation"], agente: v.agent as string | undefined,
        sinOpenspec: !!v["no-openspec"],
        herramientas: typeof v.tools === "string" ? v.tools.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
      });
    case "update":
      return update({ dir: (v.dir as string) ?? resto[0], yes: !!v.yes, sinCli: !!v["no-cli"], sinOpenspec: !!v["no-openspec"], sinKit: !!v["no-kit"], sinAnimacion: !!v["no-animation"] });
    case "env":
      return entorno(resto[0], resto.slice(1), { dir: v.dir as string | undefined, apps: !!v.apps });
    default:
      console.error(`Comando desconocido: ${cmd}\n${AYUDA}`);
      process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(`✘ ${(e as Error).message}`);
  process.exitCode = 1;
});
