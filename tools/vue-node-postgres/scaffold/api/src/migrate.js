// Applies api/migrations/*.sql in order, once each (tracked in the schema_migrations table).
import "./env.js";
import { readdirSync, readFileSync } from "node:fs";
import { pool } from "./db.js";

const dir = new URL("../migrations/", import.meta.url);
await pool.query("CREATE TABLE IF NOT EXISTS schema_migrations (id text PRIMARY KEY, applied_at timestamptz DEFAULT now())");
const { rows } = await pool.query("SELECT id FROM schema_migrations");
const applied = new Set(rows.map((r) => r.id));
for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
  if (applied.has(file)) continue;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(readFileSync(new URL(file, dir), "utf8"));
    await client.query("INSERT INTO schema_migrations (id) VALUES ($1)", [file]);
    await client.query("COMMIT");
    console.log(`applied ${file}`);
  } catch (e) {
    await client.query("ROLLBACK");
    console.error(`failed ${file}: ${e.message}`);
    process.exitCode = 1;
    break;
  } finally {
    client.release();
  }
}
await pool.end();
