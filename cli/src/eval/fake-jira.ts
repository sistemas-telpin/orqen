/**
 * A small in-memory Jira (REST v2, server deployment) for `orqen eval`: the agent runs the real CLI against it, so a
 * case never touches the team's tickets. It keeps what the agent posted to read it after the run.
 */
import { createServer, type Server } from "node:http";
import { BOT_MARK } from "../connectors/types.ts";

export interface EvalTicket { title: string; description?: string; labels?: string[]; comments?: Array<{ author?: string; body: string }> }
export interface FakeComment { id: string; author: string; body: string; created: string; bot: boolean }

export class FakeJira {
  private server?: Server;
  private n = 0;
  readonly issues: Record<string, { title: string; description: string; labels: string[] }> = {};
  readonly comments: Record<string, FakeComment[]> = {};
  readonly transitions: Record<string, string[]> = {};
  readonly created: string[] = [];
  url = "";

  constructor(tickets: Record<string, EvalTicket>) {
    for (const [key, t] of Object.entries(tickets)) {
      this.issues[key] = { title: t.title, description: t.description ?? "", labels: t.labels ?? [] };
      this.comments[key] = (t.comments ?? []).map((c) => this.mk(c.author ?? "client", c.body));
    }
  }

  /** What orqen posted on a ticket (the bot's comments, without the mark). */
  posted(key: string): string[] {
    return (this.comments[key] ?? []).filter((c) => c.bot).map((c) => c.body.replace(BOT_MARK, "").trim());
  }

  async start(): Promise<string> {
    const names = ["To Do", "In Progress", "Done"];
    this.server = createServer(async (req, res) => {
      const send = (status: number, value?: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(value === undefined ? "" : JSON.stringify(value));
      };
      try {
        const url = new URL(req.url ?? "/", "http://localhost"), path = url.pathname;
        let raw = ""; for await (const part of req) raw += part;
        const body = raw ? JSON.parse(raw) : {};
        if (path === "/rest/api/2/myself") return send(200, { name: "orqen-eval", displayName: "ORQEN eval" });
        if (path.startsWith("/rest/api/2/project/")) return send(200, { key: path.split("/").pop() });
        if (req.method === "GET" && ["/rest/api/2/search", "/rest/api/3/search/jql"].includes(path)) {
          const project = url.searchParams.get("jql")?.match(/project\s*=\s*"?([A-Z][A-Z0-9]*)/i)?.[1]?.toUpperCase();
          const keys = Object.keys(this.issues).filter((k) => !project || k.startsWith(`${project}-`));
          return send(200, { issues: keys.map((key) => ({ key, fields: { summary: this.issues[key].title } })), total: keys.length });
        }
        if (path === "/rest/api/2/issue" && req.method === "POST") {
          const f = body.fields ?? {};
          const prefix = String(f.project?.key ?? "DEV");
          const key = `${prefix}-${100 + this.created.length + 1}`;
          this.created.push(key);
          this.issues[key] = { title: f.summary ?? "", description: f.description ?? "", labels: f.labels ?? [] };
          this.comments[key] = [];
          return send(201, { key });
        }
        if (path === "/rest/api/2/issueLink" && req.method === "POST") return send(201, {});
        const m = path.match(/^\/rest\/api\/2\/issue\/([A-Za-z][A-Za-z0-9]*-\d+)(?:\/(comment|transitions))?$/);
        if (!m || !this.issues[m[1]]) return send(404, { errorMessages: ["Issue does not exist"] });
        const [, key, sub] = m;
        if (sub === "comment") {
          if (req.method === "POST") {
            const text = String(body.body ?? "");
            this.comments[key].push(this.mk("orqen-eval", text, text.includes(BOT_MARK)));
            return send(201, {});
          }
          return send(200, { comments: this.comments[key].map((c) => ({ id: c.id, body: c.body, created: c.created, author: { accountId: c.author, name: c.author, displayName: c.author } })) });
        }
        if (sub === "transitions") {
          if (req.method === "POST") { (this.transitions[key] ??= []).push(names[Number(body.transition?.id)] ?? "?"); return send(204); }
          return send(200, { transitions: names.map((name, id) => ({ id: String(id), name })) });
        }
        if (req.method === "PUT") {
          const f = body.fields ?? {};
          if (f.labels) this.issues[key].labels = f.labels;
          return send(204);
        }
        const t = this.issues[key];
        return send(200, { key, fields: { summary: t.title, description: t.description, labels: t.labels, status: { name: "Open" }, components: [], attachment: [] } });
      } catch (e) {
        send(500, { errorMessages: [(e as Error).message] });
      }
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    const addr = this.server.address() as { port: number };
    this.url = `http://127.0.0.1:${addr.port}`;
    return this.url;
  }

  async stop() {
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = undefined;
  }

  private mk(author: string, body: string, bot = false): FakeComment {
    return { id: String(++this.n), author, body, created: new Date(Date.now() + this.n).toISOString(), bot };
  }
}
