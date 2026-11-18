/** Connectors: settings from config.yaml, compatibility with the old .env, and the GitHub / Asana clients against a local server. */
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import { join } from "node:path";
import test from "node:test";
import { connectorSettings, type AsanaSettings, type GithubSettings } from "../src/connectors/config.ts";
import { legacyConnectors, legacyToYaml } from "../src/connectors/legacy.ts";
import { AsanaTracker } from "../src/connectors/asana.ts";
import { GithubTracker } from "../src/connectors/github.ts";
import { JiraTracker } from "../src/connectors/jira.ts";
import { canLinkNatively, trackerFor } from "../src/connectors/index.ts";
import { isBotComment } from "../src/connectors/types.ts";
import { findApp } from "../src/lib/app.ts";

async function server(handler: (req: IncomingMessage, body: any) => [number, unknown]) {
  const calls: Array<{ method: string; path: string; body: any }> = [];
  const s = createServer(async (req, res) => {
    let raw = ""; for await (const part of req) raw += part;
    const body = raw ? JSON.parse(raw) : undefined;
    calls.push({ method: req.method!, path: req.url!, body });
    const [status, value] = handler(req, body);
    res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value));
  });
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(s.address() as { port: number }).port}`, calls, close: () => new Promise((r) => s.close(r)) };
}

test("config.yaml connectors: defaults per tool and credentials from orqen/.env", () => {
  const env = { JIRA_URL: "https://acme.atlassian.net", JIRA_USER: "bot", JIRA_TOKEN: "t", CLIENT_URL: "https://client.example", CLIENT_TOKEN: "c", ASANA_TOKEN: "a" };
  const ext = connectorSettings({ tipo: "jira", filtro: "project = SOP" }, env);
  assert.equal(ext.kind, "jira");
  assert.equal(ext.kind === "jira" && ext.deployment, "cloud");
  assert.equal(ext.kind === "jira" && ext.query, "project = SOP");
  const other = connectorSettings({ tipo: "jira", credenciales: "CLIENT", proyecto: "dev" }, env);
  assert.equal(other.kind === "jira" && other.url, "https://client.example");
  assert.equal(other.kind === "jira" && other.deployment, "server");
  assert.match(other.kind === "jira" ? other.query : "", /^project = dev AND labels = orqen/);
  const gh = connectorSettings({ tipo: "github", repo: "acme/app", proyecto: 7 }, {}) as GithubSettings;
  assert.deepEqual(gh.project, { owner: "acme", number: 7, field: "Status" });
  assert.equal(gh.query, "is:open label:orqen");
  assert.equal(gh.prefix, "GH");
  const as = connectorSettings({ tipo: "asana", proyecto: "1204", prefijo: "tk" }, env) as AsanaSettings;
  assert.deepEqual([as.token, as.tag, as.prefix], ["a", "orqen", "TK"]);
  assert.equal(canLinkNatively(trackerFor(ext), trackerFor(other)), false);
  assert.equal(canLinkNatively(trackerFor(ext), trackerFor(connectorSettings({ tipo: "jira", proyecto: "DEV" }, env))), true);
});

test("the .env of earlier versions still works and can be moved to config.yaml", () => {
  const env = { JIRA_URL: "https://x", REC_JQL: "project = SOPL", SIS_PROJECT: "DEV", SIS_TRANSITIONS: "CLOSED=Done", JIRA_TRANSITIONS: "CLOSED=Resuelto" };
  const c = legacyConnectors(env);
  assert.deepEqual(c.legacy, ["REC_JQL", "JIRA_TRANSITIONS", "SIS_PROJECT", "SIS_TRANSITIONS"]);
  assert.equal(c.requests.kind === "jira" && c.requests.query, "project = SOPL");
  assert.equal(c.issues?.kind === "jira" && c.issues.project, "DEV");
  assert.deepEqual(legacyToYaml(env), {
    requests: { tipo: "jira", filtro: "project = SOPL", transiciones: { CLOSED: "Resuelto" } },
    issues: { tipo: "jira", proyecto: "DEV", tipo_ticket: "Task", tipo_operativo: "Task", vinculo: "Relates", transiciones: { CLOSED: "Done" } },
  });
  // a new .env has no issue unless config.yaml says so
  assert.equal(legacyConnectors({ JIRA_URL: "https://x" }).issues, undefined);
  assert.ok(isBotComment("[orqen] hi") && isBotComment("[rec-agente] hi") && !isBotComment("hi"));
});

test("GitHub: issues as tickets, comments, labels, and the Status field of a project", async (t) => {
  let labels = ["orqen"];
  const s = await server((req, body) => {
    const u = req.url!;
    if (u.startsWith("/search/issues")) return [200, { items: [{ number: 4 }, { number: 9 }] }];
    if (u === "/repos/acme/app/issues/4" && req.method === "GET") return [200, { number: 4, node_id: "I_4", title: "Export", body: "CSV", state: "open", user: { login: "client" }, labels: labels.map((name) => ({ name })), html_url: "https://github.com/acme/app/issues/4" }];
    if (u.startsWith("/repos/acme/app/issues/4/comments") && req.method === "GET") return [200, [{ id: 1, user: { login: "client" }, body: "/approve", created_at: "x" }]];
    if (u === "/repos/acme/app/issues/4/comments") return [201, {}];
    if (u === "/repos/acme/app/issues/4/labels") { labels = body.labels; return [200, []]; }
    if (u === "/repos/acme/app/issues") return [201, { number: 12, node_id: "I_12" }];
    if (u === "/graphql") {
      if (body.query.includes("repositoryOwner")) return [200, { data: { repositoryOwner: { projectV2: { id: "P", fields: { nodes: [{}, { id: "F", name: "Status", options: [{ id: "o1", name: "Todo" }, { id: "o2", name: "In progress" }] }] } } } } }];
      if (body.query.includes("addProjectV2ItemById")) return [200, { data: { addProjectV2ItemById: { item: { id: `item-${body.variables.c}` } } } }];
      return [200, { data: { updateProjectV2ItemFieldValue: { projectV2Item: { id: "x" } } } }];
    }
    return [404, { message: u }];
  });
  t.after(s.close);
  const gh = new GithubTracker(connectorSettings({ tipo: "github", repo: "acme/app", proyecto: 3 }, { GITHUB_TOKEN: "tk" }) as GithubSettings, s.url);
  assert.deepEqual(await gh.pending(), ["GH-4", "GH-9"]);
  assert.match(decodeURIComponent(s.calls[0].path), /q=repo:acme\/app is:issue is:open label:orqen/);
  const tk = await gh.ticket("GH-4");
  assert.deepEqual([tk.title, tk.description, tk.reportedBy, tk.url], ["Export", "CSV", "client", "https://github.com/acme/app/issues/4"]);
  assert.equal((await gh.comments("GH-4"))[0].body, "/approve");
  await gh.comment("GH-4", "hello");
  assert.equal(s.calls.at(-1)!.body.body, "[orqen] hello");
  await gh.setStateLabel("GH-4", "DEVELOPMENT");
  assert.deepEqual(labels, ["orqen", "orqen-state-development"]);
  assert.equal(await gh.transition("GH-4", "in progress"), true);
  assert.deepEqual(s.calls.at(-1)!.body.variables, { p: "P", i: "item-I_4", f: "F", o: "o2" });
  assert.equal(await gh.transition("GH-4", "Nope"), false);
  assert.equal(await gh.create({ title: "[SOP-1] Export", description: "d", route: "development", labels: ["lane-direct"] }), "GH-12");
  assert.deepEqual(s.calls.find((c) => c.path === "/repos/acme/app/issues" && c.method === "POST")!.body.labels, ["orqen", "lane-direct"]);
  assert.ok(s.calls.some((c) => c.body?.variables?.c === "I_12"), "the new issue goes to the project");
  await assert.rejects(gh.ticket("SOP-4"), /not a GH-<number> key/);
});

test("GitHub choices: token-visible repositories and owner projects are paginated without requiring a repo", async (t) => {
  const s = await server((req, body) => {
    assert.equal(req.headers.authorization, "Bearer draft-token");
    if (req.url!.startsWith("/user/repos?")) {
      const page = new URL(req.url!, "http://localhost").searchParams.get("page");
      return [200, page === "1" ? Array.from({ length: 100 }, (_, n) => ({ full_name: `org/repo-${n}` })) : [{ full_name: "org/private" }]];
    }
    assert.equal(req.url, "/graphql");
    assert.equal(body.variables.owner, "org");
    return [200, { data: { repositoryOwner: { projectsV2: {
      nodes: [{ number: body.variables.cursor ? 9 : 3, title: body.variables.cursor ? "Delivery" : "Support" }],
      pageInfo: { hasNextPage: !body.variables.cursor, endCursor: body.variables.cursor ? null : "next" },
    } } } }];
  });
  t.after(s.close);
  const gh = new GithubTracker(connectorSettings({ tipo: "github" }, { GITHUB_TOKEN: "draft-token" }) as GithubSettings, s.url);
  const repos = await gh.repositories();
  assert.equal(repos.length, 101);
  assert.deepEqual(repos.at(-1), { repo: "org/private" });
  assert.deepEqual(await gh.projects("org"), [{ number: 3, title: "Support" }, { number: 9, title: "Delivery" }]);
  await assert.rejects(gh.projects(""), /Select a GitHub repository/);
});

test("GitHub project choices propagate permission errors instead of presenting an empty list", async (t) => {
  const s = await server(() => [200, { errors: [{ message: "Resource not accessible by personal access token" }] }]);
  t.after(s.close);
  const gh = new GithubTracker(connectorSettings({ tipo: "github" }, { GITHUB_TOKEN: "t" }) as GithubSettings, s.url);
  await assert.rejects(gh.projects("org"), /Resource not accessible/);
});

test("general Jira prefixes translate requests, creation, links and URLs to native project keys", async (t) => {
  const s = await server((req) => {
    if (req.url!.startsWith("/rest/api/3/search/jql")) return [200, { issues: [{ key: "SUP-42" }] }];
    if (req.url === "/rest/api/2/issue" && req.method === "POST") return [201, { key: "SUP-43" }];
    if (req.url!.startsWith("/rest/api/2/issue/SUP-42?") && req.method === "GET") return [200, { fields: { summary: "Request", labels: [] } }];
    return [200, {}];
  });
  t.after(s.close);
  const settings = connectorSettings({ tipo: "jira", proyecto: "SUP", url: s.url }, { JIRA_DEPLOYMENT: "cloud", JIRA_USER: "bot", JIRA_TOKEN: "test" }, "REQ");
  assert.equal(settings.kind, "jira");
  if (settings.kind !== "jira") return;
  const jira = new JiraTracker(settings);
  assert.deepEqual(await jira.pending(), ["REQ-42"]);
  assert.equal((await jira.ticket("REQ-42")).key, "REQ-42");
  await jira.comment("REQ-42", "Approved");
  assert.equal(s.calls.at(-1)?.path, "/rest/api/2/issue/SUP-42/comment");
  assert.equal(await jira.create({ title: "Ticket", description: "Work", route: "development" }), "REQ-43");
  await jira.link("REQ-42", "REQ-43");
  assert.deepEqual(s.calls.at(-1)?.body.inwardIssue, { key: "SUP-42" });
  assert.deepEqual(s.calls.at(-1)?.body.outwardIssue, { key: "SUP-43" });
  assert.equal(jira.url("REQ-42"), `${s.url}/browse/SUP-42`);
  assert.equal(jira.url("SUP-42"), `${s.url}/browse/SUP-42`);
  assert.equal(canLinkNatively(jira, new JiraTracker({ ...settings, prefix: "TKT" })), false);
});

test("Asana: tagged tasks of the project, stories as comments, sections as transitions", async (t) => {
  const s = await server((req, body) => {
    const u = req.url!;
    if (u.startsWith("/projects/77/tasks")) return [200, { data: [{ gid: "11", tags: [{ name: "orqen" }] }, { gid: "12", tags: [] }] }];
    if (u.startsWith("/tasks/11/stories") && req.method === "GET") return [200, { data: [{ gid: "s1", type: "system", text: "moved" }, { gid: "s2", type: "comment", text: "/approve", created_by: { gid: "u1", name: "Cli" } }] }];
    if (u === "/tasks/11/stories") return [201, { data: {} }];
    if (u.startsWith("/tasks/11")) return [200, { data: { name: "Export", notes: "CSV", completed: false, tags: [{ name: "orqen" }], permalink_url: "https://app.asana.com/0/77/11" } }];
    if (u === "/projects/77/sections") return [200, { data: [{ gid: "sec1", name: "En desarrollo" }] }];
    if (u === "/sections/sec1/addTask") return [200, { data: {} }];
    if (u === "/tasks" && req.method === "POST") return [201, { data: { gid: "99" } }];
    return [404, { errors: [u] }];
  });
  t.after(s.close);
  const as = new AsanaTracker(connectorSettings({ tipo: "asana", proyecto: "77" }, { ASANA_TOKEN: "x" }) as AsanaSettings, s.url);
  assert.deepEqual(await as.pending(), ["AS-11"]);
  assert.equal((await as.ticket("AS-11")).description, "CSV");
  assert.deepEqual((await as.comments("AS-11")).map((c) => [c.authorName, c.body]), [["Cli", "/approve"]]);
  await as.comment("AS-11", "hola");
  assert.deepEqual(s.calls.at(-1)!.body, { data: { text: "[orqen] hola" } });
  assert.equal(await as.transition("AS-11", "en desarrollo"), true);
  assert.deepEqual(s.calls.at(-1)!.body, { data: { task: "11" } });
  assert.equal(await as.transition("AS-11", "Otra"), false);
  assert.equal(await as.create({ title: "t", description: "d", route: "operational" }), "AS-99");
  assert.deepEqual(s.calls.at(-1)!.body.data.projects, ["77"]);
});

test("orqen opens the desktop app when it is installed", () => {
  const has = (...paths: string[]) => (p: string) => paths.includes(p);
  const win = join("C:/U/AppData/Local", "Programs", "ORQEN", "ORQEN.exe");
  assert.equal(findApp("win32", { LOCALAPPDATA: "C:/U/AppData/Local" }, has(win), "/h", ""), win);
  assert.equal(findApp("darwin", {}, has(join("/h", "Applications", "ORQEN.app")), "/h", ""), join("/h", "Applications", "ORQEN.app"));
  assert.equal(findApp("linux", { PATH: "/usr/bin:/usr/local/bin" }, has(join("/usr/local/bin", "orqen-desktop")), "/h", ""), join("/usr/local/bin", "orqen-desktop"));
  assert.equal(findApp("linux", { ORQEN_APP: "/x/app" }, has("/x/app"), "/h"), "/x/app");
  assert.equal(findApp("linux", { PATH: "" }, has(), "/h", ""), undefined);
  const dev = join("/src/orqen/cli/dist", "..", "..", "app", "target", "release", "orqen-desktop");
  assert.equal(findApp("linux", { PATH: "" }, has(dev), "/h", "/src/orqen/cli/dist/index.js"), dev);
});
