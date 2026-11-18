/** Workflow commands shared by the repository wrapper and the installed CLI. */
import { ejecutar, partirComando } from "../lib/proc.ts";
import { stageGuideFile } from "../lib/stage-guides.ts";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { loadConfig, warnLegacy } from "../workflow/config.ts";
import { jsonSchema } from "../workflow/schemas.ts";
import { LANES, AGENT_STATES, type AgentState } from "../workflow/states.ts";
import { buildConnectors } from "../connectors/index.ts";
import { envWithLegacy } from "../connectors/legacy.ts";
import { OpenSpecCli } from "../workflow/openspec.ts";
import { Process } from "../workflow/process.ts";
import { Store } from "../workflow/store.ts";
import { GitWorkspace } from "../workflow/workspace.ts";

export const WORKFLOW_COMMANDS = ["pending", "support", "analyze", "lane", "take", "complete", "pr", "review", "code-review", "schema", "block", "release", "search", "status", "cycle", "connectors"];

export const WORKFLOW_HELP = `Customer request workflow:
  pending [--json]                      List pending analyst and agent work
  support <KEY> [--person NAME]         Start first-line support
  analyze <KEY> [--analyst NAME]        Start analysis
  lane <KEY> <direct|light|full>        Record the lane
  take <KEY> [--agent NAME]             Claim an agent stage
  complete <KEY> <output.json|->       Validate output and advance the workflow
  pr <KEY> [<explanation.md>]          Inspect or open the integration PR
  review <KEY> approve|reject [--reason TEXT] [--report FILE]  QA decision (QA_REVIEW, full lane only)
  code-review <KEY> <report.md|-> --verdict <approve|minor|reject>   Record the senior's code review report (CODE_REVIEW)
  schema <STAGE> · block <KEY> <reason> · release <KEY> · search <query>
  status [KEY] [--json] · cycle [--loop]
  connectors [setup|get|check <json>|set <json>] [--json] Show/check the connectors, or set them up (get/check/set: used by the app)
  connectors github-choices <json|-> <requests|issues> <repositories|projects> List GitHub choices for a draft`;

/** The person at this machine: Git's user.name for this repository, otherwise the system user. */
export function quienSoy(repo: string): string | undefined {
  try {
    const n = execFileSync("git", ["config", "user.name"], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true }).trim();
    if (n) return n;
  } catch { /* no git or no name configured */ }
  try { return userInfo().username || undefined; } catch { return undefined; }
}

