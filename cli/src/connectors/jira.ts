/** Jira Cloud and Server / Data Center (REST v2; search uses v3 on Cloud). */
import { type JiraSettings, idOf, keyOf } from "./config.ts";
import { BOT_MARK, type Comment, LEGACY_STATE_LABELS, type NewTicket, STATE_LABEL, type Ticket, type Tracker, checkFailure } from "./types.ts";

export class JiraTracker implements Tracker {
  readonly kind = "jira" as const;
  private base: string;
  private auth: string;
  constructor(private s: JiraSettings) {
    this.base = s.url.replace(/\/$/, "");
    this.auth = s.deployment === "cloud"
      ? "Basic " + Buffer.from(`${s.user}:${s.token}`).toString("base64")
      : `Bearer ${s.token}`;
  }
  get label() { return `Jira${this.s.project ? ` ${this.s.project}` : ""} (${this.base.replace(/^https?:\/\//, "") || "no URL"})`; }

  /** ORQEN role prefixes are independent of the native Jira project key. */
  private native(key: string): string {
    if (!this.s.prefix || !key.toUpperCase().startsWith(`${this.s.prefix}-`)) return key;
    if (!this.s.project) throw new Error("Select a Jira project before using a general prefix");
    return keyOf(this.s.project, idOf(this.s.prefix, key));
  }

  private alias(key: string): string {
    if (!this.s.prefix) return key;
    if (!this.s.project || !key.toUpperCase().startsWith(`${this.s.project.toUpperCase()}-`)) throw new Error("The Jira filter returned a different project. Use one Jira project per connector with general prefixes.");
    return keyOf(this.s.prefix, key.slice(key.lastIndexOf("-") + 1));
  }

  private async req(method: string, path: string, body?: unknown, params?: Record<string, string | number>) {
    if (!this.base) throw new Error("Jira connector without URL: set it in config.yaml (url) or in orqen/.env");
    const url = new URL(this.base + path);
    for (const [k, v] of Object.entries(params ?? {})) url.searchParams.set(k, String(v));
    const r = await fetch(url, {
      method,
      headers: { Authorization: this.auth, Accept: "application/json", "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`Jira ${method} ${path}: ${r.status} ${await r.text()}`);
    const t = await r.text();
    return t ? JSON.parse(t) : {};
  }

  pending() { return this.search(this.s.query); }

  async search(jql: string) {
    const path = this.s.deployment === "cloud" ? "/rest/api/3/search/jql" : "/rest/api/2/search";
    const r = await this.req("GET", path, undefined, { jql, fields: "key", maxResults: 100 });
    return (r.issues ?? []).map((i: any) => this.alias(i.key));
  }

  async ticket(key: string): Promise<Ticket> {
    const r = await this.req("GET", `/rest/api/2/issue/${this.native(key)}`, undefined, {
      fields: "summary,description,issuetype,priority,reporter,labels,status,attachment,components",
    });
    const f = r.fields;
    return {
      key, title: f.summary, description: f.description ?? "", type: f.issuetype?.name,
      priority: f.priority?.name, reportedBy: f.reporter?.displayName, status: f.status?.name,
      labels: f.labels ?? [], components: (f.components ?? []).map((c: any) => c.name),
      attachments: (f.attachment ?? []).map((a: any) => a.filename), url: this.url(key),
    };
  }

  async comments(key: string): Promise<Comment[]> {
    const r = await this.req("GET", `/rest/api/2/issue/${this.native(key)}/comment`, undefined, { maxResults: 500, orderBy: "created" });
    return (r.comments ?? []).map((c: any) => ({
      id: String(c.id), author: c.author?.accountId ?? c.author?.name ?? "",
      authorName: c.author?.displayName ?? "", body: c.body ?? "", created: c.created ?? "",
    }));
  }

  async comment(key: string, text: string) {
    await this.req("POST", `/rest/api/2/issue/${this.native(key)}/comment`, { body: `${BOT_MARK} ${text}` });
  }

  async setStateLabel(key: string, state: string) {
    const { labels } = await this.ticket(key);
    const next = labels.filter((l) => ![STATE_LABEL, ...LEGACY_STATE_LABELS].some((p) => l.startsWith(p))).concat(`${STATE_LABEL}${state.toLowerCase()}`);
    await this.req("PUT", `/rest/api/2/issue/${this.native(key)}`, { fields: { labels: next } });
  }

  async create(t: NewTicket) {
    if (!this.s.project) throw new Error("The Jira connector has no project (conectores.interno.proyecto) to create tickets in");
    const r = await this.req("POST", "/rest/api/2/issue", {
      fields: {
        project: { key: this.s.project }, issuetype: { name: t.route === "operational" ? this.s.operationalType : this.s.issueType },
        summary: t.title.slice(0, 250), description: t.description, labels: t.labels ?? [],
      },
    });
    return this.alias(r.key);
  }

  async link(from: string, to: string) {
    await this.req("POST", "/rest/api/2/issueLink", {
      type: { name: this.s.linkType }, inwardIssue: { key: this.native(from) }, outwardIssue: { key: this.native(to) },
    });
  }

  async transition(key: string, name: string) {
    const r = await this.req("GET", `/rest/api/2/issue/${this.native(key)}/transitions`);
    const t = (r.transitions ?? []).find((t: any) => t.name.toLowerCase() === name.toLowerCase());
    if (!t) return false;
    await this.req("POST", `/rest/api/2/issue/${this.native(key)}/transitions`, { transition: { id: t.id } });
    return true;
  }

  url(key: string) { return `${this.base}/browse/${this.native(key)}`; }

  /** Same instance and account: tickets can be linked natively. */
  sameInstance(o: JiraTracker) { return o.base === this.base && o.auth === this.auth && o.s.prefix === this.s.prefix && (!this.s.prefix || o.s.project === this.s.project); }

  async check() {
    try {
      const me = await this.req("GET", "/rest/api/2/myself");
      if (this.s.project) await this.req("GET", `/rest/api/2/project/${this.s.project}`);
      return { ok: true, detail: `connected as ${me.displayName ?? me.name ?? "?"}${this.s.project ? `, project ${this.s.project}` : ""}` };
    } catch (e) { return { ok: false, detail: checkFailure(e, this.base) }; }
  }
}
