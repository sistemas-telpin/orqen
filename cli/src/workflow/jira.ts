/** Minimal Jira client. Read access for the agent (via `orqen take`/`orqen search`); writes only from the process. */
import type { Config } from "./config.ts";

export const BOT_MARK = "[rec-agente]";

export interface Comment { id: string; author: string; authorName: string; body: string; created: string }
export interface Issue {
  key: string; title: string; description: string; type?: string; priority?: string;
  reportedBy?: string; jiraStatus?: string; labels: string[]; components: string[]; attachments: string[];
}

export interface JiraApi {
  searchKeys(jql: string): Promise<string[]>;
  issue(key: string): Promise<Issue>;
  comments(key: string): Promise<Comment[]>;
  comment(key: string, text: string): Promise<void>;
  setStateLabel(key: string, state: string): Promise<void>;
  transition(key: string, name: string): Promise<boolean>;
  /** Creates an issue in another project (e.g. the development SIS) and returns its key. */
  createIssue(i: { project: string; type: string; title: string; description: string; labels?: string[] }): Promise<string>;
  /** Links two issues (e.g. SIS "relates to" REC). */
  link(from: string, to: string, linkType: string): Promise<void>;
}

export class JiraClient implements JiraApi {
  private base: string;
  private auth: string;
  constructor(private cfg: Config) {
    this.base = cfg.jiraUrl.replace(/\/$/, "");
    this.auth = cfg.jiraDeployment === "cloud"
      ? "Basic " + Buffer.from(`${cfg.jiraUser}:${cfg.jiraToken}`).toString("base64")
      : `Bearer ${cfg.jiraToken}`;
  }

  private async req(method: string, path: string, body?: unknown, params?: Record<string, string | number>) {
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

  async searchKeys(jql: string) {
    const path = this.cfg.jiraDeployment === "cloud" ? "/rest/api/3/search/jql" : "/rest/api/2/search";
    const r = await this.req("GET", path, undefined, { jql, fields: "key", maxResults: 100 });
    return (r.issues ?? []).map((i: any) => i.key as string);
  }

  async issue(key: string): Promise<Issue> {
    const r = await this.req("GET", `/rest/api/2/issue/${key}`, undefined, {
      fields: "summary,description,issuetype,priority,reporter,labels,status,attachment,components",
    });
    const f = r.fields;
    return {
      key, title: f.summary, description: f.description ?? "", type: f.issuetype?.name,
      priority: f.priority?.name, reportedBy: f.reporter?.displayName, jiraStatus: f.status?.name,
      labels: f.labels ?? [], components: (f.components ?? []).map((c: any) => c.name),
      attachments: (f.attachment ?? []).map((a: any) => a.filename),
    };
  }

  async comments(key: string): Promise<Comment[]> {
    const r = await this.req("GET", `/rest/api/2/issue/${key}/comment`, undefined, { maxResults: 500, orderBy: "created" });
    return (r.comments ?? []).map((c: any) => ({
      id: String(c.id), author: c.author?.accountId ?? c.author?.name ?? "",
      authorName: c.author?.displayName ?? "", body: c.body ?? "", created: c.created ?? "",
    }));
  }

  async comment(key: string, text: string) {
    await this.req("POST", `/rest/api/2/issue/${key}/comment`, { body: `${BOT_MARK} ${text}` });
  }

  async setStateLabel(key: string, state: string) {
    const { labels } = await this.issue(key);
    const next = labels.filter((l) => !l.startsWith("rec-state-")).concat(`rec-state-${state.toLowerCase()}`);
    await this.req("PUT", `/rest/api/2/issue/${key}`, { fields: { labels: next } });
  }

  async createIssue(i: { project: string; type: string; title: string; description: string; labels?: string[] }) {
    const r = await this.req("POST", "/rest/api/2/issue", {
      fields: {
        project: { key: i.project }, issuetype: { name: i.type },
        summary: i.title.slice(0, 250), description: i.description, labels: i.labels ?? [],
      },
    });
    return r.key as string;
  }

  async link(from: string, to: string, linkType: string) {
    await this.req("POST", "/rest/api/2/issueLink", {
      type: { name: linkType }, inwardIssue: { key: from }, outwardIssue: { key: to },
    });
  }

  async transition(key: string, name: string) {
    const r = await this.req("GET", `/rest/api/2/issue/${key}/transitions`);
    const t = (r.transitions ?? []).find((t: any) => t.name.toLowerCase() === name.toLowerCase());
    if (!t) return false;
    await this.req("POST", `/rest/api/2/issue/${key}/transitions`, { transition: { id: t.id } });
    return true;
  }
}
