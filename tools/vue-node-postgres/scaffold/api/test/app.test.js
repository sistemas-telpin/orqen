import assert from "node:assert/strict";
import { test } from "node:test";
import { crearApp } from "../src/app.js";

async function get(app, path) {
  const server = app.listen(0);
  try {
    const { port } = server.address();
    const r = await fetch(`http://127.0.0.1:${port}${path}`);
    return { status: r.status, body: await r.json() };
  } finally {
    server.close();
  }
}

test("GET /api/saludo greets by name", async () => {
  const r = await get(crearApp(), "/api/saludo?nombre=Ana");
  assert.equal(r.status, 200);
  assert.equal(r.body.mensaje, "Hola, Ana");
});

test("GET /health reports when the database fails", async () => {
  const db = { query: async () => { throw new Error("down"); } };
  const r = await get(crearApp({ db }), "/health");
  assert.equal(r.status, 503);
});
