/**
 * orqen update — trae los cambios posteriores:
 *  1. la propia CLI (orqen): si hay una versión nueva, la instala y pide volver a correr `orqen update`
 *     (para que el kit lo aplique la versión nueva);
 *  2. OpenSpec: si hay una versión compatible más nueva, la instala y corre `openspec update`;
 *  3. los archivos del kit (AGENTS.md, etapas, plugin, reglas de OpenSpec): reemplaza lo que nadie tocó y
 *     pregunta (con diff) por lo que el equipo editó.
 * No vuelve a explorar el stack ni regenera docker-compose.orqen.yml.
 */
import { resolve } from "node:path";
import semver from "semver";
import { VERSION_KIT } from "orqen-kit";
import { actualizarVersiones, leerConfig } from "../lib/config.ts";
import { aplicar, leerManifest, planificar } from "../lib/kit.ts";
import {
  actualizarArchivosOpenSpec, estadoOpenSpec, instalarOpenSpec, RANGO_OPENSPEC, ultimaVersionOpenSpec,
} from "../lib/openspec.ts";
import { ejecutar } from "../lib/proc.ts";
import { comandoActualizarCli, ultimaVersionCli, VERSION_CLI } from "../lib/sistema.ts";
import { resumenStack } from "../lib/stack.ts";
import { mostrarLogo } from "../ui/logo.ts";
import { azul, confirmar, gris, interactivo, magenta, p, pc } from "../ui/consola.ts";
import { resolverConflicto } from "./init.ts";

export interface OpcionesUpdate { dir?: string; yes?: boolean; sinCli?: boolean; sinOpenspec?: boolean; sinKit?: boolean; sinAnimacion?: boolean }

export async function update(o: OpcionesUpdate) {
  const repo = resolve(o.dir ?? process.cwd());
  let yes = !!o.yes;
  await mostrarLogo(!o.sinAnimacion && !o.yes);
  p.intro(`${azul("orqen")} ${magenta("update")} ${gris(`v${VERSION_CLI} · ${repo}`)}`);
  if (!yes && !interactivo()) { p.log.warn("La terminal no es interactiva: sigo con los valores por defecto (como --yes)."); yes = true; }

  let config;
  try { config = leerConfig(repo); }
  catch (e) { p.cancel((e as Error).message); process.exitCode = 1; return; }
  const s = p.spinner();

  // 1. CLI
  if (!o.sinCli) {
    s.start("Buscando versiones nuevas de orqen…");
    const ultima = ultimaVersionCli();
    if (!ultima) s.stop(gris("No pude consultar npm (¿sin conexión?). Sigo con la versión instalada."));
    else if (semver.gt(ultima, VERSION_CLI)) {
      s.stop(`Hay una versión nueva de orqen: ${pc.bold(VERSION_CLI)} → ${pc.green(ultima)}`);
      const [cmd, args] = comandoActualizarCli();
      if (await confirmar(`¿Actualizo la CLI? (${cmd} ${args.join(" ")})`, true, yes)) {
        s.start(`Instalando orqen@${ultima}…`);
        const r = ejecutar(cmd, args, { timeoutMs: 10 * 60_000 });
        if (r.codigo !== 0) { s.error(`Falló la actualización:\n${(r.stderr || r.stdout).trim().slice(-1500)}`); process.exitCode = 1; return; }
        s.stop(`orqen ${ultima} instalado`);
        p.outro(`Volvé a correr ${pc.cyan("orqen update")} para aplicar el kit nuevo con la versión ${ultima}.`);
        return;
      }
    } else s.stop(`orqen ${VERSION_CLI} es la última versión`);
  }

  // 2. OpenSpec
  if (!o.sinOpenspec) {
    s.start("Revisando OpenSpec…");
    const est = estadoOpenSpec(repo);
    const ultima = ultimaVersionOpenSpec(repo);
    const actual = est.version ? semver.coerce(est.version)?.version ?? est.version : null;
    if (!actual) s.stop(pc.yellow("OpenSpec no está instalado en este repo"));
    else s.stop(`OpenSpec ${actual}${ultima ? gris(` · última compatible (${RANGO_OPENSPEC}): ${ultima}`) : ""}`);
    const instalacion = est.instalacion ?? config.openspec.instalacion;
    if (ultima && (!actual || !est.compatible || semver.gt(ultima, actual))) {
      if (await confirmar(`¿Actualizo OpenSpec a ${ultima}${instalacion === "devDependency" ? " (devDependency del repo)" : " (global)"}?`, true, yes)) {
        s.start(`Instalando OpenSpec ${ultima}…`);
        try {
          instalarOpenSpec(repo, instalacion, ultima);
          s.stop(`OpenSpec ${ultima} instalado`);
          if (est.inicializado) {
            s.start("Corriendo openspec update (skills y comandos de las herramientas)…");
            actualizarArchivosOpenSpec(repo, instalacion);
            s.stop("Archivos de OpenSpec actualizados");
          }
          actualizarVersiones(repo, { openspec: ultima });
        } catch (e) { s.error((e as Error).message); }
      }
    }
  }

  // 3. Kit
  if (!o.sinKit) {
    const manifest = leerManifest(repo);
    const vars = {
      RESUMEN_STACK: resumenStack(config.stack), RAMA_BASE: config.proyecto.rama_base,
      AGENTE_CMD: config.agente.comando ?? "claude -p --permission-mode acceptEdits",
    };
    const plan = planificar(repo, vars);
    const cambios = plan.filter((c) => c.accion !== "igual");
    if (!cambios.length) p.log.success(`El kit está al día (v${VERSION_KIT})`);
    else {
      const icono: Record<string, string> = { crear: pc.green("+"), actualizar: pc.yellow("~"), conflicto: pc.red("!") };
      p.note(cambios.map((c) => `${icono[c.accion]} ${c.ruta}${c.accion === "conflicto" ? pc.red("  (lo editaste: te pregunto)") : ""}`).join("\n"),
        `Kit ${manifest.kit} → ${VERSION_KIT}`);
      if (await confirmar("¿Aplico los cambios del kit?", true, yes)) {
        const res = await aplicar(repo, plan, (c) => resolverConflicto(c, yes));
        actualizarVersiones(repo, { kit: VERSION_KIT, cli: VERSION_CLI });
        const n = (a: string) => res.filter((r) => r.accion === a).length;
        p.log.success(`Kit v${VERSION_KIT}: ${n("crear")} nuevos, ${n("actualizar")} actualizados, ${n("mantenido")} mantenidos, ${n("guardado-al-lado")} para fusionar a mano`);
        for (const r of res.filter((r) => r.accion === "guardado-al-lado")) p.log.warn(`${r.ruta} → revisá ${r.detalle}`);
      }
    }
  }
  actualizarVersiones(repo, { cli: VERSION_CLI });
  p.outro(`${magenta("//")} Listo. Revisá los cambios con ${pc.cyan("git diff")} y commitealos.`);
}
