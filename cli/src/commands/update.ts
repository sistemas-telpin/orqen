/** Update the CLI or desktop app, and refresh OpenSpec and managed kit files in an orqen project. */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import semver from "semver";
import { actualizarVersiones, ARCHIVO_CONFIG, ARCHIVO_ENTORNO, configVieja, escribirConfig, existeConfig, leerConfig } from "../lib/config.ts";
import { leerEnv } from "../lib/env.ts";
import { legacyToYaml, legacyVarsIn } from "../connectors/legacy.ts";
import type { ConectoresYaml } from "../connectors/config.ts";
import { aplicar, leerManifest, planificar } from "../lib/kit.ts";
import {
  actualizarArchivosOpenSpec, estadoOpenSpec, instalarOpenSpec, RANGO_OPENSPEC, ultimaVersionOpenSpec,
} from "../lib/openspec.ts";
import { ejecutar, ejecutarAsync } from "../lib/proc.ts";
import { gestorCli, PAQUETE_CLI, ultimaVersionPaquete, VERSION_CLI } from "../lib/system.ts";
import { resumenStack } from "../lib/stack.ts";
import { mostrarLogo } from "../ui/logo.ts";
import { azul, confirmar, gris, interactivo, magenta, p, pc } from "../ui/console.ts";
import { resolverConflicto } from "./init.ts";
import { moveWorkToWorqs } from "../lib/worqs.ts";

export interface OpcionesUpdate { dir?: string; yes?: boolean; sinCli?: boolean; sinOpenspec?: boolean; sinKit?: boolean; sinAnimacion?: boolean; cliOnly?: boolean; desktop?: boolean; json?: boolean; target?: string }

const PAQUETES_DESKTOP = ["@telpin-sistemas/orqen-studio", "@telpin-sistemas/orqen-desktop"];
const DESKTOP_REPO = "sistemas-telpin/orqen-gui";

function paqueteGlobal(gestor: string, paquete: string): string {
  const r = ejecutar(gestor, ["root", "-g"], { timeoutMs: 20_000 });
  if (r.codigo !== 0 || !r.stdout.trim()) throw new Error(r.stderr.trim() || r.error?.message || `Could not locate global packages for ${gestor}.`);
  return join(r.stdout.trim(), paquete);
}

async function actualizarPaquete(gestor: string, paquete: string, actual: string, yes: boolean, objetivo?: string) {
  const ultima = objetivo ?? ultimaVersionPaquete(gestor, paquete);
  if (!ultima) return { status: "unavailable", version: actual };
  if (!semver.gt(ultima, actual)) return { status: "current", version: actual };
  if (!await confirmar(`Update ${paquete} from ${actual} to ${ultima}?`, true, yes)) return { status: "skipped", version: actual };

  const r = await ejecutarAsync(gestor, [gestor === "pnpm" ? "add" : "install", "-g", `${paquete}@${ultima}`], { timeoutMs: 10 * 60_000 });
  if (r.codigo !== 0) throw new Error(`Update failed for ${paquete}: ${(r.stderr || r.stdout || r.error?.message || `exit code ${r.codigo}`).trim().slice(-1500)}`);
  return { status: "installed", version: ultima };
}

function instalacionDesktop(): { paquete: string; version: string } {
  const scope = paqueteGlobal("npm", "@telpin-sistemas");
  const launcher = process.env.ORQEN_DESKTOP_NPM_MANIFEST;
  const launcherPath = launcher && existsSync(launcher) ? realpathSync(launcher) : null;
  for (const paquete of PAQUETES_DESKTOP) {
    const manifest = join(scope, paquete.split("/")[1]!, "package.json");
    if (!existsSync(manifest) || (launcher && launcherPath !== realpathSync(manifest))) continue;
    const { version } = JSON.parse(readFileSync(manifest, "utf8"));
    if (typeof version !== "string" || !semver.valid(version)) throw new Error("Invalid installed desktop version.");
    return { paquete, version };
  }
  if (launcher) throw new Error("The running desktop app is outside the active global npm installation.");
  throw new Error("Install orqen Studio globally with npm before updating it.");
}

