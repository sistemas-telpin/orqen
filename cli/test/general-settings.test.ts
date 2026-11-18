import assert from "node:assert/strict";
import test from "node:test";
import { Config } from "../src/lib/config.ts";
import { generalSettings, updateGeneral } from "../src/lib/general-settings.ts";
import { connectorSettings } from "../src/connectors/config.ts";

function config() {
  return Config.parse({
    version: 1, orqen: { cli: "0.1.0", kit: "0.1.0" }, proyecto: { nombre: "Example" },
    openspec: { instalacion: "global" }, stack: { resumen: "" }, entornos: {},
    conectores: { requests: { tipo: "github", repo: "team/requests", prefijo: "OLD" }, issues: { tipo: "asana", proyecto: "12", prefijo: "DEV" } },
  });
}

test("general settings preserve old prefixes until explicitly saved and move them out of providers", () => {
  const original = config();
  assert.deepEqual(generalSettings(original), { prefijos: { requests: "OLD", issues: "DEV" } });
  const updated = updateGeneral(original, { prefijos: { requests: " req ", issues: "tkt" } }, false);
  assert.deepEqual(updated.general, { prefijos: { requests: "REQ", issues: "TKT" } });
  assert.equal(updated.conectores?.requests.prefijo, undefined);
  assert.equal(updated.conectores?.issues?.prefijo, undefined);
  assert.equal(original.conectores?.requests.prefijo, "OLD");
  assert.equal(connectorSettings(updated.conectores!.requests, {}, updated.general!.prefijos.requests).kind, "github");
  const requests = connectorSettings(updated.conectores!.requests, {}, updated.general!.prefijos.requests);
  const issues = connectorSettings(updated.conectores!.issues!, {}, updated.general!.prefijos.issues);
  assert.equal(requests.kind === "github" && requests.prefix, "REQ");
  assert.equal(issues.kind === "asana" && issues.prefix, "TKT");
  // Switching providers keeps the role prefix.
  const swapped = connectorSettings({ tipo: "asana", proyecto: "99" }, {}, updated.general!.prefijos.requests);
  assert.equal(swapped.kind === "asana" && swapped.prefix, "REQ");
});

test("invalid prefixes, collisions and history are rejected without modifying configuration", () => {
  const original = config();
  const before = JSON.stringify(original);
  for (const value of ["", "../req", "1REQ", "REQ-", "A".repeat(21)]) {
    assert.throws(() => updateGeneral(original, { prefijos: { requests: value, issues: "TKT" } }, false));
  }
  assert.throws(() => updateGeneral(original, { prefijos: { requests: "REQ", issues: "req" } }, false), /diferentes/);
  assert.throws(() => updateGeneral(original, { prefijos: { requests: "REQ", issues: "TKT" } }, true), /historial/);
  assert.deepEqual(updateGeneral(original, generalSettings(original), true).general, generalSettings(original));
  assert.equal(JSON.stringify(original), before);
});

test("Jira aliases require an explicit project while existing native prefixes remain unchanged", () => {
  const original = config();
  original.conectores!.requests = { tipo: "jira", proyecto: "SUP", filtro: "project = SUP" };
  assert.equal(generalSettings(original).prefijos.requests, "SUP");
  const updated = updateGeneral(original, { prefijos: { requests: "REQ", issues: "TKT" } }, false);
  const settings = connectorSettings(updated.conectores!.requests, {}, updated.general!.prefijos.requests);
  assert.equal(settings.kind === "jira" && settings.prefix, "REQ");
  delete original.conectores!.requests.proyecto;
  assert.throws(() => updateGeneral(original, { prefijos: { requests: "REQ", issues: "TKT" } }, false), /proyecto de Jira/);
});
