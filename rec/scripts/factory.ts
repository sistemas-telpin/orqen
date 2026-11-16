/**
 * Registro del proceso dentro del repo: factory/<KEY>/
 *
 *   estado.json                  proyección del estado actual (la fuente de verdad operativa es rec/.estado)
 *   bitacora.md                  una línea por transición
 *   ronda-N/analisis.md|json     lo que se decidió en el grilling: resumen, criterios, decisiones, carril, SIS
 *   ronda-N/ejecucion/           script, pasos, rollback y verificación del carril operativo
 *
 * Se commitea junto con la rama del REC, así queda la trazabilidad al lado del código y de la spec.
 * Escribir acá nunca debe romper el proceso: los errores se loguean y se sigue.
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Rec } from "./store.ts";

export class Factory {
  constructor(private dir: string) {}

  dirDe = (key: string) => join(this.dir, key);
  rondaDir = (key: string, ronda: number) => join(this.dir, key, `ronda-${ronda}`);

  private seguro(fn: () => void) {
    try { fn(); } catch (e) { console.error(`[rec] aviso: no pude escribir en factory/: ${(e as Error).message}`); }
  }

  /** Escribe `ronda-N/<archivo>` (crea los directorios). */
  escribir(rec: Pick<Rec, "key" | "ronda">, archivo: string, contenido: string) {
    this.seguro(() => {
      const f = join(this.rondaDir(rec.key, rec.ronda), archivo);
      mkdirSync(join(f, ".."), { recursive: true });
      writeFileSync(f, contenido);
    });
  }

  /** Línea de bitácora + proyección de estado. */
  registrar(rec: Rec, desde: string, hacia: string, detalle: string, agente?: string) {
    this.seguro(() => {
      mkdirSync(this.dirDe(rec.key), { recursive: true });
      appendFileSync(join(this.dirDe(rec.key), "bitacora.md"),
        `- ${new Date().toISOString()} · ${desde} → ${hacia}${detalle ? ` · ${detalle.replace(/\s+/g, " ")}` : ""}${agente ? ` · (${agente})` : ""}\n`);
      writeFileSync(join(this.dirDe(rec.key), "estado.json"), JSON.stringify({
        _nota: "Proyección informativa generada por `rec`. La fuente de verdad es rec/.estado.",
        key: rec.key, estado: hacia, ronda: rec.ronda, via: rec.via, carril: rec.carril, analista: rec.analista,
        sis: rec.sis, rama: rec.rama || undefined, cambio: rec.cambio || undefined,
        actualizado: new Date().toISOString(),
      }, null, 2) + "\n");
    });
  }
}
