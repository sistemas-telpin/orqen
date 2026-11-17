#!/usr/bin/env node
/** ORQEN command-line entry point. */
import { parseArgs } from "node:util";
import { entorno } from "./commands/environment.ts";
import { crear } from "./commands/create.ts";
import { init } from "./commands/init.ts";
import { WORKFLOW_HELP, WORKFLOW_COMMANDS, runWorkflow } from "./commands/workflow.ts";
import { update } from "./commands/update.ts";
import { SWARM_HELP, swarm } from "./commands/swarm.ts";
import { lang, tutorial } from "./commands/tutorial.ts";
import { VERSION_CLI } from "./lib/system.ts";
import { mostrarLogo } from "./ui/logo.ts";


const AYUDA = `
Usage: orqen <command> [options]

Commands:
  init [dir]              Initialize ORQEN in a repository (default: current directory)
      --yes, -y           Use defaults and write conflicts alongside the originals
      --no-ai             Use automatic detection only
      --deep              Let the agent explore the repository in depth
      --no-animation      Show the static logo
      --agent "<cmd>"     Headless agent command (e.g. "claude -p --permission-mode acceptEdits")
      --tools-repo <repo> GitHub stack catalog (e.g. @company/tools), cloned inside cli/tools
      --tools a,b         Tools for \`openspec init\` (claude,codex,cursor,github-copilot...)
      --no-openspec       Skip OpenSpec installation and initialization
  create project [name]   Create a new project from a stack (code, tools to run it, and orqen ready)
      --stack <id>        Stack from your private catalog (orqen create stacks lists them)
      --dir <folder>      Where to create it (default: ./<name>)
  update [dir]            Update the CLI, OpenSpec, and kit
      --yes, -y  --no-cli  --no-openspec  --no-kit
  env <cmd>               setup | up [--all] | test [type...] | status | down
  tutorial [step]         Step-by-step tour for newcomers, in your system language (es/en)
      --step <n|id>       Print one step and exit (--json for agents) · --list · --lang es|en
  lang                    Print the detected system language (es | en); ORQEN_LANG overrides it
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
      "tools-repo": { type: "string" },
      "no-openspec": { type: "boolean" },
      "no-cli": { type: "boolean" },
      "no-kit": { type: "boolean" },
      all: { type: "boolean" },
      dir: { type: "string" },
      stack: { type: "string" },
    },
  });
  const [cmd, ...resto] = positionals;
  if (v.version) return console.log(VERSION_CLI);
  if (!cmd || v.help) {
    await mostrarLogo({ animar: !v["no-animation"] && !v.yes });
    console.log(AYUDA);
    return;
  }

  switch (cmd) {
    case "init":
      return init({
        dir: (v.dir as string) ?? resto[0], yes: !!v.yes, sinIa: !!v["no-ai"], profundo: !!v.deep, sinAnimacion: !!v["no-animation"], agente: v.agent as string | undefined,
        sinOpenspec: !!v["no-openspec"],
        toolsRepo: v["tools-repo"] as string | undefined,
        herramientas: typeof v.tools === "string" ? v.tools.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
      });
    case "create":
      return crear(resto[0], {
        nombre: resto.slice(1).join(" ") || undefined, stack: v.stack as string | undefined, dir: v.dir as string | undefined,
        yes: !!v.yes, sinAnimacion: !!v["no-animation"], sinOpenspec: !!v["no-openspec"],
        toolsRepo: v["tools-repo"] as string | undefined,
        herramientas: typeof v.tools === "string" ? v.tools.split(",").map((x) => x.trim()).filter(Boolean) : undefined,
      });
    case "update":
      return update({ dir: (v.dir as string) ?? resto[0], yes: !!v.yes, sinCli: !!v["no-cli"], sinOpenspec: !!v["no-openspec"], sinKit: !!v["no-kit"], sinAnimacion: !!v["no-animation"] });
    case "env":
      return entorno(resto[0], resto.slice(1), { dir: v.dir as string | undefined, todos: !!v.all });
    default:
      console.error(`Unknown command: ${cmd}\n${AYUDA}`);
      process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(`✘ ${(e as Error).message}`);
  process.exitCode = 1;
});
