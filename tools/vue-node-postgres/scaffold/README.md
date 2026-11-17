# {{PROYECTO}}

Created with `orqen create project` (tool `vue-node-postgres`).

| Part | Folder | Runs with |
|---|---|---|
| Frontend (Vue 3 + Vite) | `web/` | `cd web && npm run dev` → http://localhost:5173 |
| API (Node + Express) | `api/` | `cd api && npm run dev` → http://localhost:{{PUERTO_API}} |
| PostgreSQL | Docker | `node orqen/tools/db.mjs up` → localhost:{{PUERTO_DB}} |

You do not need to start anything by hand: `orqen env up` starts the database and the API (`--all` also the frontend),
runs the migrations, and `orqen env down` stops everything. Tests: `orqen env test`.

- Migrations: `api/migrations/*.sql`, applied in order by `cd api && npm run migrate`.
- Empty database: `node orqen/tools/db.mjs reset`.
