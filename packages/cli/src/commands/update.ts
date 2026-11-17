/** Update the CLI, compatible OpenSpec installation, and managed kit files. */
import { resolve } from "node:path";
import semver from "semver";
import { VERSION_KIT } from "orqen-kit";
import { actualizarVersiones, leerConfig } from "../lib/config.ts";
import { aplicar, leerManifest, planificar } from "../lib/kit.ts";
import {
  actualizarArchivosOpenSpec, estadoOpenSpec, instalarOpenSpec, RANGO_OPENSPEC, ultimaVersionOpenSpec,
} from "../lib/openspec.ts";
import { ejecutar } from "../lib/proc.ts";
import { comandoActualizarCli, ultimaVersionCli, VERSION_CLI } from "../lib/system.ts";
import { resumenStack } from "../lib/stack.ts";
import { mostrarLogo } from "../ui/logo.ts";
import { azul, confirmar, gris, interactivo, magenta, p, pc } from "../ui/console.ts";
import { resolverConflicto } from "./init.ts";

export interface OpcionesUpdate { dir?: string; yes?: boolean; sinCli?: boolean; sinOpenspec?: boolean; sinKit?: boolean; sinAnimacion?: boolean }

export async function update(o: OpcionesUpdate) {
  const repo = resolve(o.dir ?? process.cwd());
  let yes = !!o.yes;
  await mostrarLogo(!o.sinAnimacion && !o.yes);
  p.intro(`${azul("orqen")} ${magenta("update")} ${gris(`v${VERSION_CLI} · ${repo}`)}`);
  if (!yes && !interactivo()) { p.log.warn("Non-interactive terminal. Using defaults as with --yes."); yes = true; }

  let config;
  try { config = leerConfig(repo); }
  catch (e) { p.cancel((e as Error).message); process.exitCode = 1; return; }
  const s = p.spinner();

  // 1. CLI
  if (!o.sinCli) {
    s.start("Checking for orqen updates…");
    const ultima = ultimaVersionCli();
    if (!ultima) s.stop(gris("Could not reach npm. Using the installed version."));
    else if (semver.gt(ultima, VERSION_CLI)) {
      s.stop(`orqen update available: ${pc.bold(VERSION_CLI)} → ${pc.green(ultima)}`);
      const [cmd, args] = comandoActualizarCli();
      if (await confirmar(`Update the CLI? (${cmd} ${args.join(" ")})`, true, yes)) {
        s.start(`Installing orqen@${ultima}…`);
        const r = ejecutar(cmd, args, { timeoutMs: 10 * 60_000 });
        if (r.codigo !== 0) { s.error(`Update failed:\n${(r.stderr || r.stdout).trim().slice(-1500)}`); process.exitCode = 1; return; }
        s.stop(`orqen ${ultima} installed`);
        p.outro(`Run ${pc.cyan("orqen update")} again to update the kit with version ${ultima}.`);
        return;
      }
    } else s.stop(`orqen ${VERSION_CLI} is up to date`);
  }

  // 2. OpenSpec
  if (!o.sinOpenspec) {
    s.start("Checking OpenSpec…");
    const est = estadoOpenSpec(repo);
    const ultima = ultimaVersionOpenSpec(repo);
    const actual = est.version ? semver.coerce(est.version)?.version ?? est.version : null;
    if (!actual) s.stop(pc.yellow("OpenSpec is not installed in this repository"));
    else s.stop(`OpenSpec ${actual}${ultima ? gris(` · latest compatible (${RANGO_OPENSPEC}): ${ultima}`) : ""}`);
    const instalacion = est.instalacion ?? config.openspec.instalacion;
    if (ultima && (!actual || !est.compatible || semver.gt(ultima, actual))) {
      if (await confirmar(`Update OpenSpec to ${ultima}${instalacion === "devDependency" ? " (repository dev dependency)" : " (global)"}?`, true, yes)) {
        s.start(`Installing OpenSpec ${ultima}…`);
        try {
          instalarOpenSpec(repo, instalacion, ultima);
          s.stop(`OpenSpec ${ultima} installed`);
          if (est.inicializado) {
            s.start("Running openspec update for tool skills and commands…");
            actualizarArchivosOpenSpec(repo, instalacion);
            s.stop("OpenSpec files updated");
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
    if (!cambios.length) p.log.success(`The kit is up to date (v${VERSION_KIT})`);
    else {
      const icono: Record<string, string> = { crear: pc.green("+"), actualizar: pc.yellow("~"), conflicto: pc.red("!") };
      p.note(cambios.map((c) => `${icono[c.accion]} ${c.ruta}${c.accion === "conflicto" ? pc.red("  (local edits require review)") : ""}`).join("\n"),
        `Kit ${manifest.kit} → ${VERSION_KIT}`);
      if (await confirmar("Apply the kit updates?", true, yes)) {
        const res = await aplicar(repo, plan, (c) => resolverConflicto(c, yes));
        actualizarVersiones(repo, { kit: VERSION_KIT, cli: VERSION_CLI });
        const n = (a: string) => res.filter((r) => r.accion === a).length;
        p.log.success(`Kit v${VERSION_KIT}: ${n("crear")} created, ${n("actualizar")} updated, ${n("mantenido")} kept, ${n("guardado-al-lado")} to merge manually`);
        for (const r of res.filter((r) => r.accion === "guardado-al-lado")) p.log.warn(`${r.ruta} → see ${r.detalle}`);
      }
    }
  }
  actualizarVersiones(repo, { cli: VERSION_CLI });
  p.outro(`${magenta("//")} Review changes with ${pc.cyan("git diff")}, then commit them.`);
}
