/** Black-box CLI fixture: real HTTP Jira client, Git, OpenSpec and installed templates. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { escribirConfig, leerConfig } from "../src/lib/config.ts";
import { normalizar } from "../src/lib/kit.ts";
import { ejecutarAsync } from "../src/lib/proc.ts";
import { bajarProcesos } from "../src/lib/processes.ts";
import { type Rec, Store } from "../src/workflow/store.ts";
import { FakeJira } from "./fakes.ts";
import { catalogoTemporal, repoTemporal } from "./helpers.ts";

export const CLI = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const OPENSPEC = fileURLToPath(new URL(`../node_modules/.bin/openspec${process.platform === "win32" ? ".cmd" : ""}`, import.meta.url));
const catalog = catalogoTemporal();
const transitions = ["In Progress", "Done"];

export async function workflowFixture(t: TestContext, deployment = "server") {
  assert.ok(existsSync(CLI), "Build the CLI first: npm run test:e2e");
  assert.ok(existsSync(OPENSPEC), "Install the repository's OpenSpec dev dependency");
  const root = repoTemporal({}, false), repo = join(root, "project");
  mkdirSync(repo);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-qb", "main"); git("config", "user.name", "E2E"); git("config", "user.email", "e2e@example.test");
  writeFileSync(join(repo, "README.md"), "# E2E invoice project\n");
  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "e2e-project", type: "module", scripts: { test: "node test.mjs" } }));
  writeFileSync(join(repo, "export.mjs"), "export const exportCsv = () => '';\n");
  writeFileSync(join(repo, "test.mjs"), "import assert from 'node:assert/strict'; import { exportCsv } from './export.mjs'; assert.equal(exportCsv([{n: 1}]), 'n\\n1');\n");
  const jira = new FakeJira({ "REC-7": { title: "Export invoices to CSV", description: "Accounting needs a CSV export", labels: ["rec-agente"] } });
  const requests: string[] = [];
  let failLinks = 0;
  const server = createServer(async (req, res) => {
    const send = (status: number, value: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
    try {
      assert.equal(req.headers.authorization, deployment === "cloud" ? `Basic ${Buffer.from("bot@example.test:test-only").toString("base64")}` : "Bearer test-only");
      const url = new URL(req.url!, "http://localhost"), path = url.pathname;
      requests.push(`${req.method} ${path}`);
      let raw = ""; for await (const part of req) raw += part;
      const body = raw ? JSON.parse(raw) : {};
      if (req.method === "GET" && ["/rest/api/2/search", "/rest/api/3/search/jql"].includes(path)) return send(200, { issues: Object.keys(jira.issues).filter((key) => key.startsWith((url.searchParams.get("jql")?.match(/project\s*=\s*([A-Z]+)/i)?.[1] ?? "REC") + "-")).map((key) => ({ key })) });
      if (path === "/rest/api/2/issue" && req.method === "POST") {
        const f = body.fields;
        const key = await jira.createIssue({ project: f.project.key, type: f.issuetype.name, title: f.summary, description: f.description });
        return send(201, { key });
      }
      if (path === "/rest/api/2/issueLink" && req.method === "POST") {
        if (failLinks-- > 0) return send(503, { error: "temporary link failure" });
        await jira.link(body.inwardIssue.key, body.outwardIssue.key, body.type.name); return send(201, {});
      }
      const match = path.match(/^\/rest\/api\/2\/issue\/([A-Z]+-\d+)(?:\/(comment|transitions))?$/);
      if (!match || !jira.issues[match[1]]) return send(404, { error: "unknown endpoint or issue" });
      const [, key, sub] = match;
      if (sub === "comment") {
        if (req.method === "POST") { jira.human(key, "bot", body.body); return send(201, {}); }
        return send(200, { comments: (await jira.comments(key)).map((c) => ({ ...c, author: { accountId: c.author, name: c.author, displayName: c.authorName } })) });
      }
      if (sub === "transitions") {
        if (req.method === "POST") { await jira.transition(key, transitions[Number(body.transition.id)]); return send(204, {}); }
        return send(200, { transitions: transitions.map((name, id) => ({ id: String(id), name })) });
      }
      if (req.method === "PUT") { Object.assign(jira.issues[key], body.fields); return send(204, {}); }
      const issue = await jira.issue(key);
      return send(200, { key, fields: { summary: issue.title, description: issue.description, labels: issue.labels, status: { name: "Open" } } });
    } catch (e) { send(500, { error: (e as Error).message }); }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const stateDir = join(repo, "orqen/state"), transcript = join(root, "commands.jsonl");
  const prScript = join(root, "open-pr.mjs");
  writeFileSync(prScript, "console.log('https://github.example.test/team/project/pull/1');\n");
  const env: NodeJS.ProcessEnv = {
    ...process.env, NO_COLOR: "1", ORQEN_LANG: "en", ORQEN_TOOLS_DIR: catalog, ORQEN_TOOLS_REPO: "@example/catalog",
    REPO_PATH: repo, REC_STATE_DIR: stateDir, FACTORY_DIR: join(repo, "orqen/work"), BASE_BRANCH: "main",
    JIRA_URL: `http://127.0.0.1:${port}`, JIRA_DEPLOYMENT: deployment, JIRA_USER: "bot@example.test", JIRA_TOKEN: "test-only",
    REC_JQL: "project = REC", REC_AGENT: "e2e", SUPPORT_STAGE: "on", SIS_PROJECT: "SIS", SIS_TYPE: "Task", SIS_LINK: "Relates",
    SIS_TRANSITIONS: "DEVELOPMENT=In Progress,CLOSED=Done", JIRA_TRANSITIONS: "CLOSED=Done",
    APPROVERS_ANALYSIS: "analyst", APPROVERS_CODE: "senior", APPROVERS_CLIENT: "client", APPROVERS_EXECUTION: "dba",
    CODE_REVIEW_GATE: "jira", GITHUB_REVIEWERS: "senior", DEVEL_BRANCH: "desarrollo",
    DEVEL_PR_COMMAND: `node "${prScript}"`, OPENSPEC_CMD: OPENSPEC, TEST_COMMAND: "node test.mjs",
    OPENSPEC_TELEMETRY_DISABLED: "1",
  };
  let commandCount = 0;
  async function command(args: string[], options: { input?: string; exit?: number } = {}) {
    const result = await ejecutarAsync(process.execPath, [CLI, ...args], { cwd: repo, env, entrada: options.input, timeoutMs: 90_000 });
    commandCount++;
    appendFileSync(transcript, JSON.stringify({ args, exit: result.codigo, stdout: result.stdout, stderr: result.stderr }) + "\n");
    assert.equal(result.codigo, options.exit ?? 0, `orqen ${args.join(" ")}\n${result.stdout}\n${result.stderr}\nTranscript: ${transcript}`);
    return result.stdout;
  }
  const record = () => new Store(stateDir).get("REC-7")!;
  const context = (output: string) => JSON.parse(output.match(/## Context\s+```json\s+([\s\S]*?)```/)![1]);
  const complete = (key: string, data: unknown, exit = 0) => command(["complete", key, "-"], { input: JSON.stringify(data), exit });
  async function human(author: string, message: string) {
    jira.human("REC-7", author, message);
    await command(["pending", "--json"]);
    return record();
  }
  function state(expected: Rec["state"]) { assert.equal(record().state, expected); }
  function file(path: string, content: string) { mkdirSync(join(repo, path, ".."), { recursive: true }); writeFileSync(join(repo, path), content); }
  t.after(async () => {
    bajarProcesos(repo);
    await new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve()));
    t.diagnostic(`${commandCount} compiled CLI commands; transcript and fixtures: ${root}`);
  });
  await command(["init", "--yes", "--no-ai", "--no-openspec"]);
  const config = leerConfig(repo);
  config.entornos = { procesos: [], variables: {}, preparar: [], migrar: [], seed: [], tests: { unitarios: "node test.mjs" } };
  escribirConfig(repo, config);
  git("add", "."); git("commit", "-qm", "Initialize fixture with installed ORQEN kit");
  const remote = join(root, "remote.git");
  execFileSync("git", ["init", "--bare", "-q", remote]);
  git("remote", "add", "origin", remote); git("push", "-qu", "origin", "main");
  return { root, repo, remote, git, jira, env, command, complete, context, record, state, file, human, requests, failNextLink: () => { failLinks = 1; } };
}

export type WorkflowFixture = Awaited<ReturnType<typeof workflowFixture>>;
export const analysis = (over: Record<string, unknown> = {}) => ({
  summary: "Accounting needs to export invoice numbers to a CSV file.", type: "feature",
  acceptance_criteria: ["CSV includes the header and invoice number"], affected_capabilities: ["invoice-export"], open_questions: [], risks: [],
  ready: true, analyst_ok: true, route: "development", lane: "direct", lane_rationale: "One pure function with a small, agreed scope.",
  plan: ["Implement CSV export and cover the acceptance criterion (1h)"], estimated_hours: 1, ...over,
});
export const development = { completed: true, changes_summary: "Implement CSV export with the agreed header", modified_files: ["export.mjs"], added_tests: ["test.mjs"] };
export const delivery = { release_notes: "CSV export is available.", client_message: "You can now export invoice numbers as a CSV with its header.", validation_steps: ["Export one invoice and check the CSV header and number"] };
export const implementation = "export const exportCsv = (invoices) => ['n', ...invoices.map(f => f.n)].join('\\n');\n";

export async function supportEscalation(f: WorkflowFixture) {
  const pending = JSON.parse(await f.command(["pending", "--json"]));
  assert.equal(pending[0].for, "support");
  await f.command(["support", "REC-7", "--person", "Support Person"]);
  await f.complete("REC-7", { summary: "The requested invoice export does not exist yet.", checked: ["Issue, comments and current code"], outcome: "escalate", escalation_summary: "A code change is needed to provide the requested CSV export.", support_ok: true });
  f.state("ANALYSIS");
  const ctx = f.context(await f.command(["analyze", "REC-7", "--analyst", "Analyst"]));
  assert.equal(ctx.previous_stages.SUPPORT.outcome, "escalate");
}

export async function implementWithSwarm(f: WorkflowFixture) {
  const sis = f.record().sis!;
  const ctx = f.context(await f.command(["take", sis]));
  assert.equal(ctx.state, "DEVELOPMENT");
  assert.equal(ctx.environment.ok, true);
  const task = join(f.root, "task.md"), plan = join(f.root, "plan.json"), worker = join(f.root, "worker.mjs"), planner = join(f.root, "planner.mjs");
  writeFileSync(task, `Implement ${sis}\nApproved context:\n${JSON.stringify(ctx, null, 2)}`);
  writeFileSync(plan, JSON.stringify({ summary: `Implement ${sis}`, subtasks: [{ id: "csv", title: "CSV export", description: "Implement the approved invoice CSV export", files: ["export.mjs"], test: "node test.mjs" }], finalTest: "node test.mjs" }));
  writeFileSync(planner, `import {readFileSync} from 'node:fs'; const prompt=readFileSync(0,'utf8'); if(!prompt.includes('${sis}')) process.exit(2); console.log(readFileSync(${JSON.stringify(plan)},'utf8'));`);
  writeFileSync(worker, `import {readFileSync, writeFileSync} from 'node:fs'; const prompt = readFileSync(0, 'utf8'); if (!prompt.includes('${sis}') || !prompt.includes('acceptance_criteria')) process.exit(2); writeFileSync('export.mjs', ${JSON.stringify(implementation)});`);
  const report = JSON.parse(await f.command(["swarm", "--file", task, "--planner", `node "${planner}"`, "--small", `node "${worker}"`, "--large", `node "${worker}"`, "--yes", "--json", "--apply"]));
  assert.equal(report.ok, true); assert.equal(report.applied, true);
  assert.equal(f.git("branch", "--show-current"), "rec/rec-7");
  assert.equal(normalizar(readFileSync(join(f.repo, "export.mjs"), "utf8")), implementation);
}

export async function testAndReview(f: WorkflowFixture, completeDevelopment = true) {
  const sis = f.record().sis!;
  const previousPr = f.record().artifacts.devel_pr;
  if (completeDevelopment) await f.complete(sis, development);
  f.state("TESTING");
  const ctx = f.context(await f.command(["take", sis]));
  assert.equal(ctx.test_result.ok, true, ctx.test_result.output);
  await f.complete(sis, { scenarios: ctx.scenarios.map((s: { requirement: string; scenario: string }) => ({ ...s, covered: true, test: "test.mjs" })), failure_diagnosis: "", suggestions: [], coverage_ok: true });
  f.state("CODE_REVIEW");
  assert.equal(f.record().artifacts.devel_pr, previousPr, "Testing must not open or replace the PR");
  const info = JSON.parse(await f.command(["pr", sis])); assert.equal(info.base, "desarrollo");
  const body = "Implement the agreed CSV export for accounting. The header and invoice numbers are covered by test.mjs. Verify by exporting an invoice and checking its CSV contents.";
  await f.command(["pr", sis, "-"], { input: body });
  await f.command(["review", sis, "-", "--verdict", "approve"], { input: "Approve. The implementation matches the approved analysis, the CSV scenario is covered by test.mjs, and no additional changes or risks were identified." });
  f.state("CODE_REVIEW");
}
