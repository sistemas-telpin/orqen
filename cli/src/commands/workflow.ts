/** Workflow commands shared by the repository wrapper and the installed CLI. */
import { ejecutar, partirComando } from "../lib/proc.ts";
import { providerEnv, saveProviders, providerFile } from "../lib/provider-credentials.ts";
import { stageGuideFile } from "../lib/stage-guides.ts";
import { lessonsFor } from "./eval.ts";
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

export const WORKFLOW_COMMANDS = ["list", "qa", "approve", "merged", "cancel", "new_worq", "pending", "support", "analyze", "ask", "conversation", "lane", "take", "complete", "pr", "review", "code-review", "schema", "block", "release", "search", "status", "worqs", "worq", "cycle", "connectors", "comments", "comment"];

/** What people run: the 9 steps (as /orqen:* commands in their agent) and the CLI commands meant for a person. */
export const WORKFLOW_HELP = `The 9 steps (run the /orqen:* commands in your agent: it calls the CLI for you):
  1 /orqen:list requests     orqen list requests [--json] [--all]   Everyone's work list, by role (takes nothing)
  2 /orqen:support <KEY>     First-line support: answer the client or escalate to the analyst
  3 /orqen:analyze <KEY>     Analysis with the analyst: criteria, lane, spec and the issue
  4 /orqen:list issues       orqen list issues [--json]             Development queue (free, taken, came back)
  5 /orqen:implement <KEY>   Implement; the testing runs on its own afterwards
  6 /orqen:pr <KEY>          Explain the changes and open the integration PR
  7 /orqen:review <KEY>      QA (full lane only): check the e2e on screen, approve or reject
  8 /orqen:list prs          orqen list prs [--json]                Senior's queue: PRs to review or to merge, with CI and conflicts
  9 /orqen:approve <KEY>     Senior: approve the PR or request changes; after the hand merge, run it again to deliver

Request commands for people:
  ask <KEY> <question>        Ask the requester on their ticket from any stage (/orqen:ask in the agent)
  conversation <KEY>          Refresh and show the request comments saved in the worq's conversation.json
  status [KEY] [--json]       Where a request is, who acts and what comes next (no KEY: all of them)
  worqs [--all] [--json]      The worqs on this machine: orqen's unit of work, one per request (request + issue + branch + PR + record)
  worq <KEY> [--json]         One worq: state, request, issue, branch, PR and the files of its record in orqen/worqs/<KEY>/
  merged <KEY> [--person N]   Confirm the hand merge of an approved PR when orqen cannot read it from GitHub
  new_worq "<title>" <brief.json|->  Worq with no request: creates its issue in the connector, skips support and analysis, born in DEVELOPMENT
  cancel <KEY> --reason T     Close the request without delivering it: closes the PR unmerged, comments both tickets (CANCELLED)
  release <KEY>               Free a request held by an agent that is no longer working on it
  comments <KEY> [--json]     Read the request and its conversation with the client
  comment <KEY> <file|->      Reply to the client on the request (--person NAME)
  connectors [setup]          Show and check the connectors (requests and issues), or set them up
  cycle [--loop]              Unattended mode (cron/CI/server): agent stages only, never support or analysis

Agent-only commands (the /orqen:* commands run them) and JSON for tools: orqen help internal`;

