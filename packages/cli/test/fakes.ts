import type { Comentario, Issue, JiraApi } from "../src/workflow/jira.ts";
import { BOT_MARCA } from "../src/workflow/jira.ts";

let id = 0;

export class FakeJira implements JiraApi {
  coms: Record<string, Comentario[]> = {};
  labels: Record<string, string> = {};
  constructor(public issues: Record<string, Partial<Issue>>) {
    for (const k of Object.keys(issues)) this.coms[k] = [];
  }
  async buscarKeys() { return Object.keys(this.issues); }
  async issue(key: string): Promise<Issue> {
    return { key, titulo: "", descripcion: "", labels: [], componentes: [], adjuntos: [], ...this.issues[key] };
  }
  async comentarios(key: string) { return [...this.coms[key]]; }
  async comentar(key: string, texto: string) { this.add(key, "bot", `${BOT_MARCA} ${texto}`); }
  humano(key: string, autor: string, texto: string) { this.add(key, autor, texto); }
  async setLabelEstado(key: string, e: string) { this.labels[key] = e; }
  async transicionar(key: string, n: string) { (this.transiciones[key] ??= []).push(n); return true; }
  transiciones: Record<string, string[]> = {};
  creados: Array<{ key: string; proyecto: string; tipo: string; titulo: string; descripcion: string }> = [];
  links: Array<[string, string, string]> = [];
  async crearIssue(i: { proyecto: string; tipo: string; titulo: string; descripcion: string }) {
    const key = `${i.proyecto}-${this.creados.length + 1}`;
    this.creados.push({ key, ...i }); this.coms[key] = []; this.issues[key] = { titulo: i.titulo };
    return key;
  }
  async vincular(a: string, b: string, t: string) { this.links.push([a, b, t]); }
  ultimo(key: string) { return this.coms[key].at(-1)!.cuerpo; }
  private add(key: string, autor: string, cuerpo: string) {
    this.coms[key].push({ id: String(++id), autor, autorNombre: autor, cuerpo, creado: "" });
  }
}
