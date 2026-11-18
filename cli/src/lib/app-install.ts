/**
 * Download and install the ORQEN desktop app, so nobody has to install Rust or a C++ toolchain:
 * CI (.github/workflows/app.yml) builds it for each platform and attaches it to the GitHub release of the same version as the CLI.
 *
 *   orqen-app-win32-x64.tar.gz     ORQEN.exe      → %LOCALAPPDATA%\Programs\ORQEN\
 *   orqen-app-darwin-arm64.tar.gz  ORQEN.app/     → ~/Applications/
 *   orqen-app-darwin-x64.tar.gz    ORQEN.app/     → ~/Applications/
 *   orqen-app-linux-x64.tar.gz     orqen-desktop  → ~/.local/bin/
 *
 * ORQEN_APP_BASE overrides where the releases are (default: the GitHub releases of the orqen repo).
 * What was installed is recorded in ~/.orqen/app.json, so a new CLI version also updates the app.
 */
import { spawnSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { findApp } from "./app.ts";

export const RELEASES = "https://github.com/sistemas-telpin/orqen/releases";
const SUPPORTED = ["win32-x64", "darwin-arm64", "darwin-x64", "linux-x64"];

type Env = Record<string, string | undefined>;
export interface Platform { platform: NodeJS.Platform; arch: string; env: Env; home: string }
const current = (): Platform => ({ platform: process.platform, arch: process.arch, env: process.env, home: homedir() });

export const assetName = (p: Pick<Platform, "platform" | "arch">) => `orqen-app-${p.platform}-${p.arch}.tar.gz`;
export const supported = (p: Pick<Platform, "platform" | "arch">) => SUPPORTED.includes(`${p.platform}-${p.arch}`);

export function installDir(p: Platform): string {
  if (p.platform === "win32") return join(p.env.LOCALAPPDATA ?? join(p.home, "AppData", "Local"), "Programs", "ORQEN");
  if (p.platform === "darwin") return join(p.home, "Applications");
  return join(p.home, ".local", "bin");
}

const stateFile = (home: string) => join(home, ".orqen", "app.json");
export interface Installed { version: string; path: string; installedAt: string }
export function installed(home = homedir()): Installed | undefined {
  try { return JSON.parse(readFileSync(stateFile(home), "utf8")); } catch { return undefined; }
}

/** The app installed by orqen is older than this CLI. */
export function needsUpdate(version: string, app: string | undefined, home = homedir()): boolean {
  const st = installed(home);
  return !!(app && st && st.path === app && st.version !== version);
}

export interface DownloadOptions { version: string; base?: string; onProgress?: (done: number, total: number) => void; target?: Platform }

/** Downloads the app for this platform, installs it and returns the path of the executable (or .app). */
export async function downloadApp(o: DownloadOptions): Promise<string> {
  const p = o.target ?? current();
  if (!supported(p)) throw new Error(`There is no ORQEN app build for ${p.platform}-${p.arch} yet.`);
  const base = (o.base ?? p.env.ORQEN_APP_BASE ?? RELEASES).replace(/\/$/, "");
  const asset = assetName(p);
  let res: Response | undefined;
  for (const url of [`${base}/download/v${o.version}/${asset}`, `${base}/latest/download/${asset}`]) {
    res = await fetch(url, { redirect: "follow" });
    if (res.ok) break;
    if (res.status !== 404) throw new Error(`Could not download the app (${res.status} ${url})`);
  }
  if (!res?.ok || !res.body) throw new Error(`No published app found (${asset}). It is published with each release of orqen.`);

  const total = Number(res.headers.get("content-length") ?? 0);
  let done = 0;
  const tmp = join(tmpdir(), `${asset}-${process.pid}`);
  const body = Readable.fromWeb(res.body as any);
  body.on("data", (chunk: Buffer) => { done += chunk.length; o.onProgress?.(done, total); });
  await pipeline(body, createWriteStream(tmp));

  const dir = installDir(p);
  mkdirSync(dir, { recursive: true });
  if (p.platform === "darwin") rmSync(join(dir, "ORQEN.app"), { recursive: true, force: true });   // replace the whole bundle
  // tar ships with Windows 10+ (bsdtar), macOS and Linux
  const r = spawnSync("tar", ["-xzf", tmp, "-C", dir], { encoding: "utf8" });
  rmSync(tmp, { force: true });
  if (r.status !== 0) {
    const busy = p.platform === "win32" && /denied|used by another|being used/i.test(r.stderr ?? "");
    throw new Error(busy ? "Close the ORQEN app and run `orqen` again to update it." : `Could not unpack the app: ${(r.stderr || r.error?.message || "").trim()}`);
  }
  const app = p.platform === "win32" ? join(dir, "ORQEN.exe") : p.platform === "darwin" ? join(dir, "ORQEN.app") : join(dir, "orqen-desktop");
  if (!existsSync(app)) throw new Error(`The downloaded package does not contain ${app}`);
  if (p.platform === "win32") startMenuShortcut(app, p.env);

  mkdirSync(join(p.home, ".orqen"), { recursive: true });
  writeFileSync(stateFile(p.home), JSON.stringify({ version: o.version, path: app, installedAt: new Date().toISOString() }, null, 2));
  return app;
}

/** Start menu entry on Windows (best effort). */
function startMenuShortcut(app: string, env: Env) {
  if (!env.APPDATA) return;
  const lnk = join(env.APPDATA, "Microsoft", "Windows", "Start Menu", "Programs", "ORQEN.lnk");
  const ps = `$s=(New-Object -ComObject WScript.Shell).CreateShortcut('${lnk.replace(/'/g, "''")}');$s.TargetPath='${app.replace(/'/g, "''")}';$s.Save()`;
  spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], { stdio: "ignore", windowsHide: true });
}

/** Installed app, downloading or updating it if needed. `onStatus` reports what is happening. */
export async function ensureApp(version: string, onStatus: (msg: string, progress?: number) => void, force = false): Promise<string | undefined> {
  let app = findApp();
  const update = needsUpdate(version, app);
  if (app && !update && !force) return app;
  if (process.env.ORQEN_NO_APP_DOWNLOAD) return app;
  onStatus(app ? `Updating the ORQEN app to ${version}…` : "Downloading the ORQEN app (only the first time)…");
  try {
    app = await downloadApp({ version, onProgress: (d, t) => t && onStatus("", Math.round((d / t) * 100)) });
  } catch (e) {
    if (!app) throw e;
    onStatus(`Could not update the app: ${(e as Error).message}`);
  }
  return app;
}
