/**
 * Tickets of internal development: work the team starts itself, with no client request and no issue in an external tool.
 * Each one is a folder in the worqs directory (`orqen/worqs/INT-1/ticket.json`, next to the rest of the worq), so the brief and the
 * comments travel with the request branch and nothing is created in Jira, GitHub or Asana.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { LocalTracker } from "./local.ts";

/** Prefix of the keys of internal worqs (INT-1, INT-2…). */
export const INTERNAL_PREFIX = "INT";
export const isInternalKey = (key: string) => new RegExp(`^${INTERNAL_PREFIX}-[0-9]+$`, "i").test(key);

export class InternalTracker extends LocalTracker {
  constructor(private worqsDir: string) { super({ kind: "local", dir: worqsDir, prefix: INTERNAL_PREFIX, transitions: {} } as never); }
  override get label() { return `internal development (${this.worqsDir})`; }
  protected override file(key: string) { return join(this.worqsDir, key.toUpperCase(), "ticket.json"); }
  protected override keys(): string[] {
    if (!existsSync(this.worqsDir)) return [];
    return readdirSync(this.worqsDir).filter((d) => isInternalKey(d) && existsSync(join(this.worqsDir, d, "ticket.json")))
      .sort((a, b) => Number(a.split("-")[1]) - Number(b.split("-")[1]));
  }
  override url(key: string) { return pathToFileURL(this.file(key)).href; }
  override async check() { return { ok: true, detail: `${this.keys().length} internal worq(s)` }; }
}
