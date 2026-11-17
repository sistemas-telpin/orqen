/** Cliente mínimo de Jira. Lectura para el agente (vía `rec tomar`/`rec buscar`); escritura solo desde el proceso. */
import type { Config } from "./config.ts";

export const BOT_MARCA = "[rec-agente]";

export interface Comentario { id: string; autor: string; autorNombre: string; cuerpo: string; creado: string }
export interface Issue {
  key: string; titulo: string; descripcion: string; tipo?: string; prioridad?: string;
  reportadoPor?: string; estadoJira?: string; labels: string[]; componentes: string[]; adjuntos: string[];
}

export interface JiraApi {
  buscarKeys(jql: string): Promise<string[]>;
  issue(key: string): Promise<Issue>;
  comentarios(key: string): Promise<Comentario[]>;
  comentar(key: string, texto: string): Promise<void>;
  setLabelEstado(key: string, estado: string): Promise<void>;
  transicionar(key: string, nombre: string): Promise<boolean>;
  /** Crea un issue en otro proyecto (ej. el SIS de desarrollo) y devuelve su key. */
  crearIssue(i: { proyecto: string; tipo: string; titulo: string; descripcion: string; labels?: string[] }): Promise<string>;
  /** Vincula dos issues (ej. SIS "relates to" REC). */
  vincular(desde: string, hacia: string, tipoLink: string): Promise<void>;
}

export class JiraClient implements JiraApi {
  private base: string;
  private auth: string;
  constructor(private cfg: Config) {
    this.base = cfg.jiraUrl.replace(/\/$/, "");
    this.auth = cfg.jiraDeployment === "cloud"
      ? "Basic " + Buffer.from(`${cfg.jiraUser}:${cfg.jiraToken}`).toString("base64")
      : `Bearer ${cfg.jiraToken}`;
  }

  private async req(method: string, path: string, body?: unknown, params?: Record<string, string | number>) {
    const url = new URL(this.base + path);
    for (const [k, v] of Object.entries(params ?? {})) url.searchParams.set(k, String(v));
    const r = await fetch(url, {
      method,
      headers: { Authorization: this.auth, Accept: "application/json", "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`Jira ${method} ${path}: ${r.status} ${await r.text()}`);
    const t = await r.text();
    return t ? JSON.parse(t) : {};
  }

  async buscarKeys(jql: string) {
    const path = this.cfg.jiraDeployment === "cloud" ? "/rest/api/3/search/jql" : "/rest/api/2/search";
    const r = await this.req("GET", path, undefined, { jql, fields: "key", maxResults: 100 });
    return (r.issues ?? []).map((i: any) => i.key as string);
  }

  async issue(key: string): Promise<Issue> {
    const r = await this.req("GET", `/rest/api/2/issue/${key}`, undefined, {
      fields: "summary,description,issuetype,priority,reporter,labels,status,attachment,components",
    });
    const f = r.fields;
    return {
      key, titulo: f.summary, descripcion: f.description ?? "", tipo: f.issuetype?.name,
      prioridad: f.priority?.name, reportadoPor: f.reporter?.displayName, estadoJira: f.status?.name,
      labels: f.labels ?? [], componentes: (f.components ?? []).map((c: any) => c.name),
      adjuntos: (f.attachment ?? []).map((a: any) => a.filename),
    };
  }

  async comentarios(key: string): Promise<Comentario[]> {
    const r = await this.req("GET", `/rest/api/2/issue/${key}/comment`, undefined, { maxResults: 500, orderBy: "created" });
    return (r.comments ?? []).map((c: any) => ({
      id: String(c.id), autor: c.author?.accountId ?? c.author?.name ?? "",
      autorNombre: c.author?.displayName ?? "", cuerpo: c.body ?? "", creado: c.created ?? "",
    }));
  }

  async comentar(key: string, texto: string) {
    await this.req("POST", `/rest/api/2/issue/${key}/comment`, { body: `${BOT_MARCA} ${texto}` });
  }

  async setLabelEstado(key: string, estado: string) {
    const { labels } = await this.issue(key);
    const nuevas = labels.filter((l) => !l.startsWith("rec-estado-")).concat(`rec-estado-${estado.toLowerCase()}`);
    await this.req("PUT", `/rest/api/2/issue/${key}`, { fields: { labels: nuevas } });
  }

  async crearIssue(i: { proyecto: string; tipo: string; titulo: string; descripcion: string; labels?: string[] }) {
    const r = await this.req("POST", "/rest/api/2/issue", {
      fields: {
        project: { key: i.proyecto }, issuetype: { name: i.tipo },
        summary: i.titulo.slice(0, 250), description: i.descripcion, labels: i.labels ?? [],
      },
    });
    return r.key as string;
  }

  async vincular(desde: string, hacia: string, tipoLink: string) {
    await this.req("POST", "/rest/api/2/issueLink", {
      type: { name: tipoLink }, inwardIssue: { key: desde }, outwardIssue: { key: hacia },
    });
  }

  async transicionar(key: string, nombre: string) {
    const r = await this.req("GET", `/rest/api/2/issue/${key}/transitions`);
    const t = (r.transitions ?? []).find((t: any) => t.name.toLowerCase() === nombre.toLowerCase());
    if (!t) return false;
    await this.req("POST", `/rest/api/2/issue/${key}/transitions`, { transition: { id: t.id } });
    return true;
  }
}
