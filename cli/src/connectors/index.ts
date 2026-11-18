/** Builds the connectors from the configuration. */
import { AsanaTracker } from "./asana.ts";
import type { ConnectorSettings, ConnectorsSettings } from "./config.ts";
import { GithubTracker } from "./github.ts";
import { JiraTracker } from "./jira.ts";
import type { Connectors, Tracker } from "./types.ts";

export * from "./types.ts";

export function trackerFor(s: ConnectorSettings): Tracker {
  if (s.kind === "jira") return new JiraTracker(s);
  if (s.kind === "github") return new GithubTracker(s);
  return new AsanaTracker(s);
}

export function buildConnectors(s: ConnectorsSettings): Connectors {
  const external = trackerFor(s.external);
  return { external, internal: s.internal ? trackerFor(s.internal) : undefined };
}

/** Both connectors point to the same tool and account: the tickets can be linked natively. */
export function canLinkNatively(a: Tracker, b: Tracker): boolean {
  if (a === b) return true;
  if (a instanceof JiraTracker && b instanceof JiraTracker) return a.sameInstance(b);
  return false;
}
