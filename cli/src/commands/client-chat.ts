/**
 * The conversation with the client: the comments of the request's ticket in the requests system.
 *   orqen comments <KEY> [--json]   the ticket and its comments (client on one side, the team/orqen on the other)
 *   orqen comment <KEY> <file|->    answers the client: a comment signed with the person's name
 * The team's comments carry the orqen mark, so the gates never take them as the client's answer.
 */
import { type Comment, isBotComment, BOT_MARK, LEGACY_BOT_MARKS, type Tracker } from "../connectors/types.ts";
import { nombreHerramienta } from "../connectors/describe.ts";

export interface ChatMessage { id: string; from: "client" | "team"; author: string; text: string; created: string }
export interface ClientChat { key: string; title: string; tool: string; url?: string; status?: string; messages: ChatMessage[] }

/** "[orqen] **Mateo:** hola" → { author: "Mateo", text: "hola" }; orqen's own messages → author "orqen". */
export function parseTeamComment(body: string): { author: string; text: string } {
  let t = body;
  for (const m of [BOT_MARK, ...LEGACY_BOT_MARKS]) if (t.startsWith(m)) { t = t.slice(m.length); break; }
  t = t.replace(/^\s+/, "");
  const m = t.match(/^\*{1,2}([^*\n]{1,60}?):\*{1,2}\s*/);
  return m ? { author: m[1].trim(), text: t.slice(m[0].length) } : { author: "orqen", text: t };
}

export function toMessage(c: Comment): ChatMessage {
  if (isBotComment(c.body)) { const p = parseTeamComment(c.body); return { id: c.id, from: "team", author: p.author, text: p.text, created: c.created }; }
  return { id: c.id, from: "client", author: c.authorName || c.author, text: c.body, created: c.created };
}

export async function readClientChat(t: Tracker, key: string): Promise<ClientChat> {
  const [ticket, comments] = await Promise.all([t.ticket(key), t.comments(key)]);
  const first: ChatMessage[] = ticket.description.trim()
    ? [{ id: "description", from: "client", author: ticket.reportedBy ?? "", text: ticket.description.trim(), created: "" }] : [];
  return {
    key, title: ticket.title, tool: nombreHerramienta(t.kind), url: ticket.url, status: ticket.status,
    messages: [...first, ...comments.map(toMessage)],
  };
}

export async function replyToClient(t: Tracker, key: string, text: string, person?: string) {
  const body = text.trim();
  if (!body) throw new Error("Empty message: nothing was sent.");
  await t.comment(key, person ? `**${person}:** ${body}` : body);
}
