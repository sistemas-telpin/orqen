#!/usr/bin/env node
/** ORQEN command-line entry point. */
import { parseArgs } from "node:util";
import { entorno } from "./commands/environment.ts";
import { bootstrap } from "./commands/bootstrap.ts";
import { init } from "./commands/init.ts";
import { WORKFLOW_HELP, WORKFLOW_COMMANDS, runWorkflow } from "./commands/workflow.ts";
import { update } from "./commands/update.ts";
import { SWARM_HELP, swarm } from "./commands/swarm.ts";
import { lang, tutorial } from "./commands/tutorial.ts";
import { VERSION_CLI } from "./lib/system.ts";
import { mostrarLogo } from "./ui/logo.ts";
import { usageCommand } from "./lib/usage.ts";


const AYUDA = `
Usage: orqen <command> [options]
       orqen                   This help (the desktop app is a separate project: github.com/sistemas-telpin/orqen-gui)

Commands:
  init [dir]              Initialize ORQEN in a repository (default: current directory)
      --yes, -y           Use defaults and write conflicts alongside the originals
      --no-ai             Use automatic detection only
      --deep              Let the agent explore the repository in depth
      --no-animation      Show the static logo
      --agent "<cmd>"     Headless agent command (e.g. "claude -p --permission-mode acceptEdits")
      --tools a,b         Tools for \`openspec init\` (claude,codex,cursor,github-copilot...)
      --no-openspec       Skip OpenSpec installation and initialization
  bootstrap [name]        Create a new project from a stack (code, tools to run it, and orqen ready)
      --tools-repo <repo> GitHub stack catalog (any repo name), cloned inside cli/tools
      --list              List the stacks from your catalog
      --stack <id>        Stack from your private catalog (orqen bootstrap --list lists them)
      --dir <folder>      Where to create it (default: ./<name>)
      --params '<json>'   Parameter values, e.g. '{"PORT":"8081"}' (the rest use their defaults)
      --list --json · --describe <stack> --json   Catalog, parameters and requirements as JSON (for tools such as orqen-gui)
  update [dir]            Update the CLI, OpenSpec, and kit
      --yes, -y  --no-cli  --no-openspec  --no-kit
  env <cmd>               setup | up [--all] | test [type...] | status | down
  tutorial [step]         Step-by-step tour for newcomers, in your system language (es/en)
      --step <n|id>       Print one step and exit (--json for agents) · --list · --lang es|en
  lang                    Print the detected system language (es | en); ORQEN_LANG overrides it
  usage [--json]          AI agents installed on this machine and their quota used
${SWARM_HELP}
  --version, -v           Show version
  --help, -h              Show this help

${WORKFLOW_HELP}
`;

async function main() {
  // Request commands parse their own flags (--agent, --analyst, --json, --loop).
  const crudos = process.argv.slice(2);
  if (WORKFLOW_COMMANDS.includes(crudos[0])) return runWorkflow(crudos[0], crudos.slice(1));
  if (crudos[0] === "swarm") return swarm(crudos.slice(1));
  if (crudos[0] === "tutorial") return tutorial(crudos.slice(1));
  if (crudos[0] === "lang") return lang(crudos.slice(1));
  if (crudos[0] === "usage") return usageCommand(crudos.slice(1));
  // `orqen env test e2e -- <args>`: everything after `--` goes to the test command untouched
  const sep = crudos.indexOf("--");
  const extra = sep >= 0 ? crudos.slice(sep + 1) : [];
  const { values: v, positionals } = parseArgs({
    args: sep >= 0 ? crudos.slice(0, sep) : crudos,
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
      "tools-repo": { type: "string" },
      "no-openspec": { type: "boolean" },
      "no-cli": { type: "boolean" },
      "no-kit": { type: "boolean" },
      all: { type: "boolean" },
      dir: { type: "string" },
      stack: { type: "string" },
      list: { type: "boolean" },
      json: { type: "boolean" },
      describe: { type: "string" },
      params: { type: "string" },
    },
  });
  const [cmd, ...resto] = positionals;
  if (v.version) return console.log(VERSION_CLI);
  if (v.help) {
    await mostrarLogo({ animar: false });
    console.log(AYUDA);
    return;
  }
  // `orqen` alone: logo and help. The desktop app is a separate project (github.com/sistemas-telpin/orqen-gui).
  if (!cmd) {
    await mostrarLogo({ animar: !v["no-animation"] && !v.yes });
    console.log(AYUDA);
    return;
  }

  if (v["tools-repo"] && cmd !== "bootstrap") throw new Error("--tools-repo is only supported by orqen bootstrap.");

  switch (cmd) {
    case "init":
      return init({
        dir: (v.dir as string) ?? resto[0], yes: !!v.yes, sinIa: !!v["no-ai"], profundo: !!v.deep, sinAnimacion: !!v["no-animation"], agente: v.agent as string | undefined,
        sinOpenspec: !!v["no-openspec"],
        herramientas: typeof v.tools === "string" ? v.tools.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
      });
    case "bootstrap":
      return bootstrap({
        nombre: resto.join(" ") || undefined, listar: !!v.list, stack: v.stack as string | undefined, dir: v.dir as string | undefined,
        yes: !!v.yes, sinAnimacion: !!v["no-animation"], sinOpenspec: !!v["no-openspec"],
        toolsRepo: v["tools-repo"] as string | undefined,
        json: !!v.json, describir: v.describe as string | undefined,
        parametros: typeof v.params === "string" ? JSON.parse(v.params) : undefined,
        herramientas: typeof v.tools === "string" ? v.tools.split(",").map((x) => x.trim()).filter(Boolean) : undefined,
      });
    case "update":
      return update({ dir: (v.dir as string) ?? resto[0], yes: !!v.yes, sinCli: !!v["no-cli"], sinOpenspec: !!v["no-openspec"], sinKit: !!v["no-kit"], sinAnimacion: !!v["no-animation"] });
    case "env":
      return entorno(resto[0], resto.slice(1), { dir: v.dir as string | undefined, todos: !!v.all, json: !!v.json, extra });
    default:
      console.error(`Unknown command: ${cmd}\n${AYUDA}`);
      process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(`✘ ${(e as Error).message}`);
  process.exitCode = 1;
});
