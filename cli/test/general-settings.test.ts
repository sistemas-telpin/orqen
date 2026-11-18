import assert from "node:assert/strict";
import test from "node:test";
import { Config } from "../src/lib/config.ts";
import { generalSettings, updateGeneral } from "../src/lib/general-settings.ts";
import { connectorSettings } from "../src/connectors/config.ts";

function config() {
  return Config.parse({
    version: 1, orqen: { cli: "0.1.0", kit: "0.1.0" }, proyecto: { nombre: "Example" },
    openspec: { instalacion: "global" }, stack: { resumen: "" }, entornos: {},
    conectores: { externo: { tipo: "github", repo: "team/requests", prefijo: "OLD" }, interno: { tipo: "asana", proyecto: "12", prefijo: "DEV" } },
  });
}

test("general settings preserve old prefixes until explicitly saved and move them out of providers", () => {
  const original = config();
  assert.deepEqual(generalSettings(original), { prefijos: { requerimientos: "OLD", tickets: "DEV" } });
  const updated = updateGeneral(original, { prefijos: { requerimientos: " req ", tickets: "tkt" } }, false);
  assert.deepEqual(updated.general, { prefijos: { requerimientos: "REQ", tickets: "TKT" } });
  assert.equal(updated.conectores?.externo.prefijo, undefined);
  assert.equal(updated.conectores?.interno?.prefijo, undefined);
  assert.equal(original.conectores?.externo.prefijo, "OLD");
  assert.equal(connectorSettings(updated.conectores!.externo, {}, updated.general!.prefijos.requerimientos).kind, "github");
  const external = connectorSettings(updated.conectores!.externo, {}, updated.general!.prefijos.requerimientos);
  const internal = connectorSettings(updated.conectores!.interno!, {}, updated.general!.prefijos.tickets);
  assert.equal(external.kind === "github" && external.prefix, "REQ");
  assert.equal(internal.kind === "asana" && internal.prefix, "TKT");
  // Switching providers keeps the role prefix.
  const swapped = connectorSettings({ tipo: "asana", proyecto: "99" }, {}, updated.general!.prefijos.requerimientos);
  assert.equal(swapped.kind === "asana" && swapped.prefix, "REQ");
});

test("invalid prefixes, collisions and history are rejected without modifying configuration", () => {
  const original = config();
  const before = JSON.stringify(original);
  for (const value of ["", "../req", "1REQ", "REQ-", "A".repeat(21)]) {
    assert.throws(() => updateGeneral(original, { prefijos: { requerimientos: value, tickets: "TKT" } }, false));
  }
  assert.throws(() => updateGeneral(original, { prefijos: { requerimientos: "REQ", tickets: "req" } }, false), /diferentes/);
  assert.throws(() => updateGeneral(original, { prefijos: { requerimientos: "REQ", tickets: "TKT" } }, true), /historial/);
  assert.deepEqual(updateGeneral(original, generalSettings(original), true).general, generalSettings(original));
  assert.equal(JSON.stringify(original), before);
});

test("Jira aliases require an explicit project while existing native prefixes remain unchanged", () => {
  const original = config();
  original.conectores!.externo = { tipo: "jira", proyecto: "SUP", filtro: "project = SUP" };
  assert.equal(generalSettings(original).prefijos.requerimientos, "SUP");
  const updated = updateGeneral(original, { prefijos: { requerimientos: "REQ", tickets: "TKT" } }, false);
  const settings = connectorSettings(updated.conectores!.externo, {}, updated.general!.prefijos.requerimientos);
  assert.equal(settings.kind === "jira" && settings.prefix, "REQ");
  delete original.conectores!.externo.proyecto;
  assert.throws(() => updateGeneral(original, { prefijos: { requerimientos: "REQ", tickets: "TKT" } }, false), /proyecto de Jira/);
});
