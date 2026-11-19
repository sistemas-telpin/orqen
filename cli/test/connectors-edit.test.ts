/** Connectors editor of the desktop app: `orqen connectors get | check - | set -`. No network. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { checkDraft, connectorsView, credentialsPrefix, githubChoices, mask, parseDraft } from "../src/lib/connectors-edit.ts";
import { MONOREPO, repoTemporal } from "./helpers.ts";

const CLI = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const TSX = fileURLToPath(new URL("../node_modules/tsx/dist/cli.mjs", import.meta.url));
const catalogo = join(repoTemporal(), "unavailable-catalog");

function orqen(cwd: string, input: string | undefined, ...args: string[]) {
  const r = spawnSync(process.execPath, [TSX, CLI, ...args], {
    cwd, input, encoding: "utf8",
    env: { ...process.env, ORQEN_USER_CONFIG_DIR: join(catalogo, "user"), NO_COLOR: "1", ORQEN_TOOLS_DIR: catalogo, ORQEN_TOOLS_REPO: "not-a-github-repository", JIRA_URL: "", JIRA_USER: "", JIRA_TOKEN: "", GITHUB_TOKEN: "", GH_TOKEN: "" },
  });
  return { codigo: r.status, salida: r.stdout, error: r.stderr };
}

test("the view never shows a secret in clear and ignores template placeholders and unrelated variables", () => {
  const v = connectorsView({ requests: { tipo: "jira", filtro: "project = SOP" }, issues: { tipo: "asana", credenciales: "TEAM", proyecto: "1204" } }, {
    JIRA_URL: "https://acme.atlassian.net", JIRA_USER: "bot@acme.com", JIRA_TOKEN: "abcd1234efgh5678",
    TEAM_TOKEN: "short", ASANA_TOKEN: "your-company-token", OPENAI_API_KEY: "sk-zzz", BASE_BRANCH: "main",
  });
  assert.deepEqual(v.env, { JIRA_URL: "https://acme.atlassian.net", JIRA_USER: "bot@acme.com" });
  assert.deepEqual(v.secrets, { JIRA_TOKEN: "••••5678", TEAM_TOKEN: "••••" });
  assert.equal(v.conectores?.requests.tipo, "jira");
  assert.equal(mask("abcdefghi"), "••••fghi");
  assert.equal(credentialsPrefix({ tipo: "github" }), "GITHUB");
});

test("a draft is validated and empty values mean keep the current one", () => {
  const d = parseDraft({ conectores: { requests: { tipo: "github", repo: "acme/web" } }, env: { GITHUB_TOKEN: "  ", JIRA_URL: " https://x.atlassian.net " } });
  assert.deepEqual(d.env, { JIRA_URL: "https://x.atlassian.net" });
  assert.throws(() => parseDraft({ conectores: { requests: { tipo: "trello" } } }), /Invalid connectors/);
});

test("checking a draft uses its secrets over the current ones and saves nothing", async () => {
  const r = await checkDraft(parseDraft({ conectores: { requests: { tipo: "jira", filtro: "x" } }, env: {} }), {});
  assert.equal(r[0].configured, true);
  assert.equal(r[0].ok, false);
  assert.match(r[0].detail ?? "", /without URL/);
  assert.deepEqual(r[1], { role: "issues", configured: false });
});

test("GitHub discovery uses the selected role, draft credentials and project owner without saving", async (t) => {
  const calls: Array<{ url: string; auth: string | null; body: any }> = [];
  const fakeFetch = t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, auth: new Headers(init.headers).get("Authorization"), body: init.body ? JSON.parse(String(init.body)) : undefined });
    if (url.includes("/user/repos")) return Response.json([{ full_name: "team/private" }]);
    return Response.json({ data: { repositoryOwner: { projectsV2: { nodes: [{ number: 3, title: "Support" }], pageInfo: { hasNextPage: false } } } } });
  });
  const draft = parseDraft({ conectores: {
    requests: { tipo: "github" }, issues: { tipo: "github", credenciales: "TEAM", repo: "team/private", duenio_proyecto: "projects-owner" },
  }, env: { TEAM_TOKEN: "draft-token" } });
  const before = JSON.stringify(draft);
  assert.deepEqual(await githubChoices(draft, { TEAM_TOKEN: "saved-token" }, "issues", "repositories"), { ok: true, items: [{ repo: "team/private" }] });
  assert.deepEqual(await githubChoices(draft, {}, "issues", "projects"), { ok: true, items: [{ number: 3, title: "Support" }] });
  assert.equal(calls[0].auth, "Bearer draft-token");
  assert.equal(calls[1].body.variables.owner, "projects-owner");
  assert.equal(JSON.stringify(draft), before);
  fakeFetch.mock.mockImplementation(async () => Response.json({ message: "Bad credentials" }, { status: 401 }));
  const failure = await githubChoices(draft, {}, "issues", "repositories");
  assert.equal(failure.ok, false);
  assert.match("detail" in failure ? failure.detail ?? "" : "", /GitHub answered 401/);
  assert.doesNotMatch(JSON.stringify(failure), /draft-token/);
  await assert.rejects(githubChoices(draft, {}, "invalid", "repositories"), /connector role/);
  await assert.rejects(githubChoices(draft, {}, "external", "invalid"), /repositories or projects/);
});

test("orqen connectors set / get / check: what the app's editor runs", () => {
  const repo = repoTemporal(MONOREPO);
  assert.equal(orqen(repo, undefined, "init", "--yes", "--no-ai", "--no-openspec").codigo, 0);
  const draft = {
    conectores: { requests: { tipo: "jira", proyecto: "SOP", filtro: "project = SOP AND labels = orqen", transiciones: { DELIVERY: "Entregado" } }, issues: { tipo: "github", repo: "acme/web", proyecto: 7 } },
    env: { JIRA_URL: "https://acme.atlassian.net", JIRA_USER: "bot@acme.com", JIRA_TOKEN: "secret-token-1234", GITHUB_TOKEN: "" },
  };
  const set = orqen(repo, JSON.stringify(draft), "connectors", "set", "-");
  assert.equal(set.codigo, 0, set.error);
  const cfg = parse(readFileSync(join(repo, "orqen/config.yaml"), "utf8"));
  assert.equal(cfg.connectors.requests.transitions.DELIVERY, "Entregado");   // config.yaml in English; the JSON of the app keeps its names
  if (existsSync(join(repo, "orqen/.env"))) assert.doesNotMatch(readFileSync(join(repo, "orqen/.env"), "utf8"), /secret-token-1234/);
  assert.match(readFileSync(join(catalogo, "user", "providers.env"), "utf8"), /JIRA_TOKEN=secret-token-1234/);

  const get = orqen(repo, undefined, "connectors", "get", "--json");
  assert.equal(get.codigo, 0, get.error);
  const v = JSON.parse(get.salida);
  assert.equal(v.conectores.issues.repo, "acme/web");
  assert.equal(v.env.JIRA_USER, "bot@acme.com");
  assert.equal(v.secrets.JIRA_TOKEN, "••••1234");
  assert.doesNotMatch(get.salida, /secret-token/);

  // a draft with a broken URL is checked without touching config.yaml
  const before = readFileSync(join(repo, "orqen/config.yaml"), "utf8");
  const check = orqen(repo, JSON.stringify({ conectores: { requests: { tipo: "jira", url: "not a url", filtro: "x" } }, env: {} }), "connectors", "check", "-");
  assert.equal(check.codigo, 0, check.error);
  const c = JSON.parse(check.salida.slice(check.salida.indexOf("{")));
  assert.equal(c.connectors[0].ok, false);
  assert.equal(c.connectors[1].configured, false);
  assert.equal(readFileSync(join(repo, "orqen/config.yaml"), "utf8"), before);

  const general = orqen(repo, undefined, "connectors", "general-get");
  assert.equal(general.codigo, 0, general.error);
  assert.deepEqual(JSON.parse(general.salida).general.prefijos, { requests: "SOP", issues: "GH" });
  const saveGeneral = orqen(repo, JSON.stringify({ prefijos: { requests: "req", issues: "tkt" } }), "connectors", "general-set", "-");
  assert.equal(saveGeneral.codigo, 0, saveGeneral.error);
  assert.deepEqual(JSON.parse(saveGeneral.salida).general.prefijos, { requests: "REQ", issues: "TKT" });
  const savedGeneral = parse(readFileSync(join(repo, "orqen/config.yaml"), "utf8"));
  assert.equal(savedGeneral.general.prefixes.requests, "REQ");
  assert.equal(savedGeneral.connectors.requests.filter, draft.conectores.requests.filtro);
  if (existsSync(join(repo, "orqen/.env"))) assert.doesNotMatch(readFileSync(join(repo, "orqen/.env"), "utf8"), /secret-token-1234/);
  // Saving providers later preserves the independently configured prefixes.
  const saveProviders = orqen(repo, JSON.stringify(draft), "connectors", "set", "-");
  assert.equal(saveProviders.codigo, 0, saveProviders.error);
  assert.deepEqual(parse(readFileSync(join(repo, "orqen/config.yaml"), "utf8")).general, savedGeneral.general);
});

test("a failed check says which host could not be reached and why", async () => {
  const { checkFailure } = await import("../src/connectors/types.ts");
  const e = Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } });
  assert.equal(checkFailure(e, "https://acme.atlassian.net"), "could not reach acme.atlassian.net (the host does not exist or there is no DNS)");
  assert.equal(checkFailure(new Error("Jira 401: Unauthorized"), "https://x"), "Jira 401: Unauthorized");
});

test("an HTTP error from the tool reads as a sentence, not as raw JSON", async () => {
  const { checkFailure } = await import("../src/connectors/types.ts");
  assert.equal(checkFailure(new Error('GitHub GET /repos/acme/web: 401 {\n  "message": "Bad credentials",\n  "documentation_url": "https://docs.github.com/rest"\n}'), "https://api.github.com"),
    "GitHub answered 401 (wrong user or token): Bad credentials");
  assert.equal(checkFailure(new Error(`Jira GET /rest/api/2/project/SUP: 404 {"errorMessages":["No project could be found with key 'SUP'."]}`), "https://acme.atlassian.net"),
    "Jira answered 404 (not found: check the project or repository): No project could be found with key 'SUP'.");
});

test("names of earlier versions are still read: externo/interno, requerimientos/tickets, and internal on saved requests", async () => {
  const d = parseDraft({ conectores: { externo: { tipo: "github", repo: "acme/web" }, interno: { tipo: "asana", proyecto: "12" } } });
  assert.deepEqual([d.conectores.requests.tipo, d.conectores.issues?.tipo], ["github", "asana"]);
  assert.equal("externo" in d.conectores, false);
  const { General } = await import("../src/lib/config.ts");
  assert.deepEqual(General.parse({ prefijos: { requerimientos: "req", tickets: "dev" } }).prefijos, { requests: "REQ", issues: "DEV" });
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { Store } = await import("../src/workflow/store.ts");
  const dir = mkdtempSync(join(repoTemporal(), "state-"));
  writeFileSync(join(dir, "REQ-1.json"), JSON.stringify({ key: "REQ-1", state: "DEVELOPMENT", round: 1, branch: "", change: "", internal: "DEV-3",
    artifacts: { internal_linked: true, previous_internal: ["DEV-1"] }, feedback: [] }));
  const item = new Store(dir).get("REQ-1")!;
  assert.equal(item.issue, "DEV-3");
  assert.deepEqual([item.artifacts.issue_linked, item.artifacts.previous_issues], [true, ["DEV-1"]]);
});
