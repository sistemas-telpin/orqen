/**
 * Run quick stack analysis for orqen init in a detached process.
 *
 * Keep the agent and its subprocesses separate from the terminal
 * while the user answers setup prompts. The worker writes its result
 * to a file for the main process.
 *
 * Internal usage: node ai-worker.js <job.json>
 *   job.json = { repo, comando, deteccion, salida }
 */
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { explorarRapido, type ResultadoExploracion } from "./lib/agent.ts";

const trabajo = JSON.parse(readFileSync(process.argv[2], "utf8"));
let r: ResultadoExploracion;
try {
  r = await explorarRapido(trabajo.repo, trabajo.comando, trabajo.deteccion, { timeoutMs: trabajo.timeoutMs });
} catch (e) {
  r = { ok: false, errores: [(e as Error).message], salida: "" };
}
writeFileSync(trabajo.salida + ".tmp", JSON.stringify(r));
renameSync(trabajo.salida + ".tmp", trabajo.salida);   // Rename atomically so init reads a complete result.
