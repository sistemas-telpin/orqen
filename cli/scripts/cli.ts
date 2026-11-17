/**
 * REC process CLI.  Usage:  ./cli/bin/orqen <command>
 *
 *   pending [--json]            Advances gates and lists the RECs with work: for the analyst (NEW/ANALYSIS) and for an agent
 *   analyze <KEY> [--analyst N]  Opens the analysis with an analyst (grilling): prints instructions + context + schema
 *   lane <KEY> <direct|light|full>   Records the lane; light/full create the branch and the OpenSpec change
 *   take <KEY> [--agent N]       (agent stages) Reserves the REC, prepares branch/tests and prints instructions + context
 *                                  (take/complete/status/block/release also accept the SIS key: SIS-442)
 *   pr <KEY> [<explanation.md>] [--title T]   No file: where the branch goes. With it: commits, pushes and opens the PR to DEVEL_BRANCH
 *   complete <KEY> <output.json|-> [--agent N]   Validates the stage output and advances the process
 *   schema <STAGE>                JSON Schema of a stage's output
 *   block <KEY> <reason>         Escalates to a human
 *   release <KEY>                  Removes the reservation of a REC
 *   search <JQL>                   Searches issues (background / related)
 *   status [KEY]                   Current state and log
 *   cycle [--loop]                 Unattended mode: launches AGENT_CMD for each pending REC
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REC_DIR, loadConfig } from "./config.ts";
import { jsonSchema } from "./schemas.ts";
import { LANES, AGENT_STATES, type AgentState } from "./states.ts";
import { JiraClient } from "./jira.ts";
import { OpenSpecCli } from "./openspec.ts";
import { Process } from "./process.ts";
import { Store } from "./store.ts";
import { GitWorkspace } from "./workspace.ts";

const cfg = loadConfig();
const store = new Store(cfg.stateDir);
const jira = new JiraClient(cfg);
const flow = new Process(cfg, jira, store, new GitWorkspace(cfg), new OpenSpecCli(cfg.openspecCmd, cfg.repoPath));

const [cmd, ...rest] = process.argv.slice(2);
const flag = (n: string) => { const i = rest.indexOf(`--${n}`); return i >= 0 ? (rest.splice(i, 2)[1] ?? "") : undefined; };
const has = (n: string) => { const i = rest.indexOf(`--${n}`); if (i >= 0) rest.splice(i, 1); return i >= 0; };
const agent = flag("agent") ?? process.env.REC_AGENT ?? "agent";
const analyst = flag("analyst") ?? process.env.REC_ANALYST ?? "";

/** Accepts the REC key or its SIS key (the REC's current SIS) and always returns the REC key. */
function toRec(key?: string): string {
  if (!key || /^REC-\d+$/i.test(key)) return key as string;
  const rec = store.all().find((r) => r.sis?.toUpperCase() === key.toUpperCase());
  if (!rec) throw new Error(`${key} is neither a REC nor the current SIS of any known REC (if it belongs to a previous round, use the REC key).`);
  return rec.key;
}

/** Guide to write the spec by lane (stages/specification.md; lines prefixed with [light] / [full] are filtered). */
function specGuide(lane: string, key: string, change: string) {
  const prefix = /^(\s*)\[(light|full)\]\s*/;
  return readFileSync(join(REC_DIR, "stages", "specification.md"), "utf8")
    .split("\n")
    .filter((l) => { const m = l.match(prefix); return !m || m[2] === lane; })
    .map((l) => l.replace(prefix, "$1"))
    .join("\n")
    .replaceAll("[light|full]", lane).replaceAll("<change>", change).replaceAll("<KEY>", key);
}

function guide(state: AgentState) {
  return readFileSync(join(REC_DIR, "stages", `${state.toLowerCase()}.md`), "utf8");
}

// The text of this prompt is read by the agent, like the stage guides: it stays in Spanish.
function renderTake(key: string, ctx: Record<string, any>) {
  const s = ctx.state as AgentState;
  const lane = s === "ANALYSIS"
    ? ["", "## Carril (cuando el analista dé el OK)", `Con el carril confirmado: \`./cli/bin/orqen lane ${key} <${LANES.join("|")}> --agent ${agent}\`.`,
       "Light/full: te crea la rama y el change de OpenSpec e imprime cómo escribir la spec. Direct: no hace falta spec."]
    : [];
  return [
    `# REC ${key} — etapa ${s}`,
    "",
    guide(s),
    "",
    "## Contexto",
    "```json", JSON.stringify(ctx, null, 2), "```",
    "",
    "## Salida esperada (JSON Schema)",
    "```json", JSON.stringify(jsonSchema(s), null, 2), "```",
    "",
    ...lane,
    "",
    "## Para terminar",
    `Escribí la salida en un archivo (ej. \`/tmp/${key}-${s.toLowerCase()}.json\`) y corré:`,
    "```sh", `./cli/bin/orqen complete ${key} /tmp/${key}-${s.toLowerCase()}.json --agent ${agent}`, "```",
    "Si la salida no es válida, el comando lista los errores: corregí y volvé a correrlo.",
    `Si no podés avanzar: \`./cli/bin/orqen block ${key} "motivo"\`.`,
  ].join("\n");
}

