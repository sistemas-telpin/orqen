import type { ConnectorsSettings, JiraSettings } from "../src/connectors/config.ts";
import { BOT_MARK, type Comment, type Connectors, type NewTicket, type Ticket, type Tracker } from "../src/connectors/types.ts";

let id = 0;

/** In-memory connector. One instance can play both systems (requests and issues), like a single Jira. */
export class FakeTracker implements Tracker {
  readonly kind = "jira" as const;
  readonly label = "fake";
  coms: Record<string, Comment[]> = {};
  labels: Record<string, string> = {};
  transitions: Record<string, string[]> = {};
  created: Array<{ key: string } & NewTicket> = [];
  links: Array<[string, string]> = [];
  constructor(public issues: Record<string, Partial<Ticket>>, private prefix = "DEV") {
    for (const k of Object.keys(issues)) this.coms[k] = [];
  }
  async pending() { return Object.keys(this.issues).filter((k) => !this.created.some((c) => c.key === k)); }
  async search() { return Object.keys(this.issues); }
  async ticket(key: string): Promise<Ticket> {
    return { key, title: "", description: "", labels: [], components: [], attachments: [], ...this.issues[key] };
  }
  async comments(key: string) { return [...this.coms[key]]; }
  async comment(key: string, text: string) { this.add(key, "bot", `${BOT_MARK} ${text}`); }
  human(key: string, author: string, text: string) { this.add(key, author, text); }
  async setStateLabel(key: string, s: string) { this.labels[key] = s; }
  async transition(key: string, n: string) { (this.transitions[key] ??= []).push(n); return true; }
  async create(t: NewTicket) {
    const key = `${this.prefix}-${this.created.length + 1}`;
    this.created.push({ key, ...t }); this.coms[key] = []; this.issues[key] = { title: t.title };
    return key;
  }
  async link(a: string, b: string) { this.links.push([a, b]); }
  finished: Array<[string, string]> = [];
  async finish(key: string, reason: "completed" | "not_planned") { this.finished.push([key, reason]); }
  url(key: string) { return `https://tickets.example.test/${key}`; }
  async check() { return { ok: true, detail: "fake" }; }
  last(key: string) { return this.coms[key].at(-1)!.body; }
  private add(key: string, author: string, body: string) {
    this.coms[key].push({ id: String(++id), author, authorName: author, body, created: "" });
  }
}

/** The same fake as requests and issues system (or only requests with issues=false). */
export const both = (t: FakeTracker, issues = true): Connectors => ({ requests: t, issues: issues ? t : undefined });

const jira = (over: Partial<JiraSettings> = {}): JiraSettings => ({
  kind: "jira", url: "", user: "", token: "", deployment: "cloud", query: "x", project: "DEV",
  issueType: "Task", operationalType: "Task", linkType: "Relates", transitions: {}, ...over,
});
/** Connector settings for loadConfig in the tests. */
export const testConnectors = (issues = true): ConnectorsSettings => ({ requests: jira({ project: "" }), issues: issues ? jira() : undefined });
