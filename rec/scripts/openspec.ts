/**
 * Integración con OpenSpec (>= 2.0). Cada REC (y cada ronda) es un "change" de OpenSpec:
 *   ESPECIFICACION → openspec new change + el agente escribe proposal/specs/design/tasks
 *   DESARROLLO     → el agente sigue `openspec instructions apply` y tilda tasks.md
 *   TESTING        → los Scenarios de los spec deltas son el checklist de cobertura
 *   ENTREGA        → openspec archive (los deltas se fusionan en openspec/specs)
 * Este módulo solo envuelve la CLI con --json y parsea lo que la CLI no expone (escenarios, horas).
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export interface Tarea { descripcion: string; hecha: boolean; horas?: number }
export interface Escenario { capacidad: string; requisito: string; escenario: string }

export interface OpenSpecApi {
  nuevoCambio(id: string, descripcion: string): string;           // devuelve el dir del change
  existe(id: string): boolean;
  dir(id: string): string;
  validar(id: string): { ok: boolean; problemas: string[] };
  planificacionCompleta(id: string): boolean;
  tareas(id: string): Tarea[];
  escenarios(id: string): Escenario[];
  archivar(id: string): { archivadoComo: string; totales: Record<string, number> };
}

export class OpenSpecCli implements OpenSpecApi {
  constructor(private cmd: string, private repoPath: string) {}

  private run(args: string[]): any {
    const win = process.platform === "win32";  // con shell (cmd) hay que entrecomillar los argumentos con espacios
    const a = win ? args.map((x) => (/[\s"]/.test(x) ? `"${x.replace(/"/g, '\\"')}"` : x)) : args;
    const p = spawnSync(this.cmd, a, { cwd: this.repoPath, encoding: "utf8", shell: win });
    if (p.error) throw new Error(`No pude ejecutar "${this.cmd}": ${p.error.message}. ¿Está instalado OpenSpec? (npm i -g @fission-ai/openspec)`);
    try {
      return { codigo: p.status, json: JSON.parse(p.stdout) };
    } catch {
      return { codigo: p.status, json: null, texto: (p.stdout + p.stderr).trim() };
    }
  }

  private ok(args: string[]) {
    const r = this.run(args);
    if (r.codigo !== 0 || !r.json) throw new Error(`openspec ${args.join(" ")} falló: ${r.texto ?? JSON.stringify(r.json)}`);
    return r.json;
  }

  dir(id: string) { return join(this.repoPath, "openspec", "changes", id); }
  existe(id: string) { return existsSync(this.dir(id)); }

  nuevoCambio(id: string, descripcion: string) {
    if (this.existe(id)) return this.dir(id);
    return this.ok(["new", "change", id, "--description", descripcion, "--json"]).change.path as string;
  }

  validar(id: string) {
    const r = this.run(["validate", id, "--type", "change", "--strict", "--json", "--no-interactive"]);
    const item = r.json?.items?.[0];
    if (!item) return { ok: false, problemas: [r.texto ?? "openspec validate no devolvió resultado"] };
    const problemas = (item.issues ?? []).map((i: any) => `${i.level ?? ""} ${i.path ?? ""}: ${i.message ?? JSON.stringify(i)}`.trim());
    return { ok: !!item.valid, problemas };
  }

  planificacionCompleta(id: string) {
    return !!this.ok(["status", "--change", id, "--json"]).isPlanningComplete;
  }

  tareas(id: string): Tarea[] {
    const j = this.ok(["instructions", "apply", "--change", id, "--json"]);
    return (j.tasks ?? []).map((t: any) => ({ descripcion: t.description, hecha: !!t.done, horas: horasDe(t.description) }));
  }

  escenarios(id: string) { return escenariosDeCambio(this.dir(id)); }

  archivar(id: string) {
    const j = this.ok(["archive", id, "--yes", "--json"]);
    return { archivadoComo: j.archive.archivedAs, totales: j.archive.totals };
  }
}

/** "Implementar endpoint (4h)" → 4 ; también "(1.5 h)" */
export function horasDe(desc: string): number | undefined {
  const m = desc.match(/\((\d+(?:[.,]\d+)?)\s*h\)\s*$/i);
  return m ? Number(m[1].replace(",", ".")) : undefined;
}

/** Recorre specs/**\/spec.md del change y lista cada Scenario con su Requirement. */
export function escenariosDeCambio(dirCambio: string): Escenario[] {
  const base = join(dirCambio, "specs");
  if (!existsSync(base)) return [];
  const out: Escenario[] = [];
  const recorrer = (d: string) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) recorrer(p);
      else if (f === "spec.md") {
        const capacidad = d.slice(base.length + 1).replaceAll("\\", "/");
        let seccion = "", requisito = "";
        for (const linea of readFileSync(p, "utf8").split("\n")) {
          const h2 = linea.match(/^##\s+(.+)/), req = linea.match(/^###\s+Requirement:\s*(.+)/), esc = linea.match(/^####\s+Scenario:\s*(.+)/);
          if (h2 && !linea.startsWith("###")) seccion = h2[1].trim().toUpperCase();
          else if (req) requisito = req[1].trim();
          else if (esc && !seccion.startsWith("REMOVED")) out.push({ capacidad, requisito, escenario: esc[1].trim() });
        }
      }
    }
  };
  recorrer(base);
  return out;
}
