/**
 * `orqen` with no arguments opens the ORQEN desktop app (Windows, macOS, Linux) on the current repository.
 * The app shows the logo animation itself, so it looks smooth; the terminal returns right away.
 *
 * Where it looks (first match wins):
 *   ORQEN_APP                          path to the executable (or the .app on macOS)
 *   app/target/release/orqen-desktop   a build next to this CLI (working on the orqen repo itself)
 *   Windows  %LOCALAPPDATA%\Programs\ORQEN\ORQEN.exe, %ProgramFiles%\ORQEN\ORQEN.exe
 *   macOS    /Applications/ORQEN.app, ~/Applications/ORQEN.app
 *   Linux    orqen-desktop on the PATH, ~/.local/bin/orqen-desktop, /opt/ORQEN/orqen-desktop, ~/Applications/ORQEN*.AppImage
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

type Env = Record<string, string | undefined>;

/** Real path of this CLI: `npm link` / `pnpm link` run it through a link in the global node_modules, not from the orqen repo. */
function cliPath(): string {
  const p = process.argv[1] ?? "";
  try { return p ? realpathSync(p) : ""; } catch { return p; }
}

export function findApp(platform: NodeJS.Platform = process.platform, env: Env = process.env, exists: (p: string) => boolean = existsSync, home = homedir(), cliScript = cliPath()): string | undefined {
  if (env.ORQEN_APP) return exists(env.ORQEN_APP) ? env.ORQEN_APP : undefined;
  const candidates: string[] = [];
  // cli/dist/index.js → app/target/release (the app built with `cargo build --release` in the orqen repo)
  if (cliScript) candidates.push(join(dirname(cliScript), "..", "..", "app", "target", "release", platform === "win32" ? "orqen-desktop.exe" : "orqen-desktop"));
  if (platform === "win32") {
    if (env.LOCALAPPDATA) candidates.push(join(env.LOCALAPPDATA, "Programs", "ORQEN", "ORQEN.exe"));
    if (env.ProgramFiles) candidates.push(join(env.ProgramFiles, "ORQEN", "ORQEN.exe"));
  } else if (platform === "darwin") {
    candidates.push("/Applications/ORQEN.app", join(home, "Applications", "ORQEN.app"));
  } else {
    for (const dir of (env.PATH ?? "").split(":").filter(Boolean)) candidates.push(join(dir, "orqen-desktop"));
    candidates.push(join(home, ".local", "bin", "orqen-desktop"), "/opt/ORQEN/orqen-desktop");
    const apps = join(home, "Applications");
    try { for (const f of readdirSync(apps)) if (/^ORQEN.*\.AppImage$/i.test(f)) candidates.push(join(apps, f)); } catch { /* no folder */ }
  }
  return candidates.find((c) => exists(c));
}

/** Opens the app on `repo` without waiting for it. Returns false if it is not installed. */
export function openApp(repo: string, app = findApp()): boolean {
  if (!app) return false;
  // the app runs this same CLI (it may not be on the PATH: npx, a local build)
  const args = ["--repo", repo, "--cli", process.argv[1] ?? "", "--node", process.execPath];
  if (process.platform === "darwin" && app.endsWith(".app")) {
    return spawnSync("open", ["-a", app, "--args", ...args], { stdio: "ignore" }).status === 0;
  }
  const child = spawn(app, args, { detached: true, stdio: "ignore", windowsHide: false });
  child.on("error", () => { /* reported by the caller as not opened */ });
  child.unref();
  return true;
}
