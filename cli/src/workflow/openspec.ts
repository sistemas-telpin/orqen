/**
 * OpenSpec integration (>= 2.0). Each request (and each round) is an OpenSpec "change":
 *   SPECIFICATION → openspec new change + the agent writes proposal/specs/design/tasks
 *   DEVELOPMENT   → the agent follows `openspec instructions apply` and ticks tasks.md
 *   TESTING       → the Scenarios of the spec deltas are the coverage checklist
 *   DELIVERY      → openspec archive (the deltas are merged into openspec/specs)
 * This module only wraps the CLI with --json and parses what the CLI does not expose (scenarios, hours).
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export interface Task { description: string; done: boolean; hours?: number }
export interface Scenario { capability: string; requirement: string; scenario: string }

export interface OpenSpecApi {
  newChange(id: string, description: string): string;           // returns the change dir
  exists(id: string): boolean;
  dir(id: string): string;
  validate(id: string): { ok: boolean; problems: string[] };
  planningComplete(id: string): boolean;
  tasks(id: string): Task[];
  scenarios(id: string): Scenario[];
  archive(id: string): { archivedAs: string; totals: Record<string, number> };
}

export class OpenSpecCli implements OpenSpecApi {
  constructor(private cmd: string, private repoPath: string) {}

  private run(args: string[]): any {
    const win = process.platform === "win32";  // with a shell (cmd) arguments containing spaces must be quoted
    const a = win ? args.map((x) => (/[\s"]/.test(x) ? `"${x.replace(/"/g, '\\"')}"` : x)) : args;
    const p = spawnSync(this.cmd, a, { cwd: this.repoPath, encoding: "utf8", shell: win });
    if (p.error) throw new Error(`Could not run "${this.cmd}": ${p.error.message}. Is OpenSpec installed? (npm i -g @fission-ai/openspec)`);
    try {
      return { code: p.status, json: JSON.parse(p.stdout) };
    } catch {
      return { code: p.status, json: null, text: (p.stdout + p.stderr).trim() };
    }
  }

  private ok(args: string[]) {
    const r = this.run(args);
    if (r.code !== 0 || !r.json) throw new Error(`openspec ${args.join(" ")} failed: ${r.text ?? JSON.stringify(r.json)}`);
    return r.json;
  }

  dir(id: string) { return join(this.repoPath, "openspec", "changes", id); }
  exists(id: string) { return existsSync(this.dir(id)); }

  newChange(id: string, description: string) {
    if (this.exists(id)) return this.dir(id);
    return this.ok(["new", "change", id, "--description", description, "--json"]).change.path as string;
  }

  validate(id: string) {
    const r = this.run(["validate", id, "--type", "change", "--strict", "--json", "--no-interactive"]);
    const item = r.json?.items?.[0];
    if (!item) return { ok: false, problems: [r.text ?? "openspec validate returned no result"] };
    const problems = (item.issues ?? []).map((i: any) => `${i.level ?? ""} ${i.path ?? ""}: ${i.message ?? JSON.stringify(i)}`.trim());
    return { ok: !!item.valid, problems };
  }

  planningComplete(id: string) {
    return !!this.ok(["status", "--change", id, "--json"]).isPlanningComplete;
  }

  tasks(id: string): Task[] {
    const j = this.ok(["instructions", "apply", "--change", id, "--json"]);
    return (j.tasks ?? []).map((t: any) => ({ description: t.description, done: !!t.done, hours: hoursOf(t.description) }));
  }

  scenarios(id: string) { return changeScenarios(this.dir(id)); }

  archive(id: string) {
    const j = this.ok(["archive", id, "--yes", "--json"]);
    return { archivedAs: j.archive.archivedAs, totals: j.archive.totals };
  }
}

/** "Implement endpoint (4h)" → 4 ; also "(1.5 h)" */
export function hoursOf(desc: string): number | undefined {
  const m = desc.match(/\((\d+(?:[.,]\d+)?)\s*h\)\s*$/i);
  return m ? Number(m[1].replace(",", ".")) : undefined;
}

/** Walks specs/**\/spec.md of the change and lists each Scenario with its Requirement. */
export function changeScenarios(changeDir: string): Scenario[] {
  const base = join(changeDir, "specs");
  if (!existsSync(base)) return [];
  const out: Scenario[] = [];
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (f === "spec.md") {
        const capability = d.slice(base.length + 1).replaceAll("\\", "/");
        let section = "", requirement = "";
        for (const line of readFileSync(p, "utf8").split("\n")) {
          const h2 = line.match(/^##\s+(.+)/), req = line.match(/^###\s+Requirement:\s*(.+)/), sc = line.match(/^####\s+Scenario:\s*(.+)/);
          if (h2 && !line.startsWith("###")) section = h2[1].trim().toUpperCase();
          else if (req) requirement = req[1].trim();
          else if (sc && !section.startsWith("REMOVED")) out.push({ capability, requirement, scenario: sc[1].trim() });
        }
      }
    }
  };
  walk(base);
  return out;
}
