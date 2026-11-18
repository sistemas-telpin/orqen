/** The desktop app is downloaded from the release (built by CI), installed where `orqen` looks for it, and updated with the CLI. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assetName, downloadApp, installDir, installed, needsUpdate, supported } from "../src/lib/app-install.ts";

test("downloads the package of the CLI version (or the latest), unpacks it and records it", async (t) => {
  const pkg = mkdtempSync(join(tmpdir(), "orqen-pkg-"));
  writeFileSync(join(pkg, "orqen-desktop"), "#!/bin/sh\necho app\n");
  const tgz = join(pkg, "..", `pkg-${process.pid}.tar.gz`);
  execFileSync("tar", ["-czf", tgz, "-C", pkg, "orqen-desktop"]);
  const body = readFileSync(tgz);
  const hits: string[] = [];
  const server = createServer((req, res) => {
    hits.push(req.url!);
    if (req.url === "/download/v9.9.9/orqen-app-linux-x64.tar.gz" || req.url === "/latest/download/orqen-app-linux-x64.tar.gz") {
      res.writeHead(200, { "content-length": body.length }); return res.end(body);
    }
    res.writeHead(404); res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const home = mkdtempSync(join(tmpdir(), "orqen-home-"));
  const target = { platform: "linux" as const, arch: "x64", env: {}, home };

  let last = 0;
  const app = await downloadApp({ version: "9.9.9", base, target, onProgress: (d) => { last = d; } });
  assert.equal(app, join(home, ".local", "bin", "orqen-desktop"));
  assert.ok(existsSync(app));
  assert.equal(last, body.length);
  assert.equal(installed(home)?.version, "9.9.9");
  assert.equal(needsUpdate("9.9.9", app, home), false);
  assert.equal(needsUpdate("10.0.0", app, home), true, "a new CLI version updates the app it installed");
  assert.equal(needsUpdate("10.0.0", "/somewhere/else", home), false, "an app the person installed by hand is left alone");

  // a version without its own release falls back to the latest one
  await downloadApp({ version: "1.2.3", base, target });
  assert.deepEqual(hits.slice(-2), ["/download/v1.2.3/orqen-app-linux-x64.tar.gz", "/latest/download/orqen-app-linux-x64.tar.gz"]);
  await assert.rejects(downloadApp({ version: "1.0.0", base, target: { ...target, arch: "ia32" } }), /no ORQEN app build/);
});

test("package names and install folders per platform", () => {
  assert.equal(assetName({ platform: "win32", arch: "x64" }), "orqen-app-win32-x64.tar.gz");
  assert.ok(supported({ platform: "darwin", arch: "arm64" }) && !supported({ platform: "linux", arch: "arm64" }));
  assert.equal(installDir({ platform: "win32", arch: "x64", env: { LOCALAPPDATA: "C:/U/L" }, home: "/h" }), join("C:/U/L", "Programs", "ORQEN"));
  assert.equal(installDir({ platform: "darwin", arch: "arm64", env: {}, home: "/h" }), join("/h", "Applications"));
  mkdirSync(join(tmpdir(), "x"), { recursive: true });
});
