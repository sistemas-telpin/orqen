/** State of each request in JSON files (orqen/state/, ignored by git → survives branch checkouts). */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Lane, Route, State } from "./states.ts";

export interface WorkItem {
  /** Key of the request (the client's ticket, in the requests system). */
  key: string;
  state: State;
  round: number;                 // 1 + number of times the client rejected the acceptance
  testingAttempts: number;
  questionRounds: number;
  lastSeenComment: string;
  branch: string;
  change: string;                // id of the OpenSpec change
  route?: Route;                 // set by the analysis; the operational → development escalation changes it
  lane?: Lane;                   // direct | light | full (development route only); set by the analyst in the analysis
  supporter?: string;            // who handled the request in SUPPORT
  analyst?: string;              // who drove the analysis
  issue?: string;                // key of the issue created when the analysis closed (issues system)
  artifacts: Record<string, any>;
  feedback: Array<{ from: string; text?: string; rejection?: string }>;
  lock?: { agent: string; since: string };
  stateBeforeBlock?: State;
}

export const newWorkItem = (key: string): WorkItem => ({
  key, state: "NEW", round: 1, testingAttempts: 0, questionRounds: 0, lastSeenComment: "",
  branch: "", change: "", artifacts: {}, feedback: [],
});

export interface Event { ts: string; from: State; to: State; detail: string; agent?: string }

export class Store {
  constructor(private dir: string) { mkdirSync(dir, { recursive: true }); }
  private path = (key: string) => join(this.dir, `${key}.json`);

  get(key: string): WorkItem | undefined {
    return existsSync(this.path(key)) ? migrate(JSON.parse(readFileSync(this.path(key), "utf8"))) : undefined;
  }
  save(rec: WorkItem) {
    const tmp = this.path(rec.key) + ".tmp";
    writeFileSync(tmp, JSON.stringify(rec, null, 2));
    renameSync(tmp, this.path(rec.key)); // atomic write
  }
  log(key: string, ev: Event) { appendFileSync(join(this.dir, `${key}.log.jsonl`), JSON.stringify(ev) + "\n"); }
  events(key: string): Event[] {
    const f = join(this.dir, `${key}.log.jsonl`);
    return existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  }
  all(): WorkItem[] {
    return readdirSync(this.dir).filter((f) => f.endsWith(".json")).sort().map((f) => this.get(f.slice(0, -5))!);
  }
}

/** Items saved by earlier versions used `sis` and then `internal` for the issue. */
function migrate(item: WorkItem & { sis?: string; internal?: string }): WorkItem {
  for (const old of ["sis", "internal"] as const) if (item[old] !== undefined) { item.issue ??= item[old]; delete item[old]; }
  const a = item.artifacts ?? {};
  for (const old of ["sis_linked", "internal_linked"]) if (a[old] !== undefined) { a.issue_linked ??= a[old]; delete a[old]; }
  for (const old of ["previous_sis", "previous_internal"]) if (a[old] !== undefined) { a.previous_issues ??= a[old]; delete a[old]; }
  return item;
}
