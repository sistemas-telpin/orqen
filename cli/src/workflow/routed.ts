/** The requests system as the process sees it: real requests go to the connector, internal worqs (INT-n) to their local folder. */
import { InternalTracker, isInternalKey } from "../connectors/internal.ts";
import type { Comment, NewTicket, Ticket, Tracker } from "../connectors/types.ts";

export class RoutedTracker implements Tracker {
  constructor(private real: Tracker, readonly internal: InternalTracker) {}
  private to = (key: string): Tracker => (isInternalKey(key) ? this.internal : this.real);

  get kind() { return this.real.kind; }
  get label() { return this.real.label; }
  /** The internal worqs are always reviewed too (their PR is read, their merge detected). */
  async pending() { return [...await this.real.pending(), ...await this.internal.pending()]; }
  search(query: string) { return this.real.search(query); }
  ticket(key: string): Promise<Ticket> { return this.to(key).ticket(key); }
  comments(key: string): Promise<Comment[]> { return this.to(key).comments(key); }
  comment(key: string, text: string) { return this.to(key).comment(key, text); }
  setStateLabel(key: string, state: string) { return this.to(key).setStateLabel(key, state); }
  transition(key: string, name: string) { return this.to(key).transition(key, name); }
  create(t: NewTicket) { return this.real.create(t); }
  async finish(key: string, reason: "completed" | "not_planned") { await this.to(key).finish?.(key, reason); }
  link(from: string, to: string) { return this.real.link ? this.real.link(from, to) : Promise.resolve(); }
  url(key: string) { return this.to(key).url(key); }
  check() { return this.real.check(); }
}
