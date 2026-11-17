/** Estado de cada REC en archivos JSON (orqen/state/, ignorado por git → sobrevive a los checkouts de rama). */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Carril, Estado, Via } from "./estados.ts";

export interface Rec {
  key: string;
  estado: Estado;
  ronda: number;                 // 1 + cantidad de veces que el cliente rechazó la conformidad
  intentosTesting: number;
  rondasPreguntas: number;
  ultimoComentarioVisto: string;
  rama: string;
  cambio: string;                // id del change de OpenSpec
  via?: Via;                     // lo fija el análisis; la escalada operativa → desarrollo lo cambia
  carril?: Carril;               // directo | liviano | completo (solo vía desarrollo); lo fija el analista en el análisis
  analista?: string;             // quién condujo el análisis
  sis?: string;                  // key del SIS creado al cerrar el análisis
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
    renameSync(tmp, this.ruta(rec.key)); // escritura atómica
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
