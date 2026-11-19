/**
 * orqen practice: the project of the interactive tutorial (orqen-gui › Tutorial interactivo).
 *   orqen practice create [--dir D] [--no-openspec] [--json]   creates (or finds) <app dir>/practica/facturas-demo
 *   orqen practice request <1|2> [--json]                      the client sends request TUT-n
 *   orqen practice client <KEY> [--json]                       the client (an LLM) answers what the team wrote
 *
 * Everything is local: the tickets are JSON files (connector `local`), the remote is a bare repo and the PR is a file.
 * <app dir> = ORQEN_PRACTICE_DIR, else ORQEN_APP_DIR, else ~/.orqen.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { leerConfig, escribirConfig, existeConfig } from "../lib/config.ts";
import { escribirEnv, RUTA_ENV } from "../lib/env.ts";
import { ejecutar, partirComando } from "../lib/proc.ts";
import { loadConfig } from "../workflow/config.ts";
import { LocalTracker } from "../connectors/local.ts";
import { isBotComment, STATE_LABEL } from "../connectors/types.ts";
import { parseTeamComment } from "../commands/client-chat.ts";
import { CLIENT, clientPrompt, PR_SCRIPT, projectFiles, request, requestOfKey } from "./scenario.ts";

export const PREFIX = "TUT";

export function practiceRoot(env = process.env): string {
  return join(env.ORQEN_PRACTICE_DIR || env.ORQEN_APP_DIR || join(homedir(), ".orqen"), "practica");
}

const slash = (p: string) => p.replace(/\\/g, "/");

function git(cwd: string, ...args: string[]) {
  const r = ejecutar("git", args, { cwd, timeoutMs: 120_000 });
  if (r.codigo !== 0) throw new Error(`git ${args.join(" ")}: ${(r.stderr || r.stdout || r.error?.message || "").trim()}`);
  return r.stdout.trim();
}

/** Runs this same CLI (dist/index.js, or src/index.ts under tsx) with other arguments. */
function self(args: string[], cwd: string) {
  return ejecutar(process.execPath, [...process.execArgv, process.argv[1], ...args], { cwd, timeoutMs: 15 * 60_000, env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", CI: "1" } });
}

export interface CreateResult { dir: string; created: boolean; tickets: string; remote: string; openspec: boolean }

export function createPractice(o: { dir?: string; openspec?: boolean; log?: (s: string) => void } = {}): CreateResult {
  const log = o.log ?? (() => {});
  const root = o.dir ? resolve(o.dir) : practiceRoot();
  const dir = join(root, "facturas-demo");
  const tickets = join(root, "tickets");
  const remote = join(root, "remoto.git");
  const prs = join(root, "prs");
  mkdirSync(tickets, { recursive: true });
  mkdirSync(prs, { recursive: true });
  writeFileSync(join(root, "pr.mjs"), PR_SCRIPT);
  const done = existeConfig(dir) && existsSync(join(dir, ".git"));
  if (done) {
    ensureSettings(dir, root);
    return { dir, created: false, tickets, remote, openspec: existsSync(join(dir, "openspec")) };
  }

  // 1. the module, in git
  log("Creando facturas-demo…");
  mkdirSync(dir, { recursive: true });
  for (const [f, text] of Object.entries(projectFiles())) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    writeFileSync(join(dir, f), text);
  }
  if (!existsSync(join(dir, ".git"))) git(dir, "init", "-q");
  git(dir, "symbolic-ref", "HEAD", "refs/heads/main");
  if (!ejecutar("git", ["config", "user.name"], { cwd: dir }).stdout.trim()) git(dir, "config", "user.name", "Práctica orqen");
  if (!ejecutar("git", ["config", "user.email"], { cwd: dir }).stdout.trim()) git(dir, "config", "user.email", "practica@orqen.local");
  git(dir, "add", "-A");
  if (ejecutar("git", ["rev-parse", "--verify", "HEAD"], { cwd: dir }).codigo !== 0) git(dir, "commit", "-q", "-m", "Listado de facturas");

  // 2. orqen init (OpenSpec too: the light and full lanes write their spec with it)
  log("orqen init…");
  const args = ["init", dir, "--yes", "--no-ai", "--no-animation", ...(o.openspec === false ? ["--no-openspec"] : [])];
  const r = self(args, dir);
  if (!existeConfig(dir)) throw new Error(`orqen init failed: ${(r.stderr || r.stdout).trim().split("\n").slice(-8).join("\n")}`);

  // 3. local tickets, the integration branch, the PR as a file
  ensureSettings(dir, root);

  // 4. everything committed (the worktree of each request is made from main) and a local remote with main and desarrollo
  git(dir, "add", "-A");
  if (git(dir, "status", "--porcelain")) git(dir, "commit", "-q", "-m", "orqen: configuración de la práctica");
  if (!existsSync(remote)) git(root, "init", "-q", "--bare", "remoto.git");
  if (!ejecutar("git", ["remote", "get-url", "origin"], { cwd: dir }).stdout.trim()) git(dir, "remote", "add", "origin", remote);
  if (ejecutar("git", ["rev-parse", "--verify", "desarrollo"], { cwd: dir }).codigo !== 0) git(dir, "branch", "desarrollo", "main");
  git(dir, "push", "-q", "-u", "origin", "main", "desarrollo");
  log("Listo.");
  return { dir, created: true, tickets, remote, openspec: existsSync(join(dir, "openspec")) };
}

/** config.yaml (local tickets, TUT prefix) and orqen/.env (tests, integration branch, PR as a file, support stage). */
function ensureSettings(dir: string, root: string) {
  const cfg = leerConfig(dir);
  cfg.conectores = { requests: { tipo: "local", carpeta: slash(join(root, "tickets")) } };
  cfg.general = { prefijos: { requests: PREFIX, issues: "TUTI" } };
  escribirConfig(dir, cfg);
  const envFile = join(dir, RUTA_ENV);
  const template = existsSync(envFile) ? readFileSync(envFile, "utf8") : "";
  const openspec = join(dir, "node_modules", ".bin", process.platform === "win32" ? "openspec.cmd" : "openspec");
  escribirEnv(dir, template, {
    TEST_COMMAND: "npm test",
    BASE_BRANCH: "main",
    DEVEL_BRANCH: "desarrollo",
    DEVEL_PR_COMMAND: `node "${slash(join(root, "pr.mjs"))}" "${slash(join(root, "prs"))}" {key} {branch} {base} "{title}" {body}`,
    CODE_REVIEW_GATE: "ticket",
    SUPPORT_STAGE: "on",
    ...(existsSync(openspec) ? { OPENSPEC_CMD: slash(openspec) } : {}),
  });
}

function practiceTracker(): LocalTracker {
  const cfg = loadConfig();
  const s = cfg.connectors.requests;
  if (s.kind !== "local") throw new Error("This is not the practice project (its requests are not local tickets). Open it from the app: Tutorial interactivo.");
  return new LocalTracker(s);
}

/** The client sends request n. Idempotent: an existing ticket is left as is. */
export function sendRequest(n: number): { key: string; created: boolean } {
  const req = request(n);
  if (!req) throw new Error(`There is no practice request ${n} (1 or 2).`);
  const t = practiceTracker();
  const key = `${PREFIX}-${n}`;
  try { t.read(key); return { key, created: false }; } catch { /* new */ }
  t.write({ key, title: req.title, description: req.description, reportedBy: CLIENT.name, status: "Abierto", labels: ["orqen"], created: new Date().toISOString(), comments: [] });
  return { key, created: true };
}

export interface ClientResult { key: string; replied: boolean; text?: string; reason?: string }

/**
 * The client reads its ticket and, if the team wrote something it has not read, answers with an LLM
 * (ORQEN_PRACTICE_CLIENT_CMD, default `claude -p`; the prompt goes by stdin). "NADA" = nothing to answer.
 * /approve and /reject only count when the request is in ACCEPTANCE (delivered), so the client never approves a code review.
 */
export function clientTurn(key: string): ClientResult {
  const t = practiceTracker();
  const ticket = t.read(key);
  const req = requestOfKey(ticket.key);
  if (!req) return { key, replied: false, reason: "not a practice request" };
  const last = ticket.comments.at(-1);
  if (!last || !isBotComment(last.body)) return { key, replied: false, reason: "nothing new from the team" };
  if (ticket.clientSeen === last.id) return { key, replied: false, reason: "already read" };

  // one answer at a time per ticket (the app asks every few seconds)
  const lock = join(tmpdir(), `orqen-practice-${ticket.key}.lock`);
  try { if (Date.now() - statSync(lock).mtimeMs < 4 * 60_000) return { key, replied: false, reason: "busy" }; } catch { /* free */ }
  writeFileSync(lock, String(process.pid));
  try {
    const canApprove = ticket.labels.includes(`${STATE_LABEL}acceptance`);
    const conversation = ticket.comments.map((c) => {
      if (isBotComment(c.body)) { const p = parseTeamComment(c.body); return `[Equipo${p.author !== "orqen" ? ` - ${p.author}` : ""}]: ${p.text}`; }
      return `[Vos, Ana]: ${c.body}`;
    }).join("\n\n");
    const prompt = clientPrompt({ req, title: ticket.title, description: ticket.description, conversation, canApprove });
    const cmd = process.env.ORQEN_PRACTICE_CLIENT_CMD || "claude -p --model sonnet";
    const [bin, ...args] = partirComando(cmd);
    const r = ejecutar(bin, args, { cwd: tmpdir(), entrada: prompt, timeoutMs: 180_000 });
    if (r.codigo !== 0 || r.error) {
      const why = r.error ? (r.error as NodeJS.ErrnoException).code === "ENOENT" ? `${bin} is not installed or not in the PATH` : r.error.message : (r.stderr || r.stdout).trim().slice(0, 300);
      throw new Error(`${bin}: ${why || `exit code ${r.codigo}`}`);
    }
    let text = r.stdout.trim().replace(/^["“]|["”]$/g, "").trim();
    // re-read: the team may have written while the client was thinking
    const now = t.read(ticket.key);
    now.clientSeen = last.id;
    t.write(now);
    if (!text || /^nada\.?$/i.test(text)) return { key, replied: false, reason: "nothing to answer" };
    if (!canApprove) text = text.replace(/^\s*\/(approve|reject)\b\s*/i, "").trim();
    if (!text) return { key, replied: false, reason: "nothing to answer" };
    t.addComment(ticket.key, CLIENT.author, CLIENT.name, text);
    return { key, replied: true, text };
  } finally {
    rmSync(lock, { force: true });
  }
}

export async function practice(args: string[]) {
  const json = args.includes("--json");
  const rest = args.filter((a) => a !== "--json");
  const flag = (n: string) => { const i = rest.indexOf(`--${n}`); return i >= 0 ? rest.splice(i, 2)[1] : undefined; };
  const out = (v: unknown, text: string) => console.log(json ? JSON.stringify(v, null, 2) : text);
  const sub = rest[0];
  try {
    if (sub === "create") {
      const dir = flag("dir");
      const noOpenspec = rest.includes("--no-openspec");
      const r = createPractice({ dir, openspec: !noOpenspec, log: (s) => console.error(s) });
      return out(r, `✔ ${r.created ? "Proyecto de práctica creado" : "El proyecto de práctica ya existía"}: ${r.dir}`);
    }
    if (sub === "request") {
      const r = sendRequest(Number(rest[1] ?? "1"));
      return out(r, r.created ? `✔ llegó ${r.key}` : `${r.key} ya había llegado`);
    }
    if (sub === "client") {
      if (!rest[1]) throw new Error("Usage: orqen practice client <KEY>");
      const r = clientTurn(rest[1]);
      return out(r, r.replied ? `← ${CLIENT.name}: ${r.text}` : `(${r.reason})`);
    }
    console.log("Usage: orqen practice create [--dir D] [--no-openspec] [--json] | request <1|2> | client <KEY>");
    if (sub) process.exitCode = 1;
  } catch (e) {
    console.error(`✘ ${(e as Error).message}`);
    process.exitCode = 1;
  }
}
