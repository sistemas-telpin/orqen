/**
 * orqen tutorial: step-by-step tour for newcomers, in the operating system's language (Spanish or English).
 *   orqen tutorial                  interactive in a terminal (Enter / menu)
 *   orqen tutorial --step <n|id>    print one step (what /orqen:tutorial uses), --json for the agent
 *   orqen tutorial --list           list the steps
 *   --lang es|en                    override the detected language (also ORQEN_LANG)
 * orqen lang: print the detected language (es | en), for agents.
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { ARCHIVO_CONFIG, leerConfig } from "../lib/config.ts";
import { providerEnv } from "../lib/provider-credentials.ts";
import { connectorSettings } from "../connectors/config.ts";
import { legacyConnectors } from "../connectors/legacy.ts";
import { ejemploClave, nombreHerramienta } from "../connectors/describe.ts";
import { detectarIdioma, normalizarIdioma, type Idioma } from "../lib/lang.ts";
import { ejecutarLinea } from "../lib/proc.ts";
import { pasosTutorial, TEMAS, textosUi, type DatosTutorial, type Paso } from "../tutorial/content.ts";
import { renderMarkdown, renderTerminal } from "../tutorial/render.ts";
import { pasosApp } from "../tutorial/app.ts";
import { interactivo, p, pc } from "../ui/console.ts";

/** Closest folder (this one or a parent) with orqen/config.yaml. */
export function buscarRepo(desde: string): string | undefined {
  let d = resolve(desde);
  for (;;) {
    if (existsSync(join(d, ARCHIVO_CONFIG))) return d;
    const padre = dirname(d);
    if (padre === d) return undefined;
    d = padre;
  }
}

export function datosDelRepo(repo: string, plataforma: NodeJS.Platform = process.platform): DatosTutorial {
  let cfg: ReturnType<typeof leerConfig> | undefined;
  try { cfg = leerConfig(repo); } catch { /* invalid config: generic examples */ }
  const env = providerEnv(repo);
  const real = (v?: string) => (v && !/your-company|tu-empresa/.test(v) ? v : undefined);
  const c = cfg?.conectores
    ? { external: connectorSettings(cfg.conectores.externo, env, cfg.general?.prefijos.requerimientos), internal: cfg.conectores.interno ? connectorSettings(cfg.conectores.interno, env, cfg.general?.prefijos.tickets) : undefined }
    : legacyConnectors(env);
  const externo = ejemploClave(c.external, 123);
  return {
    proyecto: cfg?.proyecto.nombre ?? repo.split(/[\\/]/).pop() ?? "",
    procesos: (cfg?.entornos.procesos ?? []).map((x) => ({ nombre: x.nombre, comando: x.comando, puerto: x.puerto, url: x.url, cuando: x.cuando })),
    tests: Object.entries(cfg?.entornos.tests ?? {}).filter(([, v]) => !!v).map(([k]) => k),
    externo,
    interno: c.internal ? ejemploClave(c.internal, 456) : externo,
    herramienta: nombreHerramienta(c.external.kind),
    herramientaInterna: c.internal ? nombreHerramienta(c.internal.kind) : undefined,
    soporte: (env.SUPPORT_STAGE ?? "").toLowerCase() === "on",
    gate: ["jira", "ticket"].includes((env.CODE_REVIEW_GATE ?? "").toLowerCase()) ? "ticket" : "github",
    ramaDevel: env.DEVEL_BRANCH || "desarrollo",
    windows: plataforma === "win32",
    db: existsSync(join(repo, "orqen", "tools", "db.mjs")),
    conectado: c.external.kind === "jira" ? !!(real(c.external.url) && real(c.external.token)) : c.external.kind === "github" ? !!c.external.repo : !!(c.external.project && c.external.token),
  };
}

export function buscarPaso(pasos: Paso[], valor: string): number {
  const n = Number(valor);
  if (Number.isInteger(n) && n >= 1 && n <= pasos.length) return n - 1;
  return pasos.findIndex((x) => x.id === valor.toLowerCase());
}

/** `orqen ...` in a demo runs this same CLI, even when it is not on the PATH (npx, a local build). */
function comandoDemo(linea: string): string {
  return linea.startsWith("orqen ") ? `"${process.execPath}" "${process.argv[1]}" ${linea.slice(6)}` : linea;
}

