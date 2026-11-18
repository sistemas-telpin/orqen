/**
 * Asana. Keys: <PREFIX>-<task gid> (AS-1209… by default). Token: ASANA_TOKEN (personal access token) in orqen/.env.
 * Tickets handled: tasks of the project with the configured tag (orqen by default). `transiciones` move the task to a section
 * of the project; "completed" marks it done. Asana tags need ids, so the state is not mirrored as a tag.
 */
import { type AsanaSettings, idOf, keyOf } from "./config.ts";
import { BOT_MARK, type Comment, type NewTicket, type Ticket, type Tracker, checkFailure } from "./types.ts";

const API = "https://app.asana.com/api/1.0";

export class AsanaTracker implements Tracker {
  readonly kind = "asana" as const;
  private sections?: Array<{ gid: string; name: string }>;
  constructor(private s: AsanaSettings, private api = API) {}
  get label() { return `Asana project ${this.s.project || "(none)"}`; }

  private async req(method: string, path: string, body?: unknown) {
    if (!this.s.token) throw new Error("Asana connector without token: set ASANA_TOKEN in orqen/.env");
    const r = await fetch(this.api + path, {
      method,
      headers: { Authorization: `Bearer ${this.s.token}`, Accept: "application/json", "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify({ data: body }),
    });
    if (!r.ok) throw new Error(`Asana ${method} ${path}: ${r.status} ${await r.text()}`);
    const t = await r.text();
    return t ? JSON.parse(t).data : {};
  }

  private gid = (key: string) => idOf(this.s.prefix, key);
  private needProject() { if (!this.s.project) throw new Error("Asana connector without project (conectores.*.proyecto: project gid)"); return this.s.project; }

  async pending() {
    const tasks: any[] = await this.req("GET", `/projects/${this.needProject()}/tasks?completed_since=now&limit=100&opt_fields=tags.name`);
    const tag = this.s.tag.toLowerCase();
    return tasks.filter((t) => (t.tags ?? []).some((g: any) => g.name?.toLowerCase() === tag)).map((t) => keyOf(this.s.prefix, t.gid));
  }

  /** Text search inside the project (name and notes). */
  async search(query: string) {
    const tasks: any[] = await this.req("GET", `/projects/${this.needProject()}/tasks?limit=100&opt_fields=name,notes`);
    const q = query.toLowerCase();
    return tasks.filter((t) => `${t.name} ${t.notes ?? ""}`.toLowerCase().includes(q)).map((t) => keyOf(this.s.prefix, t.gid));
  }

  async ticket(key: string): Promise<Ticket> {
    const t = await this.req("GET", `/tasks/${this.gid(key)}?opt_fields=name,notes,created_by.name,completed,tags.name,permalink_url,memberships.section.name`);
    return {
      key, title: t.name, description: t.notes ?? "", reportedBy: t.created_by?.name,
      status: t.completed ? "completed" : t.memberships?.[0]?.section?.name,
      labels: (t.tags ?? []).map((g: any) => g.name), components: [], attachments: [], url: t.permalink_url,
    };
  }

  async comments(key: string): Promise<Comment[]> {
    const s: any[] = await this.req("GET", `/tasks/${this.gid(key)}/stories?opt_fields=type,text,created_by.gid,created_by.name,created_at`);
    return s.filter((x) => x.type === "comment").map((x) => ({
      id: x.gid, author: x.created_by?.gid ?? "", authorName: x.created_by?.name ?? "", body: x.text ?? "", created: x.created_at ?? "",
    }));
  }

  async comment(key: string, text: string) {
    await this.req("POST", `/tasks/${this.gid(key)}/stories`, { text: `${BOT_MARK} ${text}` });
  }

  async setStateLabel() { /* Asana tags are objects with ids: the state is shown with the section (transiciones) */ }

  async transition(key: string, name: string) {
    if (name.toLowerCase() === "completed") { await this.req("PUT", `/tasks/${this.gid(key)}`, { completed: true }); return true; }
    this.sections ??= await this.req("GET", `/projects/${this.needProject()}/sections`);
    const s = this.sections!.find((x) => x.name.toLowerCase() === name.toLowerCase());
    if (!s) return false;
    await this.req("POST", `/sections/${s.gid}/addTask`, { task: this.gid(key) });
    return true;
  }

  async create(t: NewTicket) {
    const r = await this.req("POST", "/tasks", { name: t.title.slice(0, 250), notes: t.description, projects: [this.needProject()] });
    return keyOf(this.s.prefix, r.gid);
  }

  url(key: string) { return `https://app.asana.com/0/${this.s.project || 0}/${this.gid(key)}`; }

  async check() {
    try {
      const me = await this.req("GET", "/users/me");
      const p = this.s.project ? await this.req("GET", `/projects/${this.s.project}?opt_fields=name`) : undefined;
      return { ok: true, detail: `connected as ${me.name}${p ? `, project "${p.name}"` : ""}` };
    } catch (e) { return { ok: false, detail: checkFailure(e, this.api) }; }
  }
}
