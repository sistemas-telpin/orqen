/** Update the CLI, compatible OpenSpec installation, and managed kit files. */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import semver from "semver";
import { actualizarVersiones, ARCHIVO_CONFIG, ARCHIVO_ENTORNO, configVieja, escribirConfig, leerConfig } from "../lib/config.ts";
import { leerEnv } from "../lib/env.ts";
import { legacyToYaml, legacyVarsIn } from "../connectors/legacy.ts";
import type { ConectoresYaml } from "../connectors/config.ts";
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
import { moveWorkToWorqs } from "../lib/worqs.ts";

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

  // 2b. The worqs (the record of each request): orqen/work/ of earlier versions → orqen/worqs/
  if (existsSync(join(repo, "orqen", "work")) && !existsSync(join(repo, "orqen", "worqs"))) {
    p.log.info("The worqs (orqen's unit of work: one folder per request) are now in orqen/worqs/; this repository still has them in orqen/work/.");
    if (await confirmar("Move orqen/work/ to orqen/worqs/ (git mv)? Branches of requests in progress keep their old path and are still read", true, yes)) {
      const m = moveWorkToWorqs(repo);
      if (m.moved) p.log.success(`${m.detail} ${gris("(commit the move with the rest of the update)")}`); else p.log.warn(m.detail);
    }
  }

  // 3. Kit
  if (!o.sinKit) {
    const manifest = leerManifest(repo);
    const vars = {
      RESUMEN_STACK: resumenStack(config.stack), BASE_BRANCH: config.proyecto.rama_base,
      AGENT_CMD: config.agente.comando ?? "claude -p --permission-mode acceptEdits",
    };
    const plan = planificar(repo, vars);
    const cambios = plan.filter((c) => c.accion !== "igual");
    if (!cambios.length) p.log.success(`The kit is up to date (v${VERSION_CLI})`);
    else {
      const icono: Record<string, string> = { crear: pc.green("+"), actualizar: pc.yellow("~"), conflicto: pc.red("!") };
      p.note(cambios.map((c) => `${icono[c.accion]} ${c.ruta}${c.accion === "conflicto" ? pc.red("  (local edits require review)") : ""}`).join("\n"),
        `Kit ${manifest.kit} → ${VERSION_CLI}`);
      if (await confirmar("Apply the kit updates?", true, yes)) {
        const res = await aplicar(repo, plan, (c) => resolverConflicto(c, yes));
        actualizarVersiones(repo, { kit: VERSION_CLI, cli: VERSION_CLI });
        const n = (a: string) => res.filter((r) => r.accion === a).length;
        p.log.success(`Kit v${VERSION_CLI}: ${n("crear")} created, ${n("actualizar")} updated, ${n("mantenido")} kept, ${n("guardado-al-lado")} to merge manually`);
        for (const r of res.filter((r) => r.accion === "guardado-al-lado")) p.log.warn(`${r.ruta} → see ${r.detalle}`);
      }
    }
  }
  // 4. Connectors: move the variables of earlier versions (REC_JQL, SIS_PROJECT…) to `conectores` in config.yaml
  const env = leerEnv(repo) ?? {};
  const viejas = legacyVarsIn(env);
  if (!config.conectores && viejas.length) {
    const bloque = legacyToYaml(env) as ConectoresYaml;
    p.log.info(`orqen/.env uses variables of an earlier version: ${viejas.join(", ")}`);
    if (await confirmar("Move where the tickets live to orqen/config.yaml (connectors)? orqen/.env is not modified", true, yes)) {
      const actual = leerConfig(repo);
      actual.conectores = bloque;
      escribirConfig(repo, actual);
      p.log.success(`connectors written in orqen/config.yaml ${gris("(you can delete REC_JQL and SIS_* from orqen/.env)")}`);
    }
  }
  // 5. Format of earlier versions: Spanish keys and the stack/environment inside config.yaml
  if (configVieja(repo)) {
    p.log.info(`${ARCHIVO_CONFIG} uses the format of an earlier version (Spanish keys, stack and environment in the same file).`);
    if (await confirmar(`Rewrite it with English keys and move the stack and environment to ${ARCHIVO_ENTORNO}? (comments in the file are not kept)`, true, yes)) {
      escribirConfig(repo, leerConfig(repo));
      p.log.success(`${ARCHIVO_CONFIG} rewritten · ${ARCHIVO_ENTORNO} created`);
    }
  }
  actualizarVersiones(repo, { cli: VERSION_CLI });
  p.outro(`${magenta("//")} Review changes with ${pc.cyan("git diff")}, then commit them.`);
}