export async function tutorial(args: string[]) {
  const { values: v, positionals } = parseArgs({
    args, allowPositionals: true, strict: false,
    options: { step: { type: "string" }, list: { type: "boolean" }, json: { type: "boolean" }, lang: { type: "string" }, dir: { type: "string" } },
  });
  const idioma: Idioma = normalizarIdioma(v.lang as string | undefined) ?? detectarIdioma();
  const ui = textosUi(idioma);
  const repo = buscarRepo((v.dir as string | undefined) ?? process.cwd());
  if (!repo) {
    if (v.json) console.log(JSON.stringify({ lang: idioma, error: ui.sinOrqen }, null, 2));
    else console.error(ui.sinOrqen);
    process.exitCode = 1;
    return;
  }
  const datos = datosDelRepo(repo);
  const pasos = pasosTutorial(datos, idioma);
  const temas = pasos.map((x, i) => ({ n: i + 1, id: x.id, title: x.titulo }));

  if (v.list) {
    if (v.json) return console.log(JSON.stringify({ lang: idioma, topics: temas }, null, 2));
    for (const t of temas) console.log(`${String(t.n).padStart(2)}. ${t.id.padEnd(11)} ${t.title}`);
    return;
  }

  const pedido = (v.step as string | undefined) ?? positionals[0];
  let i = pedido ? buscarPaso(pasos, pedido) : 0;
  if (i < 0) {
    if (v.json) console.log(JSON.stringify({ lang: idioma, error: ui.temaInvalido(pedido!), topics: temas }, null, 2));
    else console.error(ui.temaInvalido(pedido!));
    process.exitCode = 1;
    return;
  }

  const enApp = pasosApp(datos, idioma);
  const appDe = (x: Paso) => enApp[x.id];

  // One step (what the /orqen:tutorial command uses), or a terminal without a keyboard.
  if (v.json || v.step || !interactivo()) {
    const paso = pasos[i];
    const enc = ui.paso(i + 1, pasos.length);
    if (!v.json) return console.log(renderTerminal(paso, enc));
    return console.log(JSON.stringify({
      lang: idioma, step: i + 1, total: pasos.length, id: paso.id, title: paso.titulo,
      next: pasos[i + 1]?.id ?? null, previous: pasos[i - 1]?.id ?? null,
      markdown: renderMarkdown(paso, enc), demo: paso.demo ?? [],
      // the same step done from the desktop app (the app shows both ways)
      app: appDe(paso) ? renderMarkdown({ ...paso, bloques: appDe(paso)!.bloques }, enc) : null,
      screen: appDe(paso)?.pantalla ?? null,
      // this project's data for the app illustrations (keys, tools, processes)
      sample: { external: datos.externo, internal: datos.herramientaInterna ? datos.interno : null, tool: datos.herramienta, processes: datos.procesos.map((x) => x.nombre) },
      labels: { next: ui.siguiente, previous: ui.anterior, try: ui.probar, menu: ui.menu, exit: ui.salir, question: ui.queHacer, pickTopic: ui.elegirTema, finished: ui.fin },
      topics: temas,
    }, null, 2));
  }

  // Interactive tour in the terminal.
  let mostrar = true;
  for (;;) {
    const paso = pasos[i];
    if (mostrar) console.log(renderTerminal(paso, ui.paso(i + 1, pasos.length)));
    mostrar = true;
    const opciones = [
      ...(i < pasos.length - 1 ? [{ value: "next", label: ui.siguiente }] : []),
      ...(paso.demo?.length ? [{ value: "try", label: ui.probar, hint: paso.demo.join(" · ") }] : []),
      ...(i > 0 ? [{ value: "prev", label: ui.anterior }] : []),
      { value: "menu", label: ui.menu },
      { value: "exit", label: ui.salir },
    ];
    const r = await p.select({ message: ui.queHacer, options: opciones as any });
    if (p.isCancel(r) || r === "exit") break;
    if (r === "next") i++;
    else if (r === "prev") i--;
    else if (r === "try") {
      for (const c of paso.demo ?? []) { console.log(`\n${pc.cyan("$ " + c)}`); await ejecutarLinea(comandoDemo(c), { cwd: repo }); }
      console.log("");
      mostrar = false;   // keep the output on screen; ask again without repeating the step
    } else if (r === "menu") {
      const t = await p.select({ message: ui.elegirTema, options: temas.map((x) => ({ value: x.n - 1, label: `${x.n}. ${x.title}` })), initialValue: i });
      if (!p.isCancel(t)) i = t as number;
    }
  }
  p.outro(ui.fin);
}

export function lang(args: string[]) {
  const { values: v } = parseArgs({ args, strict: false, options: { json: { type: "boolean" } } });
  const i = detectarIdioma();
  console.log(v.json ? JSON.stringify({ lang: i, name: i === "es" ? "Spanish" : "English" }) : i);
}
