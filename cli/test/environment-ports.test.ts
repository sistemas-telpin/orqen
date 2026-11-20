/** Each Worq (worktree) gets its own ports for processes that use ${port}, so several can be up at once. */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  bajarProcesos, conPuertos, estadoProcesos, levantarProcesos, ProcesoEntorno, puertoDinamico, puertoLibre, variablesConPuertos,
} from "../src/lib/processes.ts";

// a tiny server on $PORT (a file, so the command is the same in sh and cmd.exe)
const servidor = join(mkdtempSync(join(tmpdir(), "orqen-srv-")), "server.cjs");
writeFileSync(servidor, `require("http").createServer((q, r) => r.end("ok " + process.env.PORT)).listen(Number(process.env.PORT))`);

async function libreDesde(n: number) { while (!(await puertoLibre(n))) n++; return n; }

test("conPuertos and puertoDinamico", () => {
  assert.equal(conPuertos("http://localhost:${port}/a ${port.db}", { api: 9000, db: 5432 }, "api"), "http://localhost:9000/a 5432");
  assert.equal(conPuertos("${port.otro}", { api: 1 }, "api"), "${port.otro}");
  const fijo = ProcesoEntorno.parse({ nombre: "api", comando: "node s.js", puerto: 3000 });
  const din = ProcesoEntorno.parse({ nombre: "api", comando: "node s.js --port ${port}", puerto: 3000 });
  assert.equal(puertoDinamico(fijo), false);
  assert.equal(puertoDinamico(din), true);
  assert.equal(puertoDinamico(fijo, { API_URL: "http://localhost:${port.api}" }), true);
});

test("two worktrees with the same environment get different ports, their own status and stop independently", async () => {
  const base = await libreDesde(41000 + Math.floor(Math.random() * 2000));
  const procesos = [ProcesoEntorno.parse({
    nombre: "api", comando: `node "${servidor}"`, puerto: base, url: "http://localhost:${port}/", web: "http://localhost:${port}/app", espera_seg: 20,
  })];
  const variables = { API_URL: "http://localhost:${port.api}" };
  const a = mkdtempSync(join(tmpdir(), "orqen-wt-a-"));
  const b = mkdtempSync(join(tmpdir(), "orqen-wt-b-"));
  writeFileSync(join(a, "x"), ""); writeFileSync(join(b, "x"), "");
  try {
    const ra = await levantarProcesos(a, procesos, variables);
    assert.ok(ra.ok, ra.detalle);
    const rb = await levantarProcesos(b, procesos, variables);
    assert.ok(rb.ok, rb.detalle);

    const [sa] = await estadoProcesos(a, procesos, variables);
    const [sb] = await estadoProcesos(b, procesos, variables);
    assert.equal(sa.corriendo, true);
    assert.equal(sb.corriendo, true);
    assert.equal(sa.puerto, base);
    assert.notEqual(sb.puerto, sa.puerto);
    assert.equal(sb.web, `http://localhost:${sb.puerto}/app`);
    assert.equal(await (await fetch(`http://localhost:${sb.puerto}/`)).text(), `ok ${sb.puerto}`);
    assert.equal(variablesConPuertos(b, procesos, variables).API_URL, `http://localhost:${sb.puerto}`);
    assert.equal(variablesConPuertos(b, procesos, variables).ORQEN_PORT_API, String(sb.puerto));

    // a second `up` in the same worktree does not start it twice
    const otra = await levantarProcesos(b, procesos, variables);
    assert.match(otra.detalle, /already running/);

    assert.deepEqual(bajarProcesos(a, ["api"]), ["api"]);
    const [sa2] = await estadoProcesos(a, procesos, variables);
    const [sb2] = await estadoProcesos(b, procesos, variables);
    assert.equal(sa2.corriendo, false);
    assert.equal(sb2.corriendo, true);
    // the stopped worktree keeps its port for next time (stable URLs)
    assert.equal(sa2.puerto, base);
  } finally {
    bajarProcesos(a); bajarProcesos(b);
  }
});

test("unknown process names are rejected", async () => {
  const d = mkdtempSync(join(tmpdir(), "orqen-wt-"));
  const r = await levantarProcesos(d, [ProcesoEntorno.parse({ nombre: "api", comando: "node -v" })], {}, { solo: ["web"] });
  assert.equal(r.ok, false);
  assert.match(r.detalle, /Unknown process: web/);
});
