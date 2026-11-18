/**
 * `orqen usage [--json]`: AI agents installed on this machine and how much of their quota is used (like Orca's status bar).
 *
 *  - Claude Code: the subscription's 5-hour and weekly windows, from the same endpoint Claude Code's /usage uses,
 *    with the session saved in ~/.claude/.credentials.json (macOS keeps it in the Keychain: then only the version is shown).
 *  - Codex: the last rate limits Codex recorded in ~/.codex/sessions/.
 *  - Others (Gemini, Copilot, Cursor): only whether they are installed.
 * Nothing is sent anywhere except Claude's own API; failures just leave the quota empty.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Limit { label: string; used: number; resetsAt?: string; /** minutes until it resets */ resetsInMin?: number }
export interface AgentUsage { id: string; name: string; installed: boolean; version?: string; plan?: string; limits: Limit[]; note?: string }

const AGENTS = [
  { id: "claude", name: "Claude Code", bin: "claude" },
  { id: "codex", name: "Codex", bin: "codex" },
  { id: "gemini", name: "Gemini CLI", bin: "gemini" },
  { id: "copilot", name: "Copilot CLI", bin: "copilot" },
  { id: "cursor", name: "Cursor Agent", bin: "cursor-agent" },
];

function version(bin: string): string | undefined {
  const r = spawnSync(bin, ["--version"], { encoding: "utf8", timeout: 4000, shell: process.platform === "win32", windowsHide: true });
  if (r.status !== 0) return undefined;
  return (r.stdout || r.stderr).trim().split(/\s+/).find((w) => /\d+\.\d+/.test(w)) ?? (r.stdout || "").trim().slice(0, 20);
}

async function claudeLimits(home: string): Promise<{ limits: Limit[]; plan?: string; note?: string }> {
  const file = join(home, ".claude", ".credentials.json");
  if (!existsSync(file)) return { limits: [], note: "no saved session (log in with `claude`)" };
  const oauth = JSON.parse(readFileSync(file, "utf8")).claudeAiOauth;
  if (!oauth?.accessToken) return { limits: [], note: "API key mode: no subscription quota" };
  const r = await fetch("https://api.anthropic.com/api/oauth/usage", {
    headers: { Authorization: `Bearer ${oauth.accessToken}`, "anthropic-beta": "oauth-2025-04-20", Accept: "application/json" },
    signal: AbortSignal.timeout(6000),
  });
  if (!r.ok) return { limits: [], plan: oauth.subscriptionType, note: `quota unavailable (${r.status})` };
  const j = await r.json() as Record<string, { utilization?: number; resets_at?: string } | null>;
  const limits: Limit[] = [];
  for (const [k, label] of [["five_hour", "5h"], ["seven_day", "7d"], ["seven_day_opus", "7d opus"]] as const) {
    const w = j[k];
    if (w && typeof w.utilization === "number") limits.push({ label, used: Math.round(w.utilization), resetsAt: w.resets_at ?? undefined });
  }
  return { limits, plan: oauth.subscriptionType };
}

function latestFile(dir: string, depth = 4): string | undefined {
  let best: { f: string; t: number } | undefined;
  const walk = (d: string, n: number) => {
    let entries: string[] = [];
    try { entries = readdirSync(d); } catch { return; }
    for (const e of entries) {
      const p = join(d, e);
      let st; try { st = statSync(p); } catch { continue; }
      if (st.isDirectory() && n > 0) walk(p, n - 1);
      else if (e.endsWith(".jsonl") && (!best || st.mtimeMs > best.t)) best = { f: p, t: st.mtimeMs };
    }
  };
  walk(dir, depth);
  return best?.f;
}

function codexLimits(home: string): { limits: Limit[]; note?: string } {
  const f = latestFile(join(home, ".codex", "sessions"));
  if (!f) return { limits: [], note: "no sessions yet" };
  const lines = readFileSync(f, "utf8").trim().split("\n").reverse();
  for (const l of lines) {
    if (!l.includes("rate_limits")) continue;
    try {
      const j = JSON.parse(l);
      const rl = j.payload?.rate_limits ?? j.rate_limits ?? j.msg?.rate_limits;
      if (!rl) continue;
      const out: Limit[] = [];
      for (const w of [rl.primary, rl.secondary]) {
        if (!w || typeof w.used_percent !== "number") continue;
        const mins = w.window_minutes ?? 0;
        const resets = w.resets_at ? new Date(w.resets_at * (w.resets_at < 1e12 ? 1000 : 1)).toISOString()
          : w.resets_in_seconds ? new Date(statSync(f).mtimeMs + w.resets_in_seconds * 1000).toISOString() : undefined;
        out.push({ label: mins >= 1440 ? `${Math.round(mins / 1440)}d` : mins ? `${Math.round(mins / 60)}h` : "", used: Math.round(w.used_percent), resetsAt: resets });
      }
      return { limits: out };
    } catch { /* keep looking */ }
  }
  return { limits: [], note: "no quota recorded yet" };
}

const withEta = (u: AgentUsage): AgentUsage => ({
  ...u, limits: u.limits.map((l) => ({ ...l, resetsInMin: l.resetsAt ? Math.max(0, Math.round((Date.parse(l.resetsAt) - Date.now()) / 60000)) : undefined })),
});

export async function usage(home = homedir()): Promise<AgentUsage[]> {
  return (await Promise.all(AGENTS.map(async (a) => {
    const v = version(a.bin);
    const base: AgentUsage = { id: a.id, name: a.name, installed: !!v, version: v, limits: [] };
    if (!v) return base;
    try {
      if (a.id === "claude") return { ...base, ...(await claudeLimits(home)) };
      if (a.id === "codex") return { ...base, ...codexLimits(home) };
    } catch (e) { return { ...base, note: (e as Error).message.slice(0, 120) }; }
    return base;
  }))).map(withEta);
}

export async function usageCommand(args: string[]) {
  const list = await usage();
  if (args.includes("--json")) return console.log(JSON.stringify({ agents: list }, null, 2));
  for (const a of list.filter((x) => x.installed)) {
    const lim = a.limits.map((l) => `${l.label} ${l.used}%`).join(" · ");
    console.log(`${a.name.padEnd(13)} ${(a.version ?? "").padEnd(10)} ${lim || a.note || ""}`);
  }
  if (!list.some((x) => x.installed)) console.log("No AI agents found (claude, codex, gemini, copilot, cursor-agent).");
}
