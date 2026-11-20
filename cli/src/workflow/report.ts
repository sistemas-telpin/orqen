/**
 * `orqen report`: how the work flowed, from what orqen already records (the event log of each worq and the analysis estimate).
 * Times are wall-clock time in each state (waiting included), not effort: they show where work waits, not how hard it was.
 */
import type { Event, WorkItem } from "./store.ts";
import { isFinal, type State } from "./states.ts";

const HOUR = 3_600_000;
/** States after development where the work can be sent back to it. */
const REVIEW_STATES: State[] = ["TESTING", "QA_REVIEW", "CODE_REVIEW", "DELIVERY", "ACCEPTANCE"];

export interface WorqReport {
  key: string; title?: string; state: State; lane?: string; internal?: boolean;
  started: string; finished?: string;
  /** Hours from the first event to CLOSED/CANCELLED (or until now, while open). */
  leadHours: number;
  /** Hours spent in each state. */
  hoursIn: Partial<Record<State, number>>;
  /** Times it went back to DEVELOPMENT from testing, QA, the senior or the client. */
  returns: number;
  estimatedHours?: number;
  /** Open ones: hours since they entered their current state. */
  inStateHours?: number;
}

export interface Report {
  from?: string; until: string;
  worqs: WorqReport[];
  totals: { worqs: number; closed: number; cancelled: number; open: number; blocked: number; returns: number; internal: number };
  /** Median and total hours per state, over the worqs that went through it, slowest first. */
  states: Array<{ state: State; worqs: number; medianHours: number; totalHours: number }>;
  /** Median lead time of the closed ones, by lane. */
  leadByLane: Array<{ lane: string; closed: number; medianHours: number }>;
  /** Development hours (wall clock in DEVELOPMENT) against the estimate, for the closed ones that had one. */
  estimate?: { worqs: number; estimatedHours: number; developmentHours: number };
}

const round = (n: number) => Math.round(n * 10) / 10;
export const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b), m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export function worqReport(item: WorkItem, events: Event[], now = new Date()): WorqReport | undefined {
  if (!events.length) return undefined;
  const hoursIn: Partial<Record<State, number>> = {};
  let returns = 0;
  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    if (e.to === "DEVELOPMENT" && REVIEW_STATES.includes(e.from)) returns++;
    if (isFinal(e.to)) continue;
    const end = i + 1 < events.length ? Date.parse(events[i + 1].ts) : now.getTime();
    hoursIn[e.to] = (hoursIn[e.to] ?? 0) + Math.max(0, end - Date.parse(e.ts)) / HOUR;
  }
  const entered = [...events].reverse().find((e) => e.from !== e.to) ?? events[0];
  const finalEvent = events.find((e) => isFinal(e.to));
  const started = events[0].ts;
  const endMs = finalEvent ? Date.parse(finalEvent.ts) : now.getTime();
  return {
    key: item.key, title: item.title, state: item.state, lane: item.route === "operational" ? "operational" : item.lane,
    internal: item.origin === "internal" || undefined, started, finished: finalEvent?.ts,
    leadHours: round((endMs - Date.parse(started)) / HOUR),
    hoursIn: Object.fromEntries(Object.entries(hoursIn).map(([k, v]) => [k, round(v!)])),
    returns, estimatedHours: typeof item.artifacts.estimated_hours === "number" ? item.artifacts.estimated_hours : undefined,
    ...(finalEvent ? {} : { inStateHours: round((now.getTime() - Date.parse(entered.ts)) / HOUR) }),
  };
}

