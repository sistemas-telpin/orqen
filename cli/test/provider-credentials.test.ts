import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { providerEnv, providerFile, saveProviders } from "../src/lib/provider-credentials.ts";
import { connectorsView } from "../src/lib/connectors-edit.ts";

test("provider accounts are shared between repositories without storing tokens in either project", () => {
  const root = mkdtempSync(join(tmpdir(), "orqen-providers-"));
  const previous = process.env.ORQEN_USER_CONFIG_DIR;
  process.env.ORQEN_USER_CONFIG_DIR = join(root, "user");
  try {
    const first = join(root, "first");
    const second = join(root, "second");
    mkdirSync(join(first, "orqen"), { recursive: true });
    mkdirSync(join(second, "orqen"), { recursive: true });
    writeFileSync(join(first, "orqen", ".env"), "GITHUB_TOKEN=legacy-local\nBASE_BRANCH=devel\n");
    assert.equal(providerEnv(first, {}).GITHUB_TOKEN, "legacy-local");
    const connectors = { requests: { tipo: "github" as const, repo: "team/app" } };
    saveProviders(connectors, { GITHUB_TOKEN: "shared-provider-token", BASE_BRANCH: "never-global" }, providerEnv(first, {}));
    assert.equal(providerEnv(first, {}).GITHUB_TOKEN, "shared-provider-token");
    assert.equal(providerEnv(second, {}).GITHUB_TOKEN, "shared-provider-token");
    assert.equal(providerEnv(first, {}).BASE_BRANCH, "devel");
    assert.equal(providerEnv(second, {}).BASE_BRANCH, undefined);
    assert.doesNotMatch(readFileSync(providerFile(), "utf8"), /BASE_BRANCH|never-global/);
    assert.doesNotMatch(readFileSync(join(first, "orqen", ".env"), "utf8"), /shared-provider-token/);
    const view = connectorsView(connectors, providerEnv(second, {}));
    assert.doesNotMatch(JSON.stringify(view), /shared-provider-token/);
    assert.equal(view.secrets.GITHUB_TOKEN, "••••oken");
    saveProviders(connectors, {}, { GITHUB_TOKEN: "outdated-local" });
    assert.equal(providerEnv(second, {}).GITHUB_TOKEN, "shared-provider-token");
    saveProviders({ requests: { tipo: "jira", credenciales: "CLIENT" } }, { CLIENT_TOKEN: "client-secret", CLIENT_URL: "https://client.example", CLIENT_USER: "bot" }, {});
    assert.equal(providerEnv(second, {}).CLIENT_TOKEN, "client-secret");
    assert.equal(providerEnv(second, {}).GITHUB_TOKEN, "shared-provider-token");

    // the environment (CI, a shell export) wins over the shared file; orqen/.env loaded into the environment does not
    assert.equal(providerEnv(second, { GITHUB_TOKEN: "ci-token" }).GITHUB_TOKEN, "ci-token");
    assert.equal(providerEnv(second, { GITHUB_TOKEN: "" }).GITHUB_TOKEN, "shared-provider-token");
    assert.equal(providerEnv(first, { GITHUB_TOKEN: "legacy-local" }).GITHUB_TOKEN, "shared-provider-token");
    assert.equal(providerEnv(first, { GITHUB_TOKEN: "ci-token" }).GITHUB_TOKEN, "ci-token");
  } finally {
    if (previous === undefined) delete process.env.ORQEN_USER_CONFIG_DIR;
    else process.env.ORQEN_USER_CONFIG_DIR = previous;
  }
});