async function cycle() {
  const pending = (await flow.review()).filter((p) => p.for === "agent" && !p.takenBy);
  for (const p of pending) {
    const prompt = `Procesá el REC ${p.key} siguiendo la sección "Proceso REC" de AGENTS.md. ` +
      `Empezá corriendo: ./cli/bin/orqen take ${p.key} --agent cycle`;
    const command = cfg.agentCmd.replace("{prompt}", `'${prompt.replace(/'/g, `'\\''`)}'`);
    console.log(`→ ${p.key} (${p.state}): ${command}`);
    const r = spawnSync(command, { shell: true, cwd: cfg.repoPath, stdio: "inherit", env: { ...process.env, REC_AGENT: "cycle" } });
    const rec = store.get(p.key);
    if (rec?.state === p.state && rec.lock?.agent === "cycle") {
      await flow.block(p.key, `The agent finished (code ${r.status}) without completing stage ${p.state}.`, "cycle");
    }
  }
}

async function main() {
  switch (cmd) {
    case "pending": {
      const p = await flow.review();
      if (has("json")) return console.log(JSON.stringify(p, null, 2));
      if (!p.length) return console.log("No RECs with pending work.");
      for (const who of ["analyst", "agent"] as const) {
        const xs = p.filter((x) => x.for === who);
        if (!xs.length) continue;
        console.log(who === "analyst" ? "To analyze (/orqen:analyze <KEY>):" : "For an agent (orqen take <KEY>):");
        for (const x of xs) console.log(`  ${x.key.padEnd(12)} ${x.state.padEnd(15)} ${x.takenBy ? `(taken by ${x.takenBy})` : ""}`);
      }
      return;
    }
    case "analyze": {
      const key = rest[0];
      if (!key) { console.error("Usage: orqen analyze <KEY> [--analyst NAME]"); process.exitCode = 1; return; }
      try {
        const { context } = await flow.analyze(key, agent, analyst || agent);
        console.log(renderTake(key, context));
      } catch (e) {
        console.error(`✘ ${(e as Error).message}`);
        process.exitCode = 1;
      }
      return;
    }
    case "lane": {
      const [key, l] = rest;
      try {
        const r = await flow.lane(key, l, agent);
        console.log(`✔ ${key}: lane ${r.lane}`);
        if (r.openspec) {
          console.log(`branch: ${r.branch}\nOpenSpec change: ${r.openspec.change} (${r.openspec.dir})\n`);
          console.log(specGuide(r.lane, key, r.openspec.change));
        } else console.log("No spec: the plan and the criteria go in the analysis output.");
      } catch (e) {
        console.error(`✘ ${(e as Error).message}`);
        process.exitCode = 1;
      }
      return;
    }
    case "take": {
      try {
        const key = toRec(rest[0]);
        const { context } = await flow.take(key, agent);
        console.log(renderTake(key, context));
      } catch (e) {
        console.error(`✘ ${(e as Error).message}`);
        process.exitCode = 1;
      }
      return;
    }
    case "complete": {
      const [rawKey, file] = rest;
      let key: string;
      try { key = toRec(rawKey); } catch (e) { console.error(`✘ ${(e as Error).message}`); process.exitCode = 1; return; }
      const text = !file || file === "-" ? readFileSync(0, "utf8") : readFileSync(file, "utf8");
      let data: unknown;
      try { data = JSON.parse(text); } catch (e) { console.error(`✘ Invalid JSON: ${(e as Error).message}`); process.exitCode = 1; return; }
      const r = await flow.complete(key, data, agent);
      if (r.ok) console.log(`✔ ${key} → ${r.next}`);
      else { console.error(`✘ The output was not accepted:\n- ${r.errors.join("\n- ")}`); process.exitCode = 1; }
      return;
    }
    case "pr": {
      try {
        const key = toRec(rest[0]);
        if (!rest[1]) return console.log(JSON.stringify(flow.prInfo(key), null, 2));
        const body = rest[1] === "-" ? readFileSync(0, "utf8") : readFileSync(rest[1], "utf8");
        const r = await flow.pr(key, body, flag("title"), agent);
        console.log(r.created ? `✔ PR → ${r.base}: ${r.url}` : `✔ branch updated; the PR already existed: ${r.url}`);
      } catch (e) {
        console.error(`✘ ${(e as Error).message}`);
        process.exitCode = 1;
      }
      return;
    }
    case "schema": {
      const s = rest[0]?.toUpperCase() as AgentState;
      if (!AGENT_STATES.includes(s)) throw new Error(`Invalid stage. Options: ${AGENT_STATES.join(", ")}`);
      return console.log(JSON.stringify(jsonSchema(s), null, 2));
    }
    case "block": await flow.block(toRec(rest[0]), rest.slice(1).join(" "), agent); return console.log("✔ blocked");
    case "release": flow.release(toRec(rest[0])); return console.log("✔ released");
    case "search": {
      const keys = (await jira.searchKeys(rest.join(" "))).slice(0, 20);
      const out = await Promise.all(keys.map(async (k: string) => {
        const i = await jira.issue(k);
        return { key: k, title: i.title, status: i.jiraStatus, description: i.description.slice(0, 500) };
      }));
      return console.log(JSON.stringify(out, null, 2));
    }
    case "status": {
      if (rest[0]) {
        const key = toRec(rest[0]);
        const rec = store.get(key);
        console.log(rec ? JSON.stringify({ ...rec, artifacts: Object.keys(rec.artifacts) }, null, 2) : "unknown");
        for (const ev of store.events(key)) console.log(`  ${ev.ts}  ${ev.from} → ${ev.to}  ${ev.detail}`);
      } else for (const r of store.all()) console.log(`${r.key.padEnd(12)} ${r.state.padEnd(15)} ${(r.sis ?? "").padEnd(12)} ${r.change ?? ""}`);
      return;
    }
    case "cycle":
      if (!has("loop")) return cycle();
      for (;;) { await cycle(); await new Promise((r) => setTimeout(r, cfg.intervalSec * 1000)); }
    default:
      console.log(readFileSync(new URL(import.meta.url), "utf8").split("*/")[0].replace(/^\/\*\*?|^ \* ?/gm, ""));
  }
}

main().catch((e) => { console.error(`✘ ${e.message}`); process.exit(1); });
