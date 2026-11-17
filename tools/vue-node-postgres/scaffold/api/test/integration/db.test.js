// Integration: needs the database running (orqen env up) and the migrations applied.
import "../../src/env.js";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { crearApp } from "../../src/app.js";
import { pool } from "../../src/db.js";

after(() => pool.end());

test("the API reaches PostgreSQL", async () => {
  const server = crearApp({ db: pool }).listen(0);
  try {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/health`);
    assert.deepEqual(await r.json(), { status: "ok", db: "ok" });
  } finally {
    server.close();
  }
});

test("the initial migration created the ejemplo table", async () => {
  const { rows } = await pool.query("SELECT to_regclass('public.ejemplo') AS t");
  assert.equal(rows[0].t, "ejemplo");
});