export async function runWorkflow(cmd: string, rest: string[]) {
  const cfg = loadConfig();
  const store = new Store(cfg.stateDir);
  warnLegacy(cfg);
  const connectors = buildConnectors(cfg.connectors);
  const flow = new Process(cfg, connectors, store, new GitWorkspace(cfg), new OpenSpecCli(cfg.openspecCmd, cfg.repoPath));

  const flag = (n: string) => { const i = rest.indexOf(`--${n}`); return i >= 0 ? (rest.splice(i, 2)[1] ?? "") : undefined; };
  const has = (n: string) => { const i = rest.indexOf(`--${n}`); if (i >= 0) rest.splice(i, 1); return i >= 0; };
  const agent = flag("agent") ?? (envWithLegacy(process.env, "ORQEN_AGENT", "REC_AGENT") || "agent");
  // Who is at this machine (analyst / support person): nobody has to type it. The connector account is usually a
  // shared bot that writes on the tickets; this name says which person did the work ("Mateo started analyzing…").
  const analyst = flag("analyst") || envWithLegacy(process.env, "ORQEN_ANALYST", "REC_ANALYST") || quienSoy(cfg.repoPath);
  const person = flag("person") || envWithLegacy(process.env, "ORQEN_SUPPORT", "REC_SUPPORT") || quienSoy(cfg.repoPath);

  /** Accepts the request key or the current issue key of a known request, and always returns the request key. */
  function toKey(key?: string): string {
    if (!key || store.get(key)) return key as string;
    const item = store.all().find((r) => r.key.toUpperCase() === key.toUpperCase() || r.issue?.toUpperCase() === key.toUpperCase());
    // unknown key: it is taken as a new request (the connector says whether it exists)
    return item?.key ?? key;
  }

  /** Guide to write the spec by lane (stages/specification.md; lines prefixed with [light] / [full] are filtered). */
  function specGuide(lane: string, key: string, change: string) {
    const prefix = /^(\s*)\[(light|full)\]\s*/;
    return readFileSync(join(cfg.stagesDir, stageGuideFile(cfg.stagesDir, "specification.md")), "utf8")
      .split("\n")
      .filter((l) => { const m = l.match(prefix); return !m || m[2] === lane; })
      .map((l) => l.replace(prefix, "$1"))
      .join("\n")
      .replaceAll("[light|full]", lane).replaceAll("<change>", change).replaceAll("<KEY>", key);
  }

  function guide(state: AgentState) {
    return readFileSync(join(cfg.stagesDir, stageGuideFile(cfg.stagesDir, `${state.toLowerCase()}.md`)), "utf8");
  }

  function renderTake(key: string, ctx: Record<string, any>) {
    const s = ctx.state as AgentState;
    const lane = s === "ANALYSIS"
      ? ["", "## Lane selection after analyst approval", `Once the analyst confirms: \`orqen lane ${key} <${LANES.join("|")}> --agent ${agent}\`.`,
         "The light and full lanes prepare a branch and change and print the spec instructions. The direct lane uses the analysis plan."]
      : [];
    const withHuman = ctx.human_present !== false;
    return [
      `# ${key} — stage ${s}`,
      "",
      withHuman
        ? "> **You are working with a person.** Before each important step, tell them what you are about to do and wait for their OK. " +
          "When in doubt, ask them (concrete options plus your recommendation) instead of assuming. See \"Working with the person\" in AGENTS.md. " +
          `Talk to them in ${ctx.language === "es" ? "Spanish" : "English"} (their system language).`
        : "> **Unattended mode: nobody can answer you.** Do not assume. If a doubt changes the outcome, run " +
          `\`orqen block ${key} "<specific question>"\`; a person answers it on the ticket.`,
      "",
      guide(s),
      "",
      "## Context",
      "```json", JSON.stringify(ctx, null, 2), "```",
      "",
      "## Expected output (JSON Schema)",
      "```json", JSON.stringify(jsonSchema(s), null, 2), "```",
      "",
      ...lane,
      "",
      "## Finish this stage",
      `Write the output to a file (e.g. \`/tmp/${key}-${s.toLowerCase()}.json\`) and run:`,
      "```sh", `orqen complete ${key} /tmp/${key}-${s.toLowerCase()}.json --agent ${agent}`, "```",
      "If validation fails, correct the reported errors and retry.",
      `If you cannot proceed: \`orqen block ${key} "<reason>"\`.`,
    ].join("\n");
  }

  async function cycle() {
    const pending = (await flow.review()).filter((p) => p.for === "agent" && !p.takenBy);
    for (const p of pending) {
      const prompt = `Process ${p.key} using the request workflow in AGENTS.md. Start with: orqen take ${p.key} --agent cycle`;
      const [bin, ...args] = partirComando(cfg.agentCmd);
      const usesPlaceholder = args.some((arg) => arg.includes("{prompt}"));
      console.log(`→ ${p.key} (${p.state}): ${cfg.agentCmd}`);
      const r = ejecutar(bin, usesPlaceholder ? args.map((arg) => arg.replace("{prompt}", prompt)) : args, {
        cwd: cfg.repoPath, heredar: true, entrada: usesPlaceholder ? undefined : prompt,
        env: { ...process.env, ORQEN_AGENT: "cycle" },
      });
      const item = store.get(p.key);
      if (item?.state === p.state && item.lock?.agent === "cycle") {
        await flow.block(p.key, `The agent finished (code ${r.codigo}) without completing stage ${p.state}.`, "cycle");
      }
    }
  }

  async function dispatch() {
    switch (cmd) {
      case "pending": {
        const p = await flow.review();
        if (has("json")) return console.log(JSON.stringify(p, null, 2));
        if (!p.length) return console.log("No requests with pending work.");
        for (const who of ["support", "analyst", "agent"] as const) {
          const xs = p.filter((x) => x.for === who);
          if (!xs.length) continue;
          console.log(who === "support" ? "For support (/orqen:support <KEY>; an analyst can still take a NEW one with /orqen:analyze):"
            : who === "analyst" ? "To analyze (/orqen:analyze <KEY>):" : "For an agent (orqen take <KEY>):");
          for (const x of xs) console.log(`  ${x.key.padEnd(12)} ${x.state.padEnd(15)} ${x.takenBy ? `(taken by ${x.takenBy})` : ""}`);
        }
        return;
      }
      case "support": {
        const key = rest[0];
        if (!key) { console.error("Usage: orqen support <KEY> [--person NAME]"); process.exitCode = 1; return; }
        try {
          const { context } = await flow.support(key, agent, person || agent);
          console.log(renderTake(key, context));
        } catch (e) {
          console.error(`✘ ${(e as Error).message}`);
          process.exitCode = 1;
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
          const key = toKey(rest[0]);
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
        try { key = toKey(rawKey); } catch (e) { console.error(`✘ ${(e as Error).message}`); process.exitCode = 1; return; }
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
          const key = toKey(rest[0]);
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
      case "review": {
        // before QA_REVIEW existed, `orqen review ... --verdict` recorded the senior's report: keep it working
        if (rest.includes("--verdict")) {
          console.error("⚠ `orqen review --verdict` is now `orqen code-review`; `orqen review` is the QA decision. Running code-review.");
          cmd = "code-review";
          return dispatch();
        }
        try {
          const reason = flag("reason") ?? "";
          const reportFile = flag("report");
          const key = toKey(rest[0]);
          const decision = rest[1] ?? "";
          if (!key || !decision) throw new Error('Usage: orqen review <KEY> approve|reject [--reason "<what to fix>"] [--report <report.md|->]');
          const report = reportFile === undefined ? "" : reportFile === "-" ? readFileSync(0, "utf8") : readFileSync(reportFile, "utf8");
          const r = await flow.qaReview(key, decision, reason, report, person || agent);
          console.log(`✔ QA review #${r.n} (${decision}) → ${r.next}${r.path ? ` · report: ${r.path}` : ""}`);
        } catch (e) {
          console.error(`✘ ${(e as Error).message}`);
          process.exitCode = 1;
        }
        return;
      }
      case "code-review": {
        try {
          const verdict = flag("verdict") ?? "";
          const key = toKey(rest[0]);
          if (!rest[1]) throw new Error("Usage: orqen code-review <KEY> <report.md|-> --verdict <approve|minor|reject>");
          const body = rest[1] === "-" ? readFileSync(0, "utf8") : readFileSync(rest[1], "utf8");
          const r = await flow.codeReview(key, body, verdict, agent);
          console.log(`✔ code review #${r.n} (${r.verdict}) → ${r.path}${r.committed ? " (committed)" : " (not committed: not on the request branch; it goes with the next commit of the branch)"}; ${r.commentedOn ? `commented on ${r.commentedOn}` : "NOT commented on the ticket (see the warning): paste it by hand"}`);
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
      case "block": await flow.block(toKey(rest[0]), rest.slice(1).join(" "), agent); return console.log("✔ blocked");
      case "release": flow.release(toKey(rest[0])); return console.log("✔ released");
      case "search": {
        const keys = (await connectors.requests.search(rest.join(" "))).slice(0, 20);
        const out = await Promise.all(keys.map(async (k: string) => {
          const i = await connectors.requests.ticket(k);
          return { key: k, title: i.title, status: i.status, url: i.url, description: i.description.slice(0, 500) };
        }));
        return console.log(JSON.stringify(out, null, 2));
      }
      case "status": {
        if (has("json")) {
          if (rest[0]) {
            const item = store.get(toKey(rest[0]));
            return console.log(JSON.stringify(item ? { ...item, events: store.events(item.key) } : null, null, 2));
          }
          return console.log(JSON.stringify(store.all().map((r) => ({
            key: r.key, state: r.state, issue: r.issue, lane: r.lane, route: r.route, round: r.round, branch: r.branch || undefined,
            change: r.change || undefined, analyst: r.analyst, supporter: r.supporter, lock: r.lock, devel_pr: r.artifacts.devel_pr,
            updated: store.events(r.key).at(-1)?.ts,
          })), null, 2));
        }
        if (rest[0]) {
          const key = toKey(rest[0]);
          const item = store.get(key);
          console.log(item ? JSON.stringify({ ...item, artifacts: Object.keys(item.artifacts) }, null, 2) : "unknown");
          for (const ev of store.events(key)) console.log(`  ${ev.ts}  ${ev.from} → ${ev.to}  ${ev.detail}`);
        } else for (const r of store.all()) console.log(`${r.key.padEnd(12)} ${r.state.padEnd(15)} ${(r.issue ?? "").padEnd(12)} ${r.change ?? ""}`);
        return;
      }
      case "connectors": {
        // used by the desktop app: {"conectores": {...}, "env": {"JIRA_TOKEN": "..."}} on stdin or in a file
        const draftInput = () => JSON.parse(!rest[1] || rest[1] === "-" ? readFileSync(0, "utf8") : readFileSync(rest[1], "utf8"));
        if (rest[0] === "general-get" || rest[0] === "general-set") {
          const { leerConfig, escribirConfig } = await import("../lib/config.ts");
          const { generalSettings, updateGeneral } = await import("../lib/general-settings.ts");
          const config = leerConfig(cfg.repoPath);
          const hasHistory = store.all().length > 0;
          if (rest[0] === "general-get") return console.log(JSON.stringify({ general: generalSettings(config), hasHistory }));
          const updated = updateGeneral(config, draftInput(), hasHistory);
          escribirConfig(cfg.repoPath, updated);
          return console.log(JSON.stringify({ general: updated.general, hasHistory }));
        }
        // the app's editor: current values (tokens masked) and a check of a draft before saving it
        if (rest[0] === "get") {
          const { connectorsView } = await import("../lib/connectors-edit.ts");
          const { existeConfig, leerConfig } = await import("../lib/config.ts");
          const { leerEnv } = await import("../lib/env.ts");
          const conectores = existeConfig(cfg.repoPath) ? leerConfig(cfg.repoPath).conectores : undefined;
          return console.log(JSON.stringify({ ...connectorsView(conectores, leerEnv(cfg.repoPath) ?? {}), legacy: cfg.connectors.legacy ?? [] }, null, 2));
        }
        if (rest[0] === "github-choices") {
          const { githubChoices, parseDraft } = await import("../lib/connectors-edit.ts");
          const { leerEnv } = await import("../lib/env.ts");
          return console.log(JSON.stringify(await githubChoices(parseDraft(draftInput()), { ...process.env, ...(leerEnv(cfg.repoPath) ?? {}) }, rest[2], rest[3]), null, 2));
        }
        if (rest[0] === "check") {
          const { checkDraft, parseDraft } = await import("../lib/connectors-edit.ts");
          const { leerEnv } = await import("../lib/env.ts");
          const result = await checkDraft(parseDraft(draftInput()), { ...process.env, ...(leerEnv(cfg.repoPath) ?? {}) });
          return console.log(JSON.stringify({ connectors: result }, null, 2));
        }
        if (rest[0] === "set") {
          const { parseDraft } = await import("../lib/connectors-edit.ts");
          const { leerConfig, escribirConfig } = await import("../lib/config.ts");
          const { leerEnv, escribirEnv, RUTA_ENV } = await import("../lib/env.ts");
          const { existsSync } = await import("node:fs");
          const draft = parseDraft(draftInput());
          const config = leerConfig(cfg.repoPath);
          config.conectores = draft.conectores;
          if (config.general) {
            const { updateGeneral } = await import("../lib/general-settings.ts");
            config.conectores = updateGeneral(config, config.general, false).conectores;
          }
          escribirConfig(cfg.repoPath, config);
          const env = draft.env;
          if (Object.keys(env).length) {
            const plantilla = join(cfg.repoPath, "orqen", ".env.example");
            escribirEnv(cfg.repoPath, existsSync(plantilla) ? readFileSync(plantilla, "utf8") : "", { ...(leerEnv(cfg.repoPath) ?? {}), ...env });
          }
          return console.log(`✔ Connectors saved in orqen/config.yaml${Object.keys(env).length ? ` and ${RUTA_ENV}` : ""}`);
        }
        if (rest[0] === "setup") {
          const { askConnectors } = await import("../lib/connectors-setup.ts");
          const { leerConfig, escribirConfig } = await import("../lib/config.ts");
          const { leerEnv, escribirEnv, RUTA_ENV } = await import("../lib/env.ts");
          const { existsSync } = await import("node:fs");
          const config = leerConfig(cfg.repoPath);
          const env = leerEnv(cfg.repoPath) ?? {};
          const r = await askConnectors(cfg.repoPath, config.conectores, env);
          config.conectores = r.conectores;
          escribirConfig(cfg.repoPath, config);
          const plantilla = join(cfg.repoPath, "orqen", ".env.example");
          escribirEnv(cfg.repoPath, existsSync(plantilla) ? readFileSync(plantilla, "utf8") : "", { ...env, ...r.env });
          console.log(`✔ Saved in orqen/config.yaml (conectores) and ${RUTA_ENV}. Check them with: orqen connectors`);
          return;
        }
        const show = async (role: "requests" | "issues") => {
          const t = connectors[role];
          if (!t) return { role, configured: false };
          const s = cfg.connectors[role]!;
          return { role, configured: true, kind: t.kind, label: t.label, transitions: s.transitions, ...(await t.check()) };
        };
        const out = [await show("requests"), await show("issues")];
        if (has("json")) return console.log(JSON.stringify({ connectors: out, legacy: cfg.connectors.legacy ?? [] }, null, 2));
        for (const c of out) {
          const name = c.role === "requests" ? "Requests (what the client sees)" : "Issues (development work)";
          if (!c.configured) { console.log(`${name}: not configured — the team works only on the requests.`); continue; }
          console.log(`${name}: ${"label" in c ? c.label : ""}\n  ${"ok" in c && c.ok ? "✔" : "✘"} ${"detail" in c ? c.detail : ""}`);
        }
        if (out.some((c) => "ok" in c && !c.ok)) process.exitCode = 1;
        return;
      }
      case "cycle":
        if (!has("loop")) return cycle();
        for (;;) { await cycle(); await new Promise((r) => setTimeout(r, cfg.intervalSec * 1000)); }
      default:
        console.log(WORKFLOW_HELP);
    }
  }
  return dispatch();
}
