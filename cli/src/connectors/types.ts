/**
 * Connectors: where the tickets live. orqen works with two systems:
 *
 *  - requests: where the client's requests arrive (what the client sees). orqen reads them, answers on them and asks for /approve or /reject there.
 *  - issues: optional. The team's own issues, one created per request when the analysis closes, where development is tracked.
 *
 * Each system can be any tool (e.g. the client's Jira and the team's GitHub Projects). The process only
 * talks to this interface; jira.ts, github.ts and asana.ts translate it to each API.
 */

/** Text that marks comments written by orqen (they are not read back as human answers). */
export const BOT_MARK = "[orqen]";
/** Marks orqen used before (still recognized so old comments are not taken as human answers). */
export const LEGACY_BOT_MARKS = ["[rec-agente]"];
export const isBotComment = (body: string) => [BOT_MARK, ...LEGACY_BOT_MARKS].some((m) => body.startsWith(m));

/** Prefix of the label that mirrors the orqen state on the ticket (e.g. orqen-state-development). */
export const STATE_LABEL = "orqen-state-";
export const LEGACY_STATE_LABELS = ["rec-state-"];
/** Label of the issue of a worq started by the team (`orqen new_worq`): any machine finds it and knows it has no client request. */
export const WORQ_LABEL = "orqen-worq";

export type ConnectorKind = "jira" | "github" | "asana" | "local";
export type Role = "requests" | "issues";

export interface Comment { id: string; author: string; authorName: string; body: string; created: string }

export interface Ticket {
  key: string; title: string; description: string; type?: string; priority?: string;
  reportedBy?: string; status?: string; labels: string[]; components: string[]; attachments: string[];
  /** Link to open the ticket in its tool. */
  url?: string;
}

export interface NewTicket {
  title: string; description: string; labels?: string[];
  /** development (code) or operational (SQL, restarts…): some connectors use a different issue type for each. */
  route: "development" | "operational";
}

export interface Tracker {
  readonly kind: ConnectorKind;
  /** Short name for messages, e.g. "Jira (acme.atlassian.net)". */
  readonly label: string;
  /** Keys of the tickets orqen must handle (the connector's configured filter). */
  pending(): Promise<string[]>;
  /** Free search in the tool's own syntax (JQL, GitHub search, Asana text). */
  search(query: string): Promise<string[]>;
  /** Open tickets that carry this label. Optional: without it, a machine with no record cannot find the team's own worqs. */
  labelled?(label: string): Promise<string[]>;
  ticket(key: string): Promise<Ticket>;
  comments(key: string): Promise<Comment[]>;
  comment(key: string, text: string): Promise<void>;
  /** Mirrors the orqen state on the ticket (label, tag or field). */
  setStateLabel(key: string, state: string): Promise<void>;
  /** Moves the ticket to a column/status/section by name. false if the tool has no such destination. */
  transition(key: string, name: string): Promise<boolean>;
  /** Creates a ticket where this connector creates them (issues system) and returns its key. */
  create(t: NewTicket): Promise<string>;
  /**
   * The request is over (delivered or cancelled): closes the ticket where moving it to a column is not enough to close it
   * (a GitHub issue in a project stays open). Optional: Jira and Asana close through their own transitions.
   */
  finish?(key: string, reason: "completed" | "not_planned"): Promise<void>;
  /** Native link between two tickets of this same connector, when the tool has one. */
  link?(from: string, to: string): Promise<void>;
  /** URL of a ticket (used to reference it from another tool). */
  url(key: string): string;
  /** Checks the credentials and the configured place. Used by `orqen connectors`. */
  check(): Promise<{ ok: boolean; detail: string }>;
}

export interface Connectors {
  requests: Tracker;
  /** Absent: the team works only on the request. */
  issues?: Tracker;
}

/** Readable detail of a failed check: Node's fetch only says "fetch failed" and leaves the reason in `cause`. */
export function checkFailure(e: unknown, host: string): string {
  const err = e as Error & { cause?: { code?: string; message?: string } };
  if (err?.message === "fetch failed" || err?.name === "TypeError" && /fetch/i.test(err.message)) {
    const why = err.cause?.code === "ENOTFOUND" ? "the host does not exist or there is no DNS" : err.cause?.code === "ECONNREFUSED" ? "connection refused"
      : err.cause?.code === "ETIMEDOUT" || err.cause?.code === "UND_ERR_CONNECT_TIMEOUT" ? "timed out" : err.cause?.code || err.cause?.message || "network error";
    return `could not reach ${host.replace(/^https?:\/\//, "") || "the server"} (${why})`;
  }
  // "<Tool> GET /path: 401 {json}" → "Jira answered 401 (wrong user or token): <message>"
  const m = (err?.message ?? "").match(/^(Jira|GitHub|Asana) [A-Z]+ \S+: (\d{3}) ([\s\S]*)$/);
  if (m) {
    let msg = m[3].trim();
    try {
      const j = JSON.parse(msg);
      msg = j.message ?? j.errorMessages?.[0] ?? j.errors?.[0]?.message ?? Object.values(j.errors ?? {})[0] ?? "";
    } catch { msg = msg.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(); }
    const hint: Record<string, string> = { "401": "wrong user or token", "403": "the account has no permission", "404": "not found: check the project or repository", "410": "gone" };
    return `${m[1]} answered ${m[2]}${hint[m[2]] ? ` (${hint[m[2]]})` : ""}${msg ? `: ${String(msg).slice(0, 160)}` : ""}`;
  }
  return (err?.message ?? String(e)).slice(0, 300);
}
