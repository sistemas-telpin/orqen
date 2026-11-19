/**
 * Local tickets: one JSON file per ticket in a folder (`conectores.requests: {tipo: local, carpeta: …}`).
 * Used by the practice project (`orqen practice`), where there is no Jira/GitHub: the "client" writes on the
 * ticket file and orqen reads and answers there exactly as it does on a real tool.
 *
 *   { key, title, description, reportedBy, status, labels, created, comments: [{id, author, authorName, body, created}], clientSeen }
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { LocalSettings } from "./config.ts";
import { BOT_MARK, type Comment, LEGACY_STATE_LABELS, type NewTicket, STATE_LABEL, type Ticket, type Tracker } from "./types.ts";

export interface LocalTicket {
  key: string; title: string; description: string; reportedBy?: string; status: string;
  labels: string[]; created: string; comments: Comment[];
  /** Last team comment the practice client already read (`orqen practice client`). */
  clientSeen?: string;
}

/** States of a local ticket that are no longer pending. */
const DONE = ["done", "closed", "cerrado", "resuelto"];

export class LocalTracker implements Tracker {
  readonly kind = "local" as const;
  constructor(private s: LocalSettings) {}
  get label() { return `tickets locales (${this.s.dir})`; }

  private file(key: string) { return join(this.s.dir, `${key.toUpperCase()}.json`); }

  read(key: string): LocalTicket {
    const f = this.file(key);
    if (!existsSync(f)) throw new Error(`${key}: no such local ticket in ${this.s.dir}`);
    const t = JSON.parse(readFileSync(f, "utf8")) as LocalTicket;
    return { ...t, labels: t.labels ?? [], comments: t.comments ?? [] };
  }

  /** Atomic write: the app and the CLI read the same files every few seconds. */
  write(t: LocalTicket) {
    mkdirSync(this.s.dir, { recursive: true });
    const f = this.file(t.key);
    const tmp = `${f}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(t, null, 2) + "\n");
    renameSync(tmp, f);
  }

  /** Adds a comment as someone (the client of the practice), without the orqen mark. */
  addComment(key: string, author: string, authorName: string, body: string): Comment {
    const t = this.read(key);
    const c: Comment = { id: `${Date.now()}-${t.comments.length + 1}`, author, authorName, body, created: new Date().toISOString() };
    t.comments.push(c);
    this.write(t);
    return c;
  }

  private keys(): string[] {
    if (!existsSync(this.s.dir)) return [];
    return readdirSync(this.s.dir).filter((f) => /^[A-Za-z][\w]*-\d+\.json$/.test(f)).map((f) => f.replace(/\.json$/, ""))
      .sort((a, b) => Number(a.split("-")[1]) - Number(b.split("-")[1]));
  }

  async pending() {
    return this.keys().filter((k) => {
      try { return !DONE.includes(this.read(k).status.toLowerCase()); } catch { return false; }
    });
  }

  async search(query: string) {
    const q = query.toLowerCase().trim();
    return this.keys().filter((k) => {
      const t = this.read(k);
      return !q || `${t.key} ${t.title} ${t.description}`.toLowerCase().includes(q);
    });
  }

  async ticket(key: string): Promise<Ticket> {
    const t = this.read(key);
    return { key: t.key, title: t.title, description: t.description, reportedBy: t.reportedBy, status: t.status, labels: t.labels, components: [], attachments: [], url: this.url(t.key) };
  }

  async comments(key: string) { return this.read(key).comments; }

  async comment(key: string, text: string) {
    const t = this.read(key);
    t.comments.push({ id: `${Date.now()}-${t.comments.length + 1}`, author: "orqen", authorName: "orqen", body: `${BOT_MARK} ${text}`, created: new Date().toISOString() });
    this.write(t);
  }

  async setStateLabel(key: string, state: string) {
    const t = this.read(key);
    t.labels = t.labels.filter((l) => ![STATE_LABEL, ...LEGACY_STATE_LABELS].some((p) => l.startsWith(p))).concat(`${STATE_LABEL}${state.toLowerCase()}`);
    // a closed request leaves the pending list, as when Jira/GitHub close the ticket
    if (state === "CLOSED") t.status = "Cerrado";
    this.write(t);
  }

  async transition(key: string, name: string) {
    const t = this.read(key);
    t.status = name;
    this.write(t);
    return true;
  }

  async create(n: NewTicket) {
    const next = Math.max(0, ...this.keys().map((k) => Number(k.split("-")[1]))) + 1;
    const key = `${this.s.prefix}-${next}`;
    this.write({ key, title: n.title, description: n.description, status: "Abierto", labels: n.labels ?? [], created: new Date().toISOString(), comments: [] });
    return key;
  }

  url(key: string) { return pathToFileURL(this.file(key)).href; }

  async check() {
    if (!existsSync(this.s.dir)) return { ok: false, detail: `the folder ${this.s.dir} does not exist` };
    return { ok: true, detail: `${this.keys().length} ticket(s) in ${this.s.dir}` };
  }
}
