import type { Comment, Issue, JiraApi } from "../src/workflow/jira.ts";
import { BOT_MARK } from "../src/workflow/jira.ts";

let id = 0;

export class FakeJira implements JiraApi {
  coms: Record<string, Comment[]> = {};
  labels: Record<string, string> = {};
  constructor(public issues: Record<string, Partial<Issue>>) {
    for (const k of Object.keys(issues)) this.coms[k] = [];
  }
  async searchKeys() { return Object.keys(this.issues); }
  async issue(key: string): Promise<Issue> {
    return { key, title: "", description: "", labels: [], components: [], attachments: [], ...this.issues[key] };
  }
  async comments(key: string) { return [...this.coms[key]]; }
  async comment(key: string, text: string) { this.add(key, "bot", `${BOT_MARK} ${text}`); }
  human(key: string, author: string, text: string) { this.add(key, author, text); }
  async setStateLabel(key: string, s: string) { this.labels[key] = s; }
  async transition(key: string, n: string) { (this.transitions[key] ??= []).push(n); return true; }
  transitions: Record<string, string[]> = {};
  created: Array<{ key: string; project: string; type: string; title: string; description: string }> = [];
  links: Array<[string, string, string]> = [];
  async createIssue(i: { project: string; type: string; title: string; description: string }) {
    const key = `${i.project}-${this.created.length + 1}`;
    this.created.push({ key, ...i }); this.coms[key] = []; this.issues[key] = { title: i.title };
    return key;
  }
  async link(a: string, b: string, t: string) { this.links.push([a, b, t]); }
  last(key: string) { return this.coms[key].at(-1)!.body; }
  private add(key: string, author: string, body: string) {
    this.coms[key].push({ id: String(++id), author, authorName: author, body, created: "" });
  }
}
