/** State of each REC in JSON files (cli/.state/, ignored by git → survives branch checkouts). */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Lane, Route, State } from "./states.ts";

export interface Rec {
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
  sis?: string;                  // key of the SIS created when the analysis closed
  artifacts: Record<string, any>;
  feedback: Array<{ from: string; text?: string; rejection?: string }>;
  lock?: { agent: string; since: string };
  stateBeforeBlock?: State;
}

export const newRec = (key: string): Rec => ({
  key, state: "NEW", round: 1, testingAttempts: 0, questionRounds: 0, lastSeenComment: "",
  branch: "", change: "", artifacts: {}, feedback: [],
});

export interface Event { ts: string; from: State; to: State; detail: string; agent?: string }

export class Store {
  constructor(private dir: string) { mkdirSync(dir, { recursive: true }); }
  private path = (key: string) => join(this.dir, `${key}.json`);

  get(key: string): Rec | undefined {
    return existsSync(this.path(key)) ? JSON.parse(readFileSync(this.path(key), "utf8")) : undefined;
  }
  save(rec: Rec) {
    const tmp = this.path(rec.key) + ".tmp";
    writeFileSync(tmp, JSON.stringify(rec, null, 2));
    renameSync(tmp, this.path(rec.key)); // atomic write
  }
  log(key: string, ev: Event) { appendFileSync(join(this.dir, `${key}.log.jsonl`), JSON.stringify(ev) + "\n"); }
  events(key: string): Event[] {
    const f = join(this.dir, `${key}.log.jsonl`);
    return existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  }
  all(): Rec[] {
    return readdirSync(this.dir).filter((f) => f.endsWith(".json")).sort().map((f) => this.get(f.slice(0, -5))!);
  }
}
