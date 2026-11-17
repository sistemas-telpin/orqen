/** Customer request commands. orqen controls transitions and agents provide stage outputs. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ejecutar, partirComando } from "../lib/proc.ts";
import { STAGE_GUIDES, stageGuideFile } from "../lib/stage-guides.ts";
import { cargarConfig } from "../workflow/config.ts";
import { esquemaJson } from "../workflow/schemas.ts";
import { CARRILES, ESTADOS_AGENTE, type EstadoAgente } from "../workflow/states.ts";
import { JiraClient } from "../workflow/jira.ts";
import { OpenSpecCli } from "../workflow/openspec.ts";
import { Proceso } from "../workflow/workflow.ts";
import { Store } from "../workflow/store.ts";
import { GitWorkspace } from "../workflow/workspace.ts";

export const COMANDOS_PROCESO = ["pending", "analyze", "lane", "take", "complete", "schema", "block", "release", "search", "status", "cycle"];

export const AYUDA_PROCESO = `Customer request workflow:
  pending [--json]                         List pending analyst and agent work
  analyze <KEY> [--analyst N]              Start analysis with a human analyst
  lane <KEY> <directo|liviano|completo>    Record the lane and prepare an OpenSpec change when needed
  take <KEY> [--agent N]                   Claim the stage, prepare the branch and environment, and run tests
  complete <KEY> <output.json|->           Validate stage output and advance the workflow
  status [KEY] · schema <STAGE> · block <KEY> <reason> · release <KEY> · search <JQL>
  cycle [--loop]                           Dispatch eligible requests to the configured agent`;

export async function proceso(cmd: string, resto: string[]) {
  try { await procesoSinManejo(cmd, resto); }
  catch (e) {
    const m = (e as Error).message;
    if (/fetch failed|ENOTFOUND|ECONNREFUSED|401|403/.test(m)) {
      const url = process.env.JIRA_URL || "(empty)";
      throw new Error(`Cannot connect to Jira (JIRA_URL=${url}): ${m}. Check orqen/.env or run \`orqen init\` to configure Jira.`);
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

  /** Resolve a REC or its current SIS to the REC key. */
  function aRec(key?: string): string {
    if (!key || /^REC-\d+$/i.test(key)) return key as string;
    const rec = store.todos().find((r) => r.sis?.toUpperCase() === key.toUpperCase());
    if (!rec) throw new Error(`${key} is neither a known REC nor a current SIS. For an earlier round, use the REC key.`);
    return rec.key;
  }

  /** Load the specification guide and retain instructions for the chosen lane. */
  function guiaSpec(carril: string, key: string, cambio: string) {
    const prefijo = /^(\s*)\[(liviano|completo)\]\s*/;
    return readFileSync(join(cfg.etapasDir, stageGuideFile(cfg.etapasDir, "specification.md")), "utf8")
      .split("\n")
      .filter((l) => { const m = l.match(prefijo); return !m || m[2] === carril; })
      .map((l) => l.replace(prefijo, "$1"))
      .join("\n")
      .replaceAll("[liviano|completo]", carril).replaceAll("<change>", cambio).replaceAll("<cambio>", cambio).replaceAll("<KEY>", key);
  }

  function guia(estado: EstadoAgente) {
    return readFileSync(join(cfg.etapasDir, stageGuideFile(cfg.etapasDir, STAGE_GUIDES[estado])), "utf8");
  }

  function renderTomar(key: string, ctx: Record<string, any>) {
    const e = ctx.estado as EstadoAgente;
    const carril = e === "ANALISIS"
      ? ["", "## Choose a lane after analyst approval", `Once the analyst confirms: \`orqen lane ${key} <${CARRILES.join("|")}> --agent ${agente}\`.`,
         "For liviano or completo, the command prepares the branch and OpenSpec change and prints the spec guide. Direct requests use the analysis plan."]
      : [];
    return [
      `# REC ${key} — stage ${e}`,
      "",
      guia(e),
      "",
      "## Context",
      "```json", JSON.stringify(ctx, null, 2), "```",
      "",
      "## Expected output (JSON Schema)",
      "```json", JSON.stringify(esquemaJson(e), null, 2), "```",
      "",
      ...carril,
      "",
      "## Complete the stage",
      `Write the output to a file (e.g. \`/tmp/${key}-${e.toLowerCase()}.json\`) and run:`,
      "```sh", `orqen complete ${key} /tmp/${key}-${e.toLowerCase()}.json --agent ${agente}`, "```",
      "If validation fails, fix the reported errors and retry.",
      `If you cannot proceed: \`orqen block ${key} "<reason>"\`.`,
    ].join("\n");
  }

  async function ciclo() {
    const pend = (await proceso.revisar()).filter((p) => p.para === "agente" && !p.tomadoPor);
    for (const p of pend) {
      const prompt = `Process customer request ${p.key} following the customer request workflow in AGENTS.md. ` +
        `Start by running: orqen take ${p.key} --agent ciclo`;
      const [bin, ...args] = partirComando(cfg.agenteCmd);
      const porArg = args.some((x) => x.includes("{prompt}"));
      console.log(`→ ${p.key} (${p.estado}): ${cfg.agenteCmd}`);
      const r = ejecutar(bin, porArg ? args.map((x) => x.replace("{prompt}", prompt)) : args, {
        cwd: cfg.repoPath, heredar: true, entrada: porArg ? undefined : prompt, env: { ...process.env, REC_AGENTE: "ciclo" },
      });
      const codigo = r.codigo;
      const rec = store.get(p.key);
      if (rec?.estado === p.estado && rec.lock?.agente === "ciclo") {
        await proceso.bloquear(p.key, `The agent exited (code ${codigo}) without completing stage ${p.estado}.`, "ciclo");
      }
    }
  }

  switch (cmd) {
    case "pending": {
      const p = await proceso.revisar();
      if (tiene("json")) return console.log(JSON.stringify(p, null, 2));
      if (!p.length) return console.log("No customer requests have pending work.");
      for (const para of ["analista", "agente"] as const) {
        const xs = p.filter((x) => x.para === para);
        if (!xs.length) continue;
        console.log(para === "analista" ? "For analysts (/orqen:analyze <KEY>):" : "For agents (orqen take <KEY>):");
        for (const x of xs) console.log(`  ${x.key.padEnd(12)} ${x.estado.padEnd(15)} ${x.tomadoPor ? `(claimed by ${x.tomadoPor})` : ""}`);
      }
      return;
    }
    case "analyze": {
      const key = resto[0];
      if (!key) { console.error("Usage: orqen analyze <KEY> [--analyst NAME]"); process.exitCode = 1; return; }
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
        console.log(`✔ ${key}: lane ${r.carril}`);
        if (r.openspec) {
          console.log(`branch: ${r.rama}\nOpenSpec change: ${r.openspec.cambio} (${r.openspec.dir})\n`);
          console.log(guiaSpec(r.carril, key, r.openspec.cambio));
        } else console.log("Include the plan and acceptance criteria in the analysis output.");
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
      try { datos = JSON.parse(texto); } catch (e) { console.error(`✘ Invalid JSON: ${(e as Error).message}`); process.exitCode = 1; return; }
      const r = await proceso.completar(key, datos, agente);
      if (r.ok) console.log(`✔ ${key} → ${r.siguiente}`);
      else { console.error(`✘ Stage output was rejected:\n- ${r.errores.join("\n- ")}`); process.exitCode = 1; }
      return;
    }
    case "schema": {
      const e = resto[0]?.toUpperCase() as EstadoAgente;
      if (!ESTADOS_AGENTE.includes(e)) throw new Error(`Invalid stage. Options: ${ESTADOS_AGENTE.join(", ")}`);
      return console.log(JSON.stringify(esquemaJson(e), null, 2));
    }
    case "block": await proceso.bloquear(aRec(resto[0]), resto.slice(1).join(" "), agente); return console.log("✔ Blocked");
    case "release": proceso.liberar(aRec(resto[0])); return console.log("✔ Released");
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
        console.log(rec ? JSON.stringify({ ...rec, artefactos: Object.keys(rec.artefactos) }, null, 2) : "unknown");
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
