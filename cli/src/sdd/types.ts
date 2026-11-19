/**
 * Spec-driven development, independent of the tool. orqen uses OpenSpec today, but everything that SHOWS a spec
 * (the desktop app's Spec panel, `orqen spec`) reads this neutral model. Moving to another SDD tool means writing one
 * more provider (a file in this folder) — nothing in the app or the commands changes.
 */

/** One task of a plan, as a checkbox. */
export interface SpecTask { text: string; done: boolean }
/** Tasks under one heading of the plan ("1. Backend"). */
export interface TaskGroup { title: string; items: SpecTask[] }

/** A tab of the spec: markdown (proposal, design, verification…), a task list, or the specs of each capability. */
export interface SpecSection {
  id: string;
  title: string;
  kind: "markdown" | "tasks" | "specs";
  markdown?: string;
  groups?: TaskGroup[];
  specs?: Array<{ name: string; markdown: string }>;
  /** File it came from (relative to the project). */
  file?: string;
}

/** A change / feature of the SDD tool, ready to show. */
export interface SpecView {
  /** Which tool it comes from (openspec, spec-kit, orqen = the analysis of a request without a spec). */
  provider: string;
  providerLabel: string;
  id: string;
  title: string;
  status: "active" | "archived" | "none";
  /** YYYY-MM-DD */
  since?: string;
  updated?: string;
  progress?: { done: number; total: number };
  sections: SpecSection[];
  /** Where it was read: a folder or `branch <name>`. */
  source: string;
  /** Request it belongs to, when known. */
  key?: string;
  note?: string;
}

/** A row of the list of changes. */
export interface SpecSummary { id: string; title: string; status: "active" | "archived"; progress?: { done: number; total: number }; updated?: string }

/** Where the files are read from: the working tree (or a request's worktree), or a branch through git. */
export interface Source {
  label: string;
  /** Names in a folder (dirs end with "/"), [] when it does not exist. Paths are relative and use "/". */
  list(dir: string): string[];
  read(path: string): string | undefined;
  /** Last change of a file or folder (YYYY-MM-DD), when known. */
  modified(path: string): string | undefined;
  /** When a folder was first added (YYYY-MM-DD), when known. */
  created(path: string): string | undefined;
}

/** An SDD tool. */
export interface SddProvider {
  id: string;
  label: string;
  /** Whether the project uses it (its folders are there). */
  detect(src: Source): boolean;
  list(src: Source): SpecSummary[];
  read(src: Source, id: string): SpecView | undefined;
}