async function githubDesktop(path: string) {
  const api = `repos/${DESKTOP_REPO}/${path}`;
  try {
    const response = await fetch(`https://api.github.com/${api}`, {
      headers: { Accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(5_000),
    });
    if (response.ok) return await response.json();
  } catch { /* Try the locally authenticated GitHub CLI. */ }
  const authenticated = await ejecutarAsync("gh", ["api", api], {
    timeoutMs: 5_000, env: { ...process.env, GH_PROMPT_DISABLED: "1" },
  });
  if (authenticated.codigo !== 0) throw new Error("Desktop release metadata is unavailable.");
  return JSON.parse(authenticated.stdout);
}

/** Read-only discovery for the desktop app. Installation is a separate, pinned action. */
export async function desktopRelease(installed: string) {
  if (!semver.valid(installed)) throw new Error("Invalid running desktop version.");
  const { paquete, version: actual } = instalacionDesktop();
  if (semver.gt(actual, installed)) {
    return console.log(JSON.stringify({ status: "installed", version: actual }));
  }
  const version = ultimaVersionPaquete("npm", paquete);
  if (!version) throw new Error("Could not check npm for orqen Desktop updates.");
  if (!semver.gt(version, installed)) return console.log(JSON.stringify({ status: "current", version: installed }));

  const range = `v${installed}...v${version}`;
  const [release, comparison] = await Promise.allSettled([
    githubDesktop(`releases/tags/v${version}`), githubDesktop(`compare/${range}?per_page=100`),
  ]);
  const notes = release.status === "fulfilled" && typeof release.value.body === "string" ? release.value.body.trim() : "";
  const commits = comparison.status === "fulfilled" && Array.isArray(comparison.value.commits)
    ? comparison.value.commits.map((c: { commit?: { message?: string } }) => c.commit?.message?.split("\n")[0]).filter(Boolean)
    : [];
  console.log(JSON.stringify({
    status: "available", version, notes, commits, url: `https://github.com/${DESKTOP_REPO}/compare/${range}`,
  }));
}

export async function update(o: OpcionesUpdate) {
  if (o.target !== undefined && (!o.desktop || !semver.valid(o.target))) throw new Error("--target requires --desktop and a valid version.");
  if (o.desktop) {
    const { paquete, version: actual } = instalacionDesktop();
    const result = await actualizarPaquete("npm", paquete, actual, !!o.yes || !interactivo(), o.target);
    if (result.status === "unavailable") throw new Error("Could not check npm for orqen Desktop updates.");
    if (o.json) console.log(JSON.stringify(result));
    else if (result.status === "installed") console.log(`orqen Desktop ${result.version} installed. Restart the app to use it.`);
    else if (result.status === "current") console.log(`orqen Desktop ${result.version} is up to date.`);
    return;
  }
  const repo = resolve(o.dir ?? process.cwd());
  let yes = !!o.yes;
  await mostrarLogo(!o.sinAnimacion && !o.yes);
  p.intro(`${azul("orqen")} ${magenta("update")} ${gris(`v${VERSION_CLI} · ${repo}`)}`);
  if (!yes && !interactivo()) { p.log.warn("Non-interactive terminal. Using defaults as with --yes."); yes = true; }

  const config = !o.cliOnly && (o.dir !== undefined || o.sinCli || existeConfig(repo)) ? leerConfig(repo) : undefined;

  if (!o.sinCli) {
    const gestor = gestorCli();
    p.log.step("Checking for orqen updates…");
    const result = await actualizarPaquete(gestor, PAQUETE_CLI, VERSION_CLI, yes);
    if (result.status === "unavailable") {
      if (!config) throw new Error("Could not check npm for orqen updates.");
      p.log.warn("Could not reach npm. Using the installed CLI to update this project.");
    }
    if (result.status === "current") p.log.success(`orqen ${result.version} is up to date`);
    if (result.status === "installed") {
      p.log.success(`orqen ${result.version} installed`);
      if (config) {
        const cli = join(paqueteGlobal(gestor, PAQUETE_CLI), "dist", "index.js");
        const args = [cli, "update", "--dir", repo, "--no-cli", "--no-animation"];
        if (yes) args.push("--yes");
        if (o.sinOpenspec) args.push("--no-openspec");
        if (o.sinKit) args.push("--no-kit");
        const r = ejecutar(process.execPath, args, { heredar: true });
        if (r.error) throw r.error;
        process.exitCode = r.codigo;
        return;
      }
    }
  }
  if (!config) return;

  const s = p.spinner();

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
        } catch (e) { s.error((e as Error).message); process.exitCode = 1; }
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