/** What only the agent runs (inside the /orqen:* commands) and the JSON commands for tools such as orqen-gui. */
export const WORKFLOW_INTERNAL_HELP = `Agent-only commands (the /orqen:* commands run them; a person does not need them):
  support <KEY> [--person NAME]          2 · Open or resume first-line support and print the context
  analyze <KEY> [--analyst NAME]         3 · Open or resume the analysis and print the context
  lane <KEY> <direct|light|full>         3 · Record the lane (light/full: branch + OpenSpec change)
  take <KEY> [--agent NAME]              5 · Claim an agent stage, prepare branch and environment (also EXECUTION/VERIFICATION)
  complete <KEY> <output.json|->         Validate a stage's output and advance the workflow
  schema <STAGE>                         JSON Schema of a stage's output
  pr <KEY> [<explanation.md>] [--title T]   6 · No file: where the branch goes. With file: commit + push + PR
  review <KEY> approve|reject [--reason TEXT] [--report FILE]   7 · QA decision (QA_REVIEW, full lane)
  approve <KEY> [--changes <comment.md|->] [--force] [--person NAME]   9 · Senior: approve the PR (not with red CI or conflicts) or request changes
  code-review <KEY> <report.md|-> --verdict <approve|minor|reject>   9 · Record the senior's optional PR report (does not decide)
  block <KEY> <reason>                   Escalate to a person on the ticket
  search <query>                         Search tickets (precedents, related work)

Older names (still work, with a notice): pending → list requests · qa → review

JSON for tools (orqen-gui):
  status [KEY] --json · list requests|issues|prs --json · usage --json · tutorial --step <n> --json
  spec [KEY|change] --json [--dir <worktree>]   the spec in the neutral model of src/sdd (any SDD tool)
  connectors get|check <json>|set <json>|general-get|general-set [--json]
  connectors github-choices <json|-> <requests|issues> <repositories|projects|statuses>
  bootstrap --list --json · bootstrap --describe <stack> --json`;

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
  const personFlag = flag("person");
  const person = personFlag || envWithLegacy(process.env, "ORQEN_SUPPORT", "REC_SUPPORT") || quienSoy(cfg.repoPath);
  /** QA and the senior: the person at this machine (or --person). */
  const me = personFlag || quienSoy(cfg.repoPath);

  /** Accepts the request key or the current issue key of a known request, and always returns the request key. */
  function toKey(key?: string): string {
    if (!key || flow.item(key)) return key as string;
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
      // the feedback loop: what the team corrected in this stage before (orqen learn --apply)
      ...(() => { const l = lessonsFor(cfg.repoPath, s); return l ? [l, ""] : []; })(),
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
      case "ask":
      case "conversation": {
        if (!/^[\w-][\w.-]*$/.test(rest[0] ?? "") || (cmd === "conversation" && rest.length !== 1)) {
          throw new Error(`Usage: orqen ${cmd} <KEY>${cmd === "ask" ? " <question>" : ""}`);
        }
        const key = toKey(rest[0]);
        if (cmd === "conversation") {
          console.log(JSON.stringify(await flow.conversation(key), null, 2));
        } else {
          const { warning } = await flow.ask(key, rest.slice(1).join(" "));
          console.log(`Question posted to ${key}. Conversation saved in ${flow.worqRel(key)}/conversation.json`);
          if (warning) console.log(`⚠ ${warning}`);
        }
        return;
      }
      case "list": {
        const what = (rest[0] ?? "requests").toLowerCase();
        const json = has("json"), all = has("all");
        const ciText = (c?: { ci: string; conflicts?: boolean; detail?: string }) => !c ? "" :
          ` · CI: ${c.ci}${c.detail && c.ci !== "passing" ? ` (${c.detail})` : ""}${c.conflicts ? " · CONFLICTS with the base branch" : ""}`;
        if (!["requests", "issues", "prs"].includes(what)) { console.error("Usage: orqen list <requests|issues|prs> [--json]"); process.exitCode = 1; return; }
        if (what === "prs") {
          const q = await flow.prQueue();
          if (json) return console.log(JSON.stringify(q, null, 2));
          if (!q.length) return console.log("No PRs waiting for code review or merge.");
          for (const b of q) console.log(`  ${b.work.padEnd(12)} ${(b.lane ?? "").padEnd(7)} ${b.pr}\n${"".padEnd(15)}${b.qa ? `QA ${b.qa} · ` : ""}review: ${b.review?.status}${b.review?.detail ? ` (${b.review.detail})` : ""}${ciText(b.checks)}`);
          return;
        }
        const board = await flow.board(all);
        if (what === "issues") {
          const q = board.filter((b) => b.state === "DEVELOPMENT");
          if (json) return console.log(JSON.stringify(q, null, 2));
          if (!q.length) return console.log("No issues in development.");
          for (const b of q) console.log(`  ${b.work.padEnd(12)} ${(b.lane ?? "").padEnd(7)} ${b.estimated_hours !== undefined ? `${b.estimated_hours}h`.padEnd(6) : "".padEnd(6)} ${b.takenBy ? `taken by ${b.takenBy}` : "free"}${b.returned ? `  ↩ ${b.returned.split("\n")[0].slice(0, 80)}` : ""}`);
          return;
        }
        if (json) return console.log(JSON.stringify(board, null, 2));
        if (!board.length) return console.log("No open requests.");
        const titles: Record<string, string> = { support: "Support (L1)", analyst: "Analyst (L2)", developer: "Development", qa: "QA", senior: "Senior", client: "Waiting for the client", gate: "Waiting for an approval on the request", blocked: "Blocked", done: "Closed" };
        for (const role of Object.keys(titles)) {
          const xs = board.filter((b) => b.role === role);
          if (!xs.length) continue;
          console.log(`${titles[role]}:`);
          for (const b of xs) console.log(`  ${b.work.padEnd(12)} ${b.state.padEnd(15)} ${(b.next[0]?.command ?? "").padEnd(28)} ${b.takenBy ? `(taken by ${b.takenBy} since ${b.since?.slice(0, 16).replace("T", " ")})` : ""}${b.recovered ? "  ← state read from the ticket; this machine has no record" : ""}`);
        }
        return;
      }
      case "qa": {
        console.error("[orqen] `orqen qa` is now `orqen review <KEY> approve|reject --report <file>`; this name still works.");
        try {
          const verdict = flag("verdict") ?? "";
          const key = toKey(rest[0]);
          if (!rest[1]) throw new Error("Usage: orqen qa <KEY> <report.md|-> --verdict <approve|reject>");
          const body = rest[1] === "-" ? readFileSync(0, "utf8") : readFileSync(rest[1], "utf8");
          const r = await flow.qaReview(key, verdict, body, body, me || "qa");
          console.log(`✔ QA review #${r.n} (${verdict}) → ${r.next}${r.path ? ` · report: ${r.path}` : ""}`);
        } catch (e) {
          console.error(`✘ ${(e as Error).message}`);
          process.exitCode = 1;
        }
        return;
      }
      case "approve": {
        try {
          const changes = flag("changes"), force = has("force");
          const comment = flag("comment");
          const key = toKey(rest[0]);
          if (!key) throw new Error("Usage: orqen approve <KEY> [--changes <comment.md|->] [--comment <text>]");
          const body = changes !== undefined ? (changes === "-" || changes === "" ? readFileSync(0, "utf8") : readFileSync(changes, "utf8")) : (comment ?? "");
          const r = await flow.decide(key, changes !== undefined ? "changes" : "approve", body, me || "senior", agent, force);
          if (r.state === "DEVELOPMENT") console.log(`✔ changes requested on ${r.url}: back to development`);
          else console.log(r.onGitHub ? `✔ PR approved on GitHub (${r.url}) → ${r.state}`
            : `✔ Approval recorded in the tickets (${r.url}) → ${r.state}. The gate is "ticket": no review was posted on GitHub.`);
          if (r.warning) console.log(`⚠ ${r.warning}`);
        } catch (e) {
          console.error(`✘ ${(e as Error).message}`);
          process.exitCode = 1;
        }
        return;
      }
      case "new_worq": {
        try {
          const title = rest[0] ?? "";
          const src = rest[1];
          if (!title || !src) throw new Error('Usage: orqen new_worq "<title>" <brief.json|-> [--person NAME]   (brief: {"description", "acceptance_criteria": [...], "plan": [...], "estimated_hours"})');
          const raw = JSON.parse(src === "-" ? readFileSync(0, "utf8") : readFileSync(src, "utf8"));
          const r = await flow.newWorq(title, raw, me || agent);
          console.log(`✔ ${r.key} created in ${r.state}: issue ${r.url} (no client request) · worq: ${r.dir}/`);
          console.log(`  Next: /orqen:implement ${r.key}`);
        } catch (e) {
          console.error(`✘ ${(e as Error).message}`);
          process.exitCode = 1;
        }
        return;
      }
      case "cancel": {
        try {
          const reason = flag("reason") ?? "";
          const key = toKey(rest[0]);
          if (!key) throw new Error("Usage: orqen cancel <KEY> --reason <text> [--person NAME]");
          const r = await flow.cancel(key, reason, me || agent, agent);
          console.log(`✔ ${rest[0]} cancelled${r.pr === "closed" ? ` · PR closed without merging (${r.url})` : r.pr === "open" ? ` · close the PR by hand: ${r.url}` : r.pr === "merged" ? ` · the PR was already merged: revert it by hand if needed` : ""}`);
        } catch (e) {
          console.error(`✘ ${(e as Error).message}`);
          process.exitCode = 1;
        }
        return;
      }
      case "merged": {
        try {
          const key = toKey(rest[0]);
          if (!key) throw new Error("Usage: orqen merged <KEY> [--person NAME]");
          const m = await flow.confirmMerge(key, me || agent);
          console.log(`✔ PR merge recorded${m.by ? ` (${m.by})` : ""}: continue the delivery with /orqen:approve ${rest[0]}`);
        } catch (e) {
          console.error(`✘ ${(e as Error).message}`);
          process.exitCode = 1;
        }
        return;
      }
      case "pending": {
        if (!rest.includes("--json")) console.error("[orqen] `orqen pending` is now `orqen list requests` (by role, with the next command); this name still works.");
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
      case "worqs": {
        const { isFinal } = await import("../workflow/states.ts");
        const all = has("all"), json = has("json");
        const list = store.all().filter((r) => all || !isFinal(r.state)).map((r) => flow.worq(r));
        if (json) return console.log(JSON.stringify(list, null, 2));
        if (!list.length) return console.log("No worqs on this machine. `orqen list requests` shows the open requests (a worq starts when orqen takes one).");
        console.log(`Worqs (orqen's unit of work), ${all ? "all" : "open"}:`);
        for (const w of list) console.log(`  ${w.key.padEnd(10)} ${(w.issue ?? "").padEnd(10)} ${w.state.padEnd(15)} ${(w.lane ?? "").padEnd(7)} ${w.dir}${w.pr ? `  PR ${w.pr}` : w.branch ? `  ${w.branch}` : ""}`);
        return;
      }
      case "worq": {
        try {
          const key = toKey(rest[0]);
          const json = has("json");
          if (!key) throw new Error("Usage: orqen worq <KEY> [--json]");
          const item = flow.item(key) ?? await flow.peek(key);
          if (!item) throw new Error(`${key} is not a worq on this machine. \`orqen list requests\` shows the open requests; a worq starts when orqen takes one.`);
          const { worqFiles } = await import("../lib/worqs.ts");
          const w = flow.worq(item);
          const files = item.recovered ? [] : worqFiles(join(cfg.factoryDir, item.key));
          const events = store.events(item.key);
          if (json) return console.log(JSON.stringify({ ...w, files, events: events.slice(-10) }, null, 2));
          console.log(`Worq ${w.key}${w.title ? ` — ${w.title}` : ""}`);
          console.log(`  State:    ${w.state}${w.round > 1 ? ` (round ${w.round})` : ""}${w.lane ? ` · lane ${w.lane}` : ""}${w.route && w.route !== "development" ? ` · ${w.route}` : ""}`);
          if (w.next[0]) console.log(`  Next:     ${w.next[0].command}  (${w.role}: ${w.next[0].what})`);
          console.log(`  Request:  ${w.key}  ${w.request_url}`);
          if (w.issue) console.log(`  Issue:    ${w.issue}${w.issue_url ? `  ${w.issue_url}` : ""}`);
          if (w.branch) console.log(`  Branch:   ${w.branch}`);
          if (w.pr) console.log(`  PR:       ${w.pr}${w.merged ? " (merged)" : ""}`);
          if (w.supporter || w.analyst) console.log(`  People:   ${[w.supporter && `support ${w.supporter}`, w.analyst && `analyst ${w.analyst}`].filter(Boolean).join(" · ")}`);
          if (item.recovered) console.log("  The state is read from the ticket's label: this machine has no record. Fetch its branch to recover the worq (git fetch origin " + (w.branch ?? `orqen/${key.toLowerCase()}`) + ").");
          else {
            console.log(`  Folder:   ${w.dir}/`);
            for (const f of files) console.log(`            ${f}`);
            if (!files.length) console.log(`            (no files in this checkout${w.branch ? `: they are in the branch ${w.branch}` : ""})`);
          }
          for (const ev of events.slice(-5)) console.log(`  ${ev.ts.slice(0, 16).replace("T", " ")}  ${ev.from} → ${ev.to}  ${ev.detail}`);
        } catch (e) {
          console.error(`✘ ${(e as Error).message}`);
          process.exitCode = 1;
        }
        return;
      }
      case "status": {
        if (has("json")) {
          if (rest[0]) {
            const k = toKey(rest[0]);
            const item = flow.item(k) ?? await flow.peek(k);
            const b = item ? flow.boardItem(item) : undefined;
            return console.log(JSON.stringify(item ? { ...item, role: b!.role, next: b!.next, qa_status: b!.qa, returned: b!.returned, events: store.events(item.key) } : null, null, 2));
          }
          return console.log(JSON.stringify(store.all().map((r) => ({
            key: r.key, title: r.title ?? r.artifacts?.ANALYSIS?.summary, state: r.state, issue: r.issue, lane: r.lane, route: r.route, round: r.round, branch: r.branch || undefined,
            change: r.change || undefined, analyst: r.analyst, supporter: r.supporter, lock: r.lock, devel_pr: r.artifacts?.devel_pr,
            updated: store.events(r.key).at(-1)?.ts,
          })), null, 2));
        }
        if (rest[0]) {
          const key = toKey(rest[0]);
          const item = flow.item(key) ?? await flow.peek(key);
          console.log(item ? JSON.stringify({ ...item, artifacts: Object.keys(item.artifacts) }, null, 2) : "unknown");
          if (item?.recovered) console.log(`State read from the ticket's label: this machine has no record of ${key}. Fetch its branch (git fetch origin orqen/${key.toLowerCase()}) to recover the full record.`);
          for (const ev of store.events(key)) console.log(`  ${ev.ts}  ${ev.from} → ${ev.to}  ${ev.detail}`);
        } else for (const r of store.all()) console.log(`${r.key.padEnd(12)} ${r.state.padEnd(15)} ${(r.issue ?? "").padEnd(12)} ${r.change ?? ""}`);
        return;
      }
      case "connectors": {
        // JSON for tools such as orqen-gui: {"conectores": {...}, "env": {"JIRA_TOKEN": "..."}} on stdin or in a file
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
        // a connectors editor (orqen-gui): current values (tokens masked) and a check of a draft before saving it
        if (rest[0] === "get") {
          const { connectorsView } = await import("../lib/connectors-edit.ts");
          const { existeConfig, leerConfig } = await import("../lib/config.ts");
          const { leerEnv } = await import("../lib/env.ts");
          const conectores = existeConfig(cfg.repoPath) ? leerConfig(cfg.repoPath).conectores : undefined;
          return console.log(JSON.stringify({ ...connectorsView(conectores, providerEnv(cfg.repoPath)), legacy: cfg.connectors.legacy ?? [] }, null, 2));
        }
        if (rest[0] === "github-choices") {
          const { githubChoices, parseDraft } = await import("../lib/connectors-edit.ts");
          const { leerEnv } = await import("../lib/env.ts");
          return console.log(JSON.stringify(await githubChoices(parseDraft(draftInput()), providerEnv(cfg.repoPath), rest[2], rest[3]), null, 2));
        }
        if (rest[0] === "check") {
          const { checkDraft, parseDraft } = await import("../lib/connectors-edit.ts");
          const { leerEnv } = await import("../lib/env.ts");
          const result = await checkDraft(parseDraft(draftInput()), providerEnv(cfg.repoPath));
          return console.log(JSON.stringify({ connectors: result }, null, 2));
        }
        if (rest[0] === "set") {
          const { parseDraft } = await import("../lib/connectors-edit.ts");
          const { leerConfig, escribirConfig } = await import("../lib/config.ts");
          const { leerEnv, escribirEnv, RUTA_ENV } = await import("../lib/env.ts");
          const { existsSync } = await import("node:fs");
          const draft = parseDraft(draftInput());
          const config = leerConfig(cfg.repoPath);
          const { withSuggestedTransitions } = await import("../lib/connectors-edit.ts");
          const suggested = await withSuggestedTransitions(draft.conectores, { ...providerEnv(cfg.repoPath), ...draft.env });
          draft.conectores = suggested.conectores;
          config.conectores = draft.conectores;
          if (config.general) {
            const { updateGeneral } = await import("../lib/general-settings.ts");
            config.conectores = updateGeneral(config, config.general, false).conectores;
          }
          const keys = saveProviders(draft.conectores, draft.env, providerEnv(cfg.repoPath));
          escribirConfig(cfg.repoPath, config);
          const local = leerEnv(cfg.repoPath) ?? {};
          const clear: Record<string, string> = {};
          for (const key of keys) if (local[key]) clear[key] = "";
          if (Object.keys(clear).length) {
            const file = join(cfg.repoPath, RUTA_ENV);
            escribirEnv(cfg.repoPath, readFileSync(file, "utf8"), clear);
          }
          console.log(`✔ Connectors saved in orqen/config.yaml. Provider accounts saved for this user in ${providerFile()}`);
          if (suggested.added.length) console.log(`  Ticket moves proposed from the project columns for: ${suggested.added.join(", ")} (edit transitions in orqen/config.yaml).`);
          return;
        }
        if (rest[0] === "setup") {
          const { askConnectors } = await import("../lib/connectors-setup.ts");
          const { leerConfig, escribirConfig } = await import("../lib/config.ts");
          const { existsSync } = await import("node:fs");
          const config = leerConfig(cfg.repoPath);
          const env = providerEnv(cfg.repoPath);
          const r = await askConnectors(cfg.repoPath, config.conectores, env);
          config.conectores = r.conectores;
          saveProviders(r.conectores, r.env, env);
          escribirConfig(cfg.repoPath, config);
          console.log("✔ Providers saved for this user. Project resource selection saved in orqen/config.yaml.");
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
      case "comments": {
        const json = has("json");
        const key = toKey(rest[0]);
        if (!key) { console.error("Usage: orqen comments <KEY> [--json]"); process.exitCode = 1; return; }
        const { readClientChat } = await import("./client-chat.ts");
        const chat = await readClientChat(connectors.requests, key);
        if (json) return console.log(JSON.stringify(chat, null, 2));
        console.log(`${chat.key} · ${chat.title} (${chat.tool})`);
        for (const m of chat.messages) console.log(`\n${m.from === "team" ? "→" : "←"} ${m.author || (m.from === "team" ? "orqen" : "client")}${m.created ? `  ${m.created.slice(0, 16).replace("T", " ")}` : ""}\n${m.text}`);
        return;
      }
      case "comment": {
        try {
          const key = toKey(rest[0]);
          if (!key || !rest[1]) throw new Error("Usage: orqen comment <KEY> <message.md|-> [--person NAME]");
          const text = rest[1] === "-" ? readFileSync(0, "utf8") : readFileSync(rest[1], "utf8");
          const { replyToClient } = await import("./client-chat.ts");
          await replyToClient(connectors.requests, key, text, me);
          console.log(`✔ answered on ${key}`);
        } catch (e) {
          console.error(`✘ ${(e as Error).message}`);
          process.exitCode = 1;
        }
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