/** The report of the worqs that had activity since `from` (all of them without it). */
export function buildReport(items: Array<{ item: WorkItem; events: Event[] }>, o: { from?: Date; now?: Date } = {}): Report {
  const now = o.now ?? new Date();
  const worqs = items
    .filter(({ events }) => !o.from || events.some((e) => Date.parse(e.ts) >= o.from!.getTime()))
    .map(({ item, events }) => worqReport(item, events, now))
    .filter((w): w is WorqReport => !!w)
    .sort((a, b) => a.started.localeCompare(b.started));

  const byState = new Map<State, number[]>();
  for (const w of worqs) for (const [s, h] of Object.entries(w.hoursIn)) {
    if (s === "NEW") continue;
    byState.set(s as State, [...(byState.get(s as State) ?? []), h!]);
  }
  const states = [...byState].map(([state, hs]) => ({ state, worqs: hs.length, medianHours: round(median(hs)), totalHours: round(hs.reduce((a, b) => a + b, 0)) }))
    .sort((a, b) => b.medianHours - a.medianHours);

  const closed = worqs.filter((w) => w.state === "CLOSED");
  const lanes = new Map<string, number[]>();
  for (const w of closed) lanes.set(w.lane ?? "—", [...(lanes.get(w.lane ?? "—") ?? []), w.leadHours]);
  const leadByLane = [...lanes].map(([lane, hs]) => ({ lane, closed: hs.length, medianHours: round(median(hs)) }));

  const est = closed.filter((w) => w.estimatedHours !== undefined && w.hoursIn.DEVELOPMENT !== undefined);
  return {
    from: o.from?.toISOString(), until: now.toISOString(), worqs,
    totals: {
      worqs: worqs.length, closed: closed.length, cancelled: worqs.filter((w) => w.state === "CANCELLED").length,
      open: worqs.filter((w) => !isFinal(w.state)).length, blocked: worqs.filter((w) => w.state === "BLOCKED").length,
      returns: worqs.reduce((a, w) => a + w.returns, 0), internal: worqs.filter((w) => w.internal).length,
    },
    states, leadByLane,
    ...(est.length ? { estimate: {
      worqs: est.length, estimatedHours: round(est.reduce((a, w) => a + w.estimatedHours!, 0)),
      developmentHours: round(est.reduce((a, w) => a + w.hoursIn.DEVELOPMENT!, 0)),
    } } : {}),
  };
}

const fmt = (h: number) => (h < 1 ? `${Math.round(h * 60)} min` : h < 48 ? `${round(h)} h` : `${round(h / 24)} d`);

export function printReport(r: Report) {
  const t = r.totals;
  console.log(`Worqs${r.from ? ` with activity since ${r.from.slice(0, 10)}` : ""}: ${t.worqs} · closed ${t.closed} · open ${t.open}` +
    `${t.blocked ? ` (blocked ${t.blocked})` : ""} · cancelled ${t.cancelled}${t.internal ? ` · of the team (new_worq) ${t.internal}` : ""}`);
  if (!t.worqs) return;
  if (r.leadByLane.length) {
    console.log("\nTime from start to close (median, closed ones):");
    for (const l of r.leadByLane) console.log(`  ${l.lane.padEnd(12)} ${fmt(l.medianHours).padStart(8)}  (${l.closed})`);
  }
  if (r.states.length) {
    console.log("\nWhere the work spends its time (median per worq, slowest first):");
    for (const s of r.states.slice(0, 8)) console.log(`  ${s.state.padEnd(18)} ${fmt(s.medianHours).padStart(8)}  (${s.worqs} worq${s.worqs === 1 ? "" : "s"})`);
  }
  const back = r.worqs.filter((w) => w.returns);
  console.log(`\nBack to development: ${t.returns} time(s)${back.length ? ` in ${back.length} worq(s): ${back.sort((a, b) => b.returns - a.returns).slice(0, 5).map((w) => `${w.key} ×${w.returns}`).join(", ")}` : ""}`);
  if (r.estimate) console.log(`Estimate vs time in development (${r.estimate.worqs} closed): ${fmt(r.estimate.estimatedHours)} estimated · ${fmt(r.estimate.developmentHours)} in DEVELOPMENT (wall clock, waiting included)`);
  const stuck = r.worqs.filter((w) => !isFinal(w.state)).map((w) => ({ w, h: w.inStateHours ?? 0 })).sort((a, b) => b.h - a.h).slice(0, 5);
  if (stuck.length) {
    console.log("\nOpen the longest in their current state:");
    for (const { w, h } of stuck) console.log(`  ${w.key.padEnd(10)} ${w.state.padEnd(16)} ${fmt(h).padStart(8)}  ${w.title ?? ""}`.trimEnd());
  }
}
