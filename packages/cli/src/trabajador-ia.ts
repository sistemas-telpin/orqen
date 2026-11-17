/**
 * Proceso aparte para el análisis rápido del stack (lo lanza `orqen init`).
 *
 * Corre desacoplado de la terminal: sin stdin/stdout compartidos y, en Windows, sin consola. Así el agente
 * (y lo que él lance) no puede tocar el modo de la consola ni frenar el event loop mientras la persona
 * contesta las preguntas del init. El resultado se deja en un archivo que el init lee cuando lo necesita.
 *
 * Uso interno:  node trabajador-ia.js <trabajo.json>
 *   trabajo.json = { repo, comando, deteccion, salida }
 */
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { explorarRapido, type ResultadoExploracion } from "./lib/agente.ts";

const trabajo = JSON.parse(readFileSync(process.argv[2], "utf8"));
let r: ResultadoExploracion;
try {
  r = await explorarRapido(trabajo.repo, trabajo.comando, trabajo.deteccion, { timeoutMs: trabajo.timeoutMs });
} catch (e) {
  r = { ok: false, errores: [(e as Error).message], salida: "" };
}
writeFileSync(trabajo.salida + ".tmp", JSON.stringify(r));
renameSync(trabajo.salida + ".tmp", trabajo.salida);   // atómico: el init nunca lee un archivo a medio escribir
