import cors from "cors";
import express from "express";

/** The Express app, without listening: tests use it directly. `db` only needs a `query` method. */
export function crearApp({ db } = {}) {
  const app = express();
  app.use(cors());
  app.use(express.json());

  app.get("/health", async (_req, res) => {
    if (!db) return res.json({ status: "ok", db: "not configured" });
    try {
      await db.query("SELECT 1");
      res.json({ status: "ok", db: "ok" });
    } catch (e) {
      res.status(503).json({ status: "error", db: e.message });
    }
  });

  app.get("/api/saludo", (req, res) => {
    res.json({ mensaje: `Hola, ${req.query.nombre ?? "mundo"}` });
  });

  return app;
}
