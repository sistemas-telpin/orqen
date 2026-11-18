/**
 * GitHub Issues (+ optional GitHub Projects v2). Keys: <PREFIX>-<issue number> (GH-42 by default).
 * Token: GITHUB_TOKEN / GH_TOKEN in orqen/.env, or the session of the `gh` CLI. Needs the "repo" scope
 * and, with a project, "project".
 */
import { execFileSync } from "node:child_process";
import { type GithubSettings, idOf, keyOf } from "./config.ts";
import { BOT_MARK, type Comment, LEGACY_STATE_LABELS, type NewTicket, STATE_LABEL, type Ticket, type Tracker, checkFailure } from "./types.ts";

const API = "https://api.github.com";

export class GithubTracker implements Tracker {
  readonly kind = "github" as const;
  private token?: string;
  private projectCache?: { id: string; field?: { id: string; options: Array<{ id: string; name: string }> } };
  constructor(private s: GithubSettings, private api = API) {}
  get label() { return `GitHub ${this.s.repo || "(no repo)"}${this.s.project ? ` · project ${this.s.project.number}` : ""}`; }

  private auth() {
    if (this.token === undefined) {
      this.token = this.s.token;
      if (!this.token) {
        try { this.token = execFileSync("gh", ["auth", "token"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
        catch { this.token = ""; }
      }
    }
    if (!this.token) throw new Error("GitHub connector without token: set GITHUB_TOKEN in orqen/.env or log in with `gh auth login`");
    return this.token;
  }

  private async req(method: string, path: string, body?: unknown) {
    if (!this.s.repo && path.includes("{repo}")) throw new Error("GitHub connector without repo (conectores.*.repo: owner/name)");
    const r = await fetch(this.api + path.replace("{repo}", this.s.repo), {
      method,
      headers: { Authorization: `Bearer ${this.auth()}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`GitHub ${method} ${path.replace("{repo}", this.s.repo)}: ${r.status} ${await r.text()}`);
    const t = await r.text();
    return t ? JSON.parse(t) : {};
  }

  private async graphql(query: string, variables: Record<string, unknown>) {
    const r = await this.req("POST", "/graphql", { query, variables });
    if (r.errors?.length) throw new Error(`GitHub GraphQL: ${r.errors.map((e: any) => e.message).join("; ")}`);
    return r.data;
  }

  private n = (key: string) => idOf(this.s.prefix, key);

  /** Repositories visible to the current token, including organization memberships. */
  async repositories(): Promise<Array<{ repo: string }>> {
    const out: Array<{ repo: string }> = [];
    for (let page = 1; ; page++) {
      const rows = await this.req("GET", `/user/repos?per_page=100&sort=full_name&direction=asc&page=${page}`);
      out.push(...rows.map((r: { full_name: string }) => ({ repo: r.full_name })));
      if (rows.length < 100) return out;
    }
  }

  /** Projects belong to a user or organization, rather than to an individual repository. */
  async projects(owner: string): Promise<Array<{ number: number; title: string }>> {
    if (!owner) throw new Error("Select a GitHub repository before loading projects");
    const out: Array<{ number: number; title: string }> = [];
    let cursor: string | null = null;
    do {
      const d = await this.graphql(
        `query($owner:String!,$cursor:String){ repositoryOwner(login:$owner){ ... on ProjectV2Owner { projectsV2(first:100,after:$cursor){ nodes { number title } pageInfo { hasNextPage endCursor } } } } }`,
        { owner, cursor },
      );
      const projects = d?.repositoryOwner?.projectsV2;
      if (!projects) throw new Error(`GitHub projects for ${owner} are not accessible (check the token's project permissions)`);
      out.push(...projects.nodes.filter(Boolean).map((p: { number: number; title: string }) => ({ number: p.number, title: p.title })));
      cursor = projects.pageInfo.hasNextPage ? projects.pageInfo.endCursor : null;
    } while (cursor);
    return out;
  }

  /** A Project column is a field value, not text to search in the issue title/body. */
  async pending() {
    if (!this.s.project) {
      if (this.s.status) throw new Error("Select a GitHub Project before choosing a pending status");
      return this.search(this.s.query);
    }
    if (!this.s.status && this.s.query.includes(":")) return this.search(this.s.query);
    const project = await this.project();
    const oldColumn = project.field?.options.find((option) => option.name.toLowerCase() === this.s.query.trim().toLowerCase());
    const status = this.s.status || oldColumn?.name;
    if (!status) return this.search(this.s.query);
    if (!project.field?.options.some((option) => option.name.toLowerCase() === status.toLowerCase())) throw new Error(`GitHub Project has no "${status}" status in field "${this.s.project.field}"`);
    const keys: string[] = [];
    let cursor: string | null = null;
    do {
      const d = await this.graphql(
        `query($id:ID!,$cursor:String,$field:String!){ node(id:$id){ ... on ProjectV2 { items(first:100,after:$cursor){ nodes { isArchived fieldValueByName(name:$field){ ... on ProjectV2ItemFieldSingleSelectValue { name } } content { __typename ... on Issue { number state repository { nameWithOwner } } } } pageInfo { hasNextPage endCursor } } } } }`,
        { id: project.id, cursor, field: this.s.project.field },
      );
      const page = d?.node?.items;
      if (!page) throw new Error("Could not read the issues of the selected GitHub Project");
      for (const item of page.nodes ?? []) {
        const issue = item?.content;
        if (!item?.isArchived && item?.fieldValueByName?.name?.toLowerCase() === status.toLowerCase() &&
            issue?.__typename === "Issue" && issue.state === "OPEN" && issue.repository?.nameWithOwner?.toLowerCase() === this.s.repo.toLowerCase()) keys.push(keyOf(this.s.prefix, issue.number));
      }
      cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
    } while (cursor);
    // Preserve explicitly configured issue qualifiers as an additional filter.
    if (!oldColumn && this.s.query.trim() && this.s.query.trim() !== "is:open") {
      const matching = new Set(await this.search(this.s.query));
      return [...new Set(keys)].filter((key) => matching.has(key));
    }
    return [...new Set(keys)];
  }

  async statuses(): Promise<Array<{ value: string; label: string }>> {
    if (!this.s.project) return [];
    const project = await this.project();
    if (!project.field) throw new Error(`The GitHub Project has no "${this.s.project.field}" status field`);
    return project.field.options.map((option) => ({ value: option.name, label: option.name }));
  }

  async search(query: string) {
    const q = `repo:${this.s.repo} is:issue ${query}`.trim();
    const r = await this.req("GET", `/search/issues?per_page=100&q=${encodeURIComponent(q)}`);
    return (r.items ?? []).map((i: any) => keyOf(this.s.prefix, i.number));
  }

  async ticket(key: string): Promise<Ticket> {
    const i = await this.req("GET", `/repos/{repo}/issues/${this.n(key)}`);
    return {
      key, title: i.title, description: i.body ?? "", type: i.type?.name, reportedBy: i.user?.login, status: i.state,
      labels: (i.labels ?? []).map((l: any) => (typeof l === "string" ? l : l.name)), components: [], attachments: [], url: i.html_url,
    };
  }

  async comments(key: string): Promise<Comment[]> {
    const out: Comment[] = [];
    for (let page = 1; page <= 5; page++) {
      const r: any[] = await this.req("GET", `/repos/{repo}/issues/${this.n(key)}/comments?per_page=100&page=${page}`);
      out.push(...r.map((c) => ({ id: String(c.id), author: c.user?.login ?? "", authorName: c.user?.login ?? "", body: c.body ?? "", created: c.created_at ?? "" })));
      if (r.length < 100) break;
    }
    return out;
  }

  async comment(key: string, text: string) {
    await this.req("POST", `/repos/{repo}/issues/${this.n(key)}/comments`, { body: `${BOT_MARK} ${text}` });
  }

  async setStateLabel(key: string, state: string) {
    const { labels } = await this.ticket(key);
    const next = labels.filter((l) => ![STATE_LABEL, ...LEGACY_STATE_LABELS].some((p) => l.startsWith(p))).concat(`${STATE_LABEL}${state.toLowerCase()}`);
    await this.req("PUT", `/repos/{repo}/issues/${this.n(key)}/labels`, { labels: next });
  }

  async create(t: NewTicket) {
    const i = await this.req("POST", "/repos/{repo}/issues", { title: t.title.slice(0, 250), body: t.description, labels: [...this.s.labels, ...(t.labels ?? [])] });
    if (this.s.project) await this.addToProject(i.node_id);
    return keyOf(this.s.prefix, i.number);
  }

  /** Without a project: "closed"/"open" close or reopen the issue. With a project: moves it to that option of the field (Status). */
  async transition(key: string, name: string) {
    if (!this.s.project) {
      const state = name.toLowerCase();
      if (state !== "closed" && state !== "open") return false;
      await this.req("PATCH", `/repos/{repo}/issues/${this.n(key)}`, { state });
      return true;
    }
    const p = await this.project();
    const option = p.field?.options.find((o) => o.name.toLowerCase() === name.toLowerCase());
    if (!p.field || !option) return false;
    const issue = await this.req("GET", `/repos/{repo}/issues/${this.n(key)}`);
    const itemId = await this.addToProject(issue.node_id);
    await this.graphql(
      `mutation($p:ID!,$i:ID!,$f:ID!,$o:String!){ updateProjectV2ItemFieldValue(input:{projectId:$p,itemId:$i,fieldId:$f,value:{singleSelectOptionId:$o}}){ projectV2Item { id } } }`,
      { p: p.id, i: itemId, f: p.field.id, o: option.id },
    );
    return true;
  }

  private async project() {
    if (this.projectCache) return this.projectCache;
    const { owner, number, field } = this.s.project!;
    const d = await this.graphql(
      `query($owner:String!,$number:Int!){ repositoryOwner(login:$owner){ ... on ProjectV2Owner { projectV2(number:$number){ id fields(first:50){ nodes{ ... on ProjectV2SingleSelectField { id name options { id name } } } } } } } }`,
      { owner, number },
    );
    const proj = d?.repositoryOwner?.projectV2;
    if (!proj) throw new Error(`GitHub project ${owner}#${number} not found (does the token have the "project" scope?)`);
    const f = (proj.fields?.nodes ?? []).find((n: any) => n?.name?.toLowerCase() === field.toLowerCase());
    this.projectCache = { id: proj.id, field: f ? { id: f.id, options: f.options } : undefined };
    return this.projectCache;
  }

  /** Adds the issue to the project (idempotent: returns the existing item). */
  private async addToProject(contentId: string): Promise<string> {
    const p = await this.project();
    const d = await this.graphql(`mutation($p:ID!,$c:ID!){ addProjectV2ItemById(input:{projectId:$p,contentId:$c}){ item { id } } }`, { p: p.id, c: contentId });
    return d.addProjectV2ItemById.item.id;
  }

  url(key: string) { return `https://github.com/${this.s.repo}/issues/${this.n(key)}`; }

  async check() {
    try {
      const r = await this.req("GET", "/repos/{repo}");
      let extra = "";
      if (this.s.project) {
        const p = await this.project();
        if (this.s.status && !p.field?.options.some((option) => option.name.toLowerCase() === this.s.status!.toLowerCase())) throw new Error(`GitHub Project has no "${this.s.status}" status`);
        extra = p.field ? `, project ${this.s.project.number} (field ${this.s.project.field}: ${p.field.options.map((o) => o.name).join(", ")})` : `, project ${this.s.project.number} WITHOUT field "${this.s.project.field}"`;
      }
      return { ok: true, detail: `repo ${r.full_name}${extra}` };
    } catch (e) { return { ok: false, detail: checkFailure(e, this.api) }; }
  }
}
