/**
 * Comandos del proceso REC (antes `rec/`). El FLUJO lo decide orqen; el agente solo produce contenido.
 *
 *   pending [--json]               Avanza gates y lista los REC con trabajo: para analista (NUEVO/ANALISIS) y para agente
 *   analyze <KEY> [--analyst N]    Abre el análisis con un analista (grilling): imprime instrucciones + contexto + esquema
 *   lane <KEY> <directo|liviano|completo>   Registra el carril; liviano/completo crean la rama y el change de OpenSpec
 *   take <KEY> [--agent N]         (etapas de agente) Reserva el REC, prepara rama, LEVANTA EL ENTORNO y corre tests;
 *                                  imprime instrucciones + contexto  (acepta también la key del SIS: SIS-442)
 *   complete <KEY> <salida.json|-> [--agent N]   Valida la salida de la etapa y avanza el proceso (baja el entorno)
 *   schema <ETAPA>                 JSON Schema de la salida de una etapa
 *   block <KEY> <motivo>           Escala a un humano
 *   release <KEY>                  Quita la reserva de un REC
 *   search <JQL>                   Busca issues (antecedentes / relacionados)
 *   status [KEY]                   Estado actual y bitácora
 *   cycle [--loop]                 Modo desatendido: lanza AGENTE_CMD para cada REC pendiente
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ejecutar, partirComando } from "../lib/proc.ts";
import { cargarConfig } from "../proceso/config.ts";
import { esquemaJson } from "../proceso/esquemas.ts";
import { CARRILES, ESTADOS_AGENTE, type EstadoAgente } from "../proceso/estados.ts";
import { JiraClient } from "../proceso/jira.ts";
import { OpenSpecCli } from "../proceso/openspec.ts";
import { Proceso } from "../proceso/proceso.ts";
import { Store } from "../proceso/store.ts";
import { GitWorkspace } from "../proceso/workspace.ts";

export const COMANDOS_PROCESO = ["pending", "analyze", "lane", "take", "complete", "schema", "block", "release", "search", "status", "cycle"];

export const AYUDA_PROCESO = `Proceso REC:
  pending [--json]                         REC con trabajo: para analista y para agente
  analyze <KEY> [--analyst N]              Abre el análisis con un analista (grilling)
  lane <KEY> <directo|liviano|completo>    Registra el carril; liviano/completo crean rama + change de OpenSpec
  take <KEY> [--agent N]                   Reserva la etapa, prepara rama, levanta el entorno y corre los tests
  complete <KEY> <salida.json|->           Valida la salida y avanza el proceso (baja el entorno)
  status [KEY] · schema <ETAPA> · block <KEY> <motivo> · release <KEY> · search <JQL>
  cycle [--loop]                           Desatendido: lanza el agente por cada REC pendiente`;

export async function proceso(cmd: string, resto: string[]) {
  try { await procesoSinManejo(cmd, resto); }
  catch (e) {
    const m = (e as Error).message;
    if (/fetch failed|ENOTFOUND|ECONNREFUSED|401|403/.test(m)) {
      const url = process.env.JIRA_URL || "(vacía)";
      throw new Error(`No pude conectar con Jira (JIRA_URL=${url}): ${m}. Revisá orqen/.env o corré \`orqen init\` para cargar los datos.`);
    }
    throw e;
  }
}

async function procesoSinManejo(cmd: string, resto: string[]) {
  const cfg = cargarConfig();
  const store = new Store(cfg.estadoDir);
  const jira = new JiraClient(cfg);
  const proceso = new Proceso(cfg, jira, store, new GitWorkspace(cfg), new OpenSpecCli(cfg.openspecCmd, cfg.repoPath));

  const flag = (n: string) => { const i = resto.indexOf(`--${n}`); return i >= 0 ? (resto.splice(i, 2)[1] ?? "") : undefined; };
  const tiene = (n: string) => { const i = resto.indexOf(`--${n}`); if (i >= 0) resto.splice(i, 1); return i >= 0; };
  const agente = flag("agent") ?? process.env.REC_AGENTE ?? "agente";
  const analista = flag("analyst") ?? process.env.REC_ANALISTA ?? "";

  /** Acepta la key del REC o la de su SIS (el SIS vigente del REC) y devuelve siempre la del REC. */
  function aRec(key?: string): string {
    if (!key || /^REC-\d+$/i.test(key)) return key as string;
    const rec = store.todos().find((r) => r.sis?.toUpperCase() === key.toUpperCase());
    if (!rec) throw new Error(`${key} no es un REC ni el SIS vigente de ningún REC conocido (si es de una ronda anterior, usá la key del REC).`);
    return rec.key;
  }

  /** Guía para escribir la spec según el carril (etapas/especificacion.md; las líneas con prefijo [liviano] / [completo] se filtran). */
  function guiaSpec(carril: string, key: string, cambio: string) {
    const prefijo = /^(\s*)\[(liviano|completo)\]\s*/;
    return readFileSync(join(cfg.etapasDir, "especificacion.md"), "utf8")
      .split("\n")
      .filter((l) => { const m = l.match(prefijo); return !m || m[2] === carril; })
      .map((l) => l.replace(prefijo, "$1"))
      .join("\n")
      .replaceAll("[liviano|completo]", carril).replaceAll("<cambio>", cambio).replaceAll("<KEY>", key);
  }

  function guia(estado: EstadoAgente) {
    return readFileSync(join(cfg.etapasDir, `${estado.toLowerCase()}.md`), "utf8");
  }

  function renderTomar(key: string, ctx: Record<string, any>) {
    const e = ctx.estado as EstadoAgente;
    const carril = e === "ANALISIS"
      ? ["", "## Carril (cuando el analista dé el OK)", `Con el carril confirmado: \`orqen lane ${key} <${CARRILES.join("|")}> --agent ${agente}\`.`,
         "Liviano/completo: te crea la rama y el change de OpenSpec e imprime cómo escribir la spec. Directo: no hace falta spec."]
      : [];
    return [
      `# REC ${key} — etapa ${e}`,
      "",
      guia(e),
      "",
      "## Contexto",
      "```json", JSON.stringify(ctx, null, 2), "```",
      "",
      "## Salida esperada (JSON Schema)",
      "```json", JSON.stringify(esquemaJson(e), null, 2), "```",
      "",
      ...carril,
      "",
      "## Para terminar",
      `Escribí la salida en un archivo (ej. \`/tmp/${key}-${e.toLowerCase()}.json\`) y corré:`,
      "```sh", `orqen complete ${key} /tmp/${key}-${e.toLowerCase()}.json --agent ${agente}`, "```",
      "Si la salida no es válida, el comando lista los errores: corregí y volvé a correrlo.",
      `Si no podés avanzar: \`orqen block ${key} "motivo"\`.`,
    ].join("\n");
  }

  async function ciclo() {
    const pend = (await proceso.revisar()).filter((p) => p.para === "agente" && !p.tomadoPor);
    for (const p of pend) {
      const prompt = `Procesá el REC ${p.key} siguiendo la sección "Proceso REC" de AGENTS.md. ` +
        `Empezá corriendo: orqen take ${p.key} --agent ciclo`;
      const [bin, ...args] = partirComando(cfg.agenteCmd);
      const porArg = args.some((x) => x.includes("{prompt}"));
      console.log(`→ ${p.key} (${p.estado}): ${cfg.agenteCmd}`);
      const r = ejecutar(bin, porArg ? args.map((x) => x.replace("{prompt}", prompt)) : args, {
        cwd: cfg.repoPath, heredar: true, entrada: porArg ? undefined : prompt, env: { ...process.env, REC_AGENTE: "ciclo" },
      });
      const codigo = r.codigo;
      const rec = store.get(p.key);
      if (rec?.estado === p.estado && rec.lock?.agente === "ciclo") {
        await proceso.bloquear(p.key, `El agente terminó (código ${codigo}) sin completar la etapa ${p.estado}.`, "ciclo");
      }
    }
  }

  switch (cmd) {
    case "pending": {
      const p = await proceso.revisar();
      if (tiene("json")) return console.log(JSON.stringify(p, null, 2));
      if (!p.length) return console.log("No hay REC con trabajo pendiente.");
      for (const para of ["analista", "agente"] as const) {
        const xs = p.filter((x) => x.para === para);
        if (!xs.length) continue;
        console.log(para === "analista" ? "Para analizar (/orqen:analyze <KEY>):" : "Para un agente (orqen take <KEY>):");
        for (const x of xs) console.log(`  ${x.key.padEnd(12)} ${x.estado.padEnd(15)} ${x.tomadoPor ? `(tomado por ${x.tomadoPor})` : ""}`);
      }
      return;
    }
    case "analyze": {
      const key = resto[0];
      if (!key) { console.error("Uso: orqen analyze <KEY> [--analyst NOMBRE]"); process.exitCode = 1; return; }
      try {
        const { contexto } = await proceso.analizar(key, agente, analista || agente);
        console.log(renderTomar(key, contexto));
      } catch (e) {
        console.error(`✘ ${(e as Error).message}`);
        process.exitCode = 1;
      }
      return;
    }
    case "lane": {
      const [key, c] = resto;
      try {
        const r = await proceso.carril(key, c, agente);
        console.log(`✔ ${key}: carril ${r.carril}`);
        if (r.openspec) {
          console.log(`rama: ${r.rama}\nchange de OpenSpec: ${r.openspec.cambio} (${r.openspec.dir})\n`);
          console.log(guiaSpec(r.carril, key, r.openspec.cambio));
        } else console.log("Sin spec: el plan y los criterios van en la salida del análisis.");
      } catch (e) {
        console.error(`✘ ${(e as Error).message}`);
        process.exitCode = 1;
      }
      return;
    }
    case "take": {
      try {
        const key = aRec(resto[0]);
        const { contexto } = await proceso.tomar(key, agente);
        console.log(renderTomar(key, contexto));
      } catch (e) {
        console.error(`✘ ${(e as Error).message}`);
        process.exitCode = 1;
      }
      return;
    }
    case "complete": {
      const [clave, archivo] = resto;
      let key: string;
      try { key = aRec(clave); } catch (e) { console.error(`✘ ${(e as Error).message}`); process.exitCode = 1; return; }
      const texto = !archivo || archivo === "-" ? readFileSync(0, "utf8") : readFileSync(archivo, "utf8");
      let datos: unknown;
      try { datos = JSON.parse(texto); } catch (e) { console.error(`✘ JSON inválido: ${(e as Error).message}`); process.exitCode = 1; return; }
      const r = await proceso.completar(key, datos, agente);
      if (r.ok) console.log(`✔ ${key} → ${r.siguiente}`);
      else { console.error(`✘ La salida no se aceptó:\n- ${r.errores.join("\n- ")}`); process.exitCode = 1; }
      return;
    }
    case "schema": {
      const e = resto[0]?.toUpperCase() as EstadoAgente;
      if (!ESTADOS_AGENTE.includes(e)) throw new Error(`Etapa inválida. Opciones: ${ESTADOS_AGENTE.join(", ")}`);
      return console.log(JSON.stringify(esquemaJson(e), null, 2));
    }
    case "block": await proceso.bloquear(aRec(resto[0]), resto.slice(1).join(" "), agente); return console.log("✔ bloqueado");
    case "release": proceso.liberar(aRec(resto[0])); return console.log("✔ liberado");
    case "search": {
      const keys = (await jira.buscarKeys(resto.join(" "))).slice(0, 20);
      const out = await Promise.all(keys.map(async (k: string) => {
        const i = await jira.issue(k);
        return { key: k, titulo: i.titulo, estado: i.estadoJira, descripcion: i.descripcion.slice(0, 500) };
      }));
      return console.log(JSON.stringify(out, null, 2));
    }
    case "status": {
      if (resto[0]) {
        const key = aRec(resto[0]);
        const rec = store.get(key);
        console.log(rec ? JSON.stringify({ ...rec, artefactos: Object.keys(rec.artefactos) }, null, 2) : "desconocido");
        for (const ev of store.eventos(key)) console.log(`  ${ev.ts}  ${ev.desde} → ${ev.hacia}  ${ev.detalle}`);
      } else for (const r of store.todos()) console.log(`${r.key.padEnd(12)} ${r.estado.padEnd(15)} ${(r.sis ?? "").padEnd(12)} ${r.cambio ?? ""}`);
      return;
    }
    case "cycle":
      if (!tiene("loop")) return ciclo();
      for (;;) { await ciclo(); await new Promise((r) => setTimeout(r, cfg.intervaloSeg * 1000)); }
    default:
      console.log(AYUDA_PROCESO);
  }
}
