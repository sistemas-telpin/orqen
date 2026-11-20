/** `orqen report`: lead time, time per state, returns to development and estimate, from the event log. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildReport, median } from "../src/workflow/report.ts";
import type { State } from "../src/workflow/states.ts";
import { type Event, newWorkItem, type WorkItem } from "../src/workflow/store.ts";

const T0 = Date.parse("2026-11-01T09:00:00Z");
const at = (h: number) => new Date(T0 + h * 3_600_000).toISOString();
const ev = (h: number, from: State, to: State): Event => ({ ts: at(h), from, to, detail: "" });
const item = (key: string, state: State, extra: Partial<WorkItem> = {}): WorkItem => ({ ...newWorkItem(key), state, ...extra });

test("median", () => {
  assert.equal(median([]), 0);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
});

test("report: lead time by lane, where the work waits, returns and estimate", () => {
  const a = item("REQ-1", "CLOSED", { lane: "direct", artifacts: { estimated_hours: 3 } });
  const aEv = [ev(0, "NEW", "ANALYSIS"), ev(2, "ANALYSIS", "DEVELOPMENT"), ev(6, "DEVELOPMENT", "TESTING"), ev(7, "TESTING", "CODE_REVIEW"),
    ev(31, "CODE_REVIEW", "DEVELOPMENT"), ev(33, "DEVELOPMENT", "TESTING"), ev(34, "TESTING", "CODE_REVIEW"), ev(40, "CODE_REVIEW", "DELIVERY"), ev(42, "DELIVERY", "CLOSED")];
  const b = item("DEV-5", "CODE_REVIEW", { lane: "direct", origin: "internal" });
  const bEv = [ev(10, "ANALYSIS", "DEVELOPMENT"), ev(12, "DEVELOPMENT", "TESTING"), ev(13, "TESTING", "CODE_REVIEW")];
  const old = item("REQ-0", "CLOSED", { lane: "full" });
  const oldEv = [ev(-500, "NEW", "ANALYSIS"), ev(-400, "ANALYSIS", "CLOSED")];

  const now = new Date(at(50));
  const r = buildReport([{ item: a, events: aEv }, { item: b, events: bEv }, { item: old, events: oldEv }], { now, from: new Date(at(-1)) });
  assert.deepEqual(r.worqs.map((w) => w.key), ["REQ-1", "DEV-5"], "REQ-0 had no activity since --since");
  assert.deepEqual(r.totals, { worqs: 2, closed: 1, cancelled: 0, open: 1, blocked: 0, returns: 1, internal: 1 });

  const w1 = r.worqs[0];
  assert.equal(w1.leadHours, 42);
  assert.deepEqual(w1.hoursIn, { ANALYSIS: 2, DEVELOPMENT: 6, TESTING: 2, CODE_REVIEW: 30, DELIVERY: 2 });
  assert.equal(w1.returns, 1, "the senior sent it back once");
  assert.equal(w1.inStateHours, undefined);

  const w2 = r.worqs[1];
  assert.equal(w2.leadHours, 40, "open: until now");
  assert.equal(w2.inStateHours, 37, "in CODE_REVIEW since hour 13");

  assert.equal(r.states[0].state, "CODE_REVIEW", "where the work waits the most comes first");
  assert.deepEqual(r.leadByLane, [{ lane: "direct", closed: 1, medianHours: 42 }]);
  assert.deepEqual(r.estimate, { worqs: 1, estimatedHours: 3, developmentHours: 6 });
});

test("report without worqs", () => {
  const r = buildReport([]);
  assert.equal(r.totals.worqs, 0);
  assert.deepEqual([r.states, r.leadByLane, r.estimate], [[], [], undefined]);
});
