/**
 * CLI del proceso REC.  Uso:  ./cli/bin/orqen <comando>
 *
 *   pendientes [--json]            Avanza gates y lista los REC con trabajo: para analista (NUEVO/ANALISIS) y para agente
 *   analizar <KEY> [--analista N]  Abre el análisis con un analista (grilling): imprime instrucciones + contexto + esquema
 *   carril <KEY> <directo|liviano|completo>   Registra el carril; liviano/completo crean la rama y el change de OpenSpec
 *   tomar <KEY> [--agente N]       (etapas de agente) Reserva el REC, prepara rama/tests e imprime instrucciones + contexto
 *                                  (tomar/completar/estado/bloquear/liberar aceptan también la key del SIS: SIS-442)
 *   completar <KEY> <salida.json|-> [--agente N]   Valida la salida de la etapa y avanza el proceso
 *   esquema <ETAPA>                JSON Schema de la salida de una etapa
 *   bloquear <KEY> <motivo>        Escala a un humano
 *   liberar <KEY>                  Quita la reserva de un REC
 *   buscar <JQL>                   Busca issues (antecedentes / relacionados)
 *   estado [KEY]                   Estado actual y bitácora
 *   ciclo [--loop]                 Modo desatendido: lanza AGENTE_CMD para cada REC pendiente
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REC_DIR, cargarConfig } from "./config.ts";
import { esquemaJson } from "./esquemas.ts";
import { CARRILES, ESTADOS_AGENTE, type EstadoAgente } from "./estados.ts";
import { JiraClient } from "./jira.ts";
import { OpenSpecCli } from "./openspec.ts";
import { Proceso } from "./proceso.ts";
import { Store } from "./store.ts";
import { GitWorkspace } from "./workspace.ts";

const cfg = cargarConfig();
const store = new Store(cfg.estadoDir);
const jira = new JiraClient(cfg);
const proceso = new Proceso(cfg, jira, store, new GitWorkspace(cfg), new OpenSpecCli(cfg.openspecCmd, cfg.repoPath));

const [cmd, ...resto] = process.argv.slice(2);
const flag = (n: string) => { const i = resto.indexOf(`--${n}`); return i >= 0 ? (resto.splice(i, 2)[1] ?? "") : undefined; };
const tiene = (n: string) => { const i = resto.indexOf(`--${n}`); if (i >= 0) resto.splice(i, 1); return i >= 0; };
const agente = flag("agente") ?? process.env.REC_AGENTE ?? "agente";
const analista = flag("analista") ?? process.env.REC_ANALISTA ?? "";

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
  return readFileSync(join(REC_DIR, "etapas", "especificacion.md"), "utf8")
    .split("\n")
    .filter((l) => { const m = l.match(prefijo); return !m || m[2] === carril; })
    .map((l) => l.replace(prefijo, "$1"))
    .join("\n")
    .replaceAll("[liviano|completo]", carril).replaceAll("<cambio>", cambio).replaceAll("<KEY>", key);
}

function guia(estado: EstadoAgente) {
  return readFileSync(join(REC_DIR, "etapas", `${estado.toLowerCase()}.md`), "utf8");
}

function renderTomar(key: string, ctx: Record<string, any>) {
  const e = ctx.estado as EstadoAgente;
  const carril = e === "ANALISIS"
    ? ["", "## Carril (cuando el analista dé el OK)", `Con el carril confirmado: \`./cli/bin/orqen carril ${key} <${CARRILES.join("|")}> --agente ${agente}\`.`,
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
    "```sh", `./cli/bin/orqen completar ${key} /tmp/${key}-${e.toLowerCase()}.json --agente ${agente}`, "```",
    "Si la salida no es válida, el comando lista los errores: corregí y volvé a correrlo.",
    `Si no podés avanzar: \`./cli/bin/orqen bloquear ${key} "motivo"\`.`,
  ].join("\n");
}

async function ciclo() {
  const pend = (await proceso.revisar()).filter((p) => p.para === "agente" && !p.tomadoPor);
  for (const p of pend) {
    const prompt = `Procesá el REC ${p.key} siguiendo la sección "Proceso REC" de AGENTS.md. ` +
      `Empezá corriendo: ./cli/bin/orqen tomar ${p.key} --agente ciclo`;
    const comando = cfg.agenteCmd.replace("{prompt}", `'${prompt.replace(/'/g, `'\\''`)}'`);
    console.log(`→ ${p.key} (${p.estado}): ${comando}`);
    const r = spawnSync(comando, { shell: true, cwd: cfg.repoPath, stdio: "inherit", env: { ...process.env, REC_AGENTE: "ciclo" } });
    const rec = store.get(p.key);
    if (rec?.estado === p.estado && rec.lock?.agente === "ciclo") {
      await proceso.bloquear(p.key, `El agente terminó (código ${r.status}) sin completar la etapa ${p.estado}.`, "ciclo");
    }
  }
}

async function main() {
  switch (cmd) {
    case "pendientes": {
      const p = await proceso.revisar();
      if (tiene("json")) return console.log(JSON.stringify(p, null, 2));
      if (!p.length) return console.log("No hay REC con trabajo pendiente.");
      for (const para of ["analista", "agente"] as const) {
        const xs = p.filter((x) => x.para === para);
        if (!xs.length) continue;
        console.log(para === "analista" ? "Para analizar (/orqen:analyze <KEY>):" : "Para un agente (orqen tomar <KEY>):");
        for (const x of xs) console.log(`  ${x.key.padEnd(12)} ${x.estado.padEnd(15)} ${x.tomadoPor ? `(tomado por ${x.tomadoPor})` : ""}`);
      }
      return;
    }
    case "analizar": {
      const key = resto[0];
      if (!key) { console.error("Uso: orqen analizar <KEY> [--analista NOMBRE]"); process.exitCode = 1; return; }
      try {
        const { contexto } = await proceso.analizar(key, agente, analista || agente);
        console.log(renderTomar(key, contexto));
      } catch (e) {
        console.error(`✘ ${(e as Error).message}`);
        process.exitCode = 1;
      }
      return;
    }
    case "carril": {
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
    case "tomar": {
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
    case "completar": {
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
    case "esquema": {
      const e = resto[0]?.toUpperCase() as EstadoAgente;
      if (!ESTADOS_AGENTE.includes(e)) throw new Error(`Etapa inválida. Opciones: ${ESTADOS_AGENTE.join(", ")}`);
      return console.log(JSON.stringify(esquemaJson(e), null, 2));
    }
    case "bloquear": await proceso.bloquear(aRec(resto[0]), resto.slice(1).join(" "), agente); return console.log("✔ bloqueado");
    case "liberar": proceso.liberar(aRec(resto[0])); return console.log("✔ liberado");
    case "buscar": {
      const keys = (await jira.buscarKeys(resto.join(" "))).slice(0, 20);
      const out = await Promise.all(keys.map(async (k: string) => {
        const i = await jira.issue(k);
        return { key: k, titulo: i.titulo, estado: i.estadoJira, descripcion: i.descripcion.slice(0, 500) };
      }));
      return console.log(JSON.stringify(out, null, 2));
    }
    case "estado": {
      if (resto[0]) {
        const key = aRec(resto[0]);
        const rec = store.get(key);
        console.log(rec ? JSON.stringify({ ...rec, artefactos: Object.keys(rec.artefactos) }, null, 2) : "desconocido");
        for (const ev of store.eventos(key)) console.log(`  ${ev.ts}  ${ev.desde} → ${ev.hacia}  ${ev.detalle}`);
      } else for (const r of store.todos()) console.log(`${r.key.padEnd(12)} ${r.estado.padEnd(15)} ${(r.sis ?? "").padEnd(12)} ${r.cambio ?? ""}`);
      return;
    }
    case "ciclo":
      if (!tiene("loop")) return ciclo();
      for (;;) { await ciclo(); await new Promise((r) => setTimeout(r, cfg.intervaloSeg * 1000)); }
    default:
      console.log(readFileSync(new URL(import.meta.url), "utf8").split("*/")[0].replace(/^\/\*\*?|^ \* ?/gm, ""));
  }
}

main().catch((e) => { console.error(`✘ ${e.message}`); process.exit(1); });
