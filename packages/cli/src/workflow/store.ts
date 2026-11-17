/** Store request state in Git-ignored JSON files under orqen/state/. */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Carril, Estado, Via } from "./states.ts";

export interface Rec {
  key: string;
  estado: Estado;
  ronda: number;                 // One plus the number of customer rejections.
  intentosTesting: number;
  rondasPreguntas: number;
  ultimoComentarioVisto: string;
  rama: string;
  cambio: string;                // OpenSpec change ID.
  via?: Via;                     // Set during analysis and updated when operational work escalates to development.
  carril?: Carril;               // Development lane approved by the analyst.
  analista?: string;             // Analyst who led the review.
  sis?: string;                  // Key of the SIS created after analysis.
  artefactos: Record<string, any>;
  feedback: Array<{ de: string; texto?: string; rechazo?: string }>;
  lock?: { agente: string; desde: string };
  estadoPrevioBloqueo?: Estado;
}

export const recNuevo = (key: string): Rec => ({
  key, estado: "NUEVO", ronda: 1, intentosTesting: 0, rondasPreguntas: 0, ultimoComentarioVisto: "",
  rama: "", cambio: "", artefactos: {}, feedback: [],
});

export interface Evento { ts: string; desde: Estado; hacia: Estado; detalle: string; agente?: string }

export class Store {
  constructor(private dir: string) { mkdirSync(dir, { recursive: true }); }
  private ruta = (key: string) => join(this.dir, `${key}.json`);

  get(key: string): Rec | undefined {
    return existsSync(this.ruta(key)) ? JSON.parse(readFileSync(this.ruta(key), "utf8")) : undefined;
  }
  save(rec: Rec) {
    const tmp = this.ruta(rec.key) + ".tmp";
    writeFileSync(tmp, JSON.stringify(rec, null, 2));
    renameSync(tmp, this.ruta(rec.key)); // Atomic write.
  }
  log(key: string, ev: Evento) { appendFileSync(join(this.dir, `${key}.log.jsonl`), JSON.stringify(ev) + "\n"); }
  eventos(key: string): Evento[] {
    const f = join(this.dir, `${key}.log.jsonl`);
    return existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  }
  todos(): Rec[] {
    return readdirSync(this.dir).filter((f) => f.endsWith(".json")).sort().map((f) => this.get(f.slice(0, -5))!);
  }
}
