/**
 * The requests system as the process sees it. Real requests go to the requests connector; a worq started by the team (`orqen new_worq`)
 * has no client request: its ticket is the issue that orqen created in the connector in use (issues, or requests when there is none).
 */
import type { Comment, NewTicket, Ticket, Tracker } from "../connectors/types.ts";

export class RoutedTracker implements Tracker {
  /** `own(key)`: the worq is the team's own; `ownKeys()`: the keys of the open ones (so they are reviewed too). */
  constructor(private real: Tracker, private own: Tracker, private isOwn: (key: string) => boolean, private ownKeys: () => string[]) {}
  private to = (key: string): Tracker => (this.isOwn(key) ? this.own : this.real);

  get kind() { return this.real.kind; }
  get label() { return this.real.label; }
  /** The team's own worqs are always reviewed too (their PR is read, their merge detected). */
  async pending() { return [...new Set([...await this.real.pending(), ...this.ownKeys()])]; }
  search(query: string) { return this.real.search(query); }
  ticket(key: string): Promise<Ticket> { return this.to(key).ticket(key); }
  comments(key: string): Promise<Comment[]> { return this.to(key).comments(key); }
  comment(key: string, text: string) { return this.to(key).comment(key, text); }
  setStateLabel(key: string, state: string) { return this.to(key).setStateLabel(key, state); }
  transition(key: string, name: string) { return this.to(key).transition(key, name); }
  create(t: NewTicket) { return this.own.create(t); }
  async finish(key: string, reason: "completed" | "not_planned") { await this.to(key).finish?.(key, reason); }
  link(from: string, to: string) { return this.real.link ? this.real.link(from, to) : Promise.resolve(); }
  url(key: string) { return this.to(key).url(key); }
  check() { return this.real.check(); }
}
