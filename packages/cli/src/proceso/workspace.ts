/** git, tests y PR: siempre los ejecuta el proceso, nunca el agente. */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { parse as parseYaml } from "yaml";
import type { Config } from "./config.ts";

/** Resultado de levantar el entorno; va al contexto del agente para que sepa con qué cuenta. */
export interface EstadoEntorno {
  ok: boolean;
  /** Qué se hizo (o por qué no se pudo). */
  detalle: string;
  /** Variables para conectarse a los servicios (también las reciben los tests). */
  variables?: Record<string, string>;
  /** Cómo correr los tests a mano mientras se desarrolla. */
  comandos?: Record<string, string>;
  salida?: string;
}

export interface Workspace {
  /** Instala dependencias, levanta servicios (y apps si `apps`), espera healthchecks, migra y carga datos. */
  levantarEntorno?(apps: boolean): EstadoEntorno;
  bajarEntorno?(): void;
  prepararRama(key: string): string;
  /** `ruta` limita el commit a ese path; `rama` lo hace solo si es la rama activa (evita commitear en la rama de otro REC). */
  commit(key: string, mensaje: string, opts?: { ruta?: string; rama?: string }): boolean;
  correrTests(): { ok: boolean; salida: string };
  push(rama: string): void;
  abrirPr(vars: Record<string, string>): string;
}

export class GitWorkspace implements Workspace {
  constructor(private cfg: Config) {}
  private git = (...args: string[]) =>
    execFileSync("git", args, { cwd: this.cfg.repoPath, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

  prepararRama(key: string) {
    const rama = `rec/${key.toLowerCase()}`;
    if (this.git("rev-parse", "--abbrev-ref", "HEAD") === rama) return rama;
    if (this.git("status", "--porcelain", "--untracked-files=no", ...this.sinFactory()))
      throw new Error("El repo tiene cambios sin commitear; no puedo cambiar de rama");
    try { this.git("fetch", "--all", "--prune"); } catch { /* sin remoto */ }
    if (this.git("branch", "--list", rama)) this.git("checkout", rama);
    else {
      this.git("checkout", this.cfg.ramaBase);
      try { this.git("pull", "--ff-only"); } catch { /* sin remoto */ }
      this.git("checkout", "-b", rama);
    }
    return rama;
  }

  /** Pathspec que excluye orqen/work/ (el registro del proceso no debe impedir cambiar de rama). */
  private sinFactory(): string[] {
    const r = relative(this.cfg.repoPath, this.cfg.factoryDir).replaceAll("\\", "/");
    return r && !r.startsWith("..") ? ["--", ".", `:(exclude)${r}`] : [];
  }

  private rutaRelativa(ruta: string) {
    const r = relative(this.cfg.repoPath, ruta).replaceAll("\\", "/");
    return r.startsWith("..") ? undefined : r;
  }

  commit(key: string, mensaje: string, opts: { ruta?: string; rama?: string } = {}) {
    if (opts.rama && this.git("rev-parse", "--abbrev-ref", "HEAD") !== opts.rama) return false;
    const ruta = opts.ruta ? this.rutaRelativa(opts.ruta) : undefined;
    if (opts.ruta && ruta === undefined) return false;
    const alcance = ruta ? ["--", ruta] : [];
    this.git("add", "-A", ...alcance);
    if (!this.git("status", "--porcelain", ...alcance)) return false;
    this.git("commit", "-m", `${key}: ${mensaje}`, ...alcance);
    return true;
  }

  private linea(cmd: string, timeoutMin = 30) {
    const e = this.cfg.entorno;
    const p = spawnSync(cmd, {
      shell: true, cwd: this.cfg.repoPath, encoding: "utf8", timeout: timeoutMin * 60_000,
      env: { ...process.env, ...e?.variables }, maxBuffer: 64 * 1024 * 1024,
    });
    return { ok: p.status === 0, salida: ((p.stdout ?? "") + (p.stderr ?? "")).slice(-15_000) };
  }

  private compose(args: string, apps = false) {
    return `docker compose -f "${this.cfg.entorno!.compose}"${apps ? " --profile apps" : ""} ${args}`;
  }

  /** ¿Hay algo que levantar con Docker? (compose con servicios; con `apps`, cuenta también el perfil apps) */
  private serviciosCompose(apps: boolean): boolean {
    const e = this.cfg.entorno;
    if (!e) return false;
    const ruta = join(this.cfg.repoPath, e.compose);
    if (!existsSync(ruta)) return false;
    try {
      const svcs = Object.values<any>(parseYaml(readFileSync(ruta, "utf8"))?.services ?? {});
      return svcs.some((s) => apps || !(s?.profiles ?? []).includes("apps"));
    } catch { return false; }
  }

  levantarEntorno(apps: boolean): EstadoEntorno {
    const e = this.cfg.entorno;
    if (!e) return { ok: true, detalle: "Sin orqen/config.yaml: no hay entornos configurados (corré `orqen init`)." };
    const comandos = Object.fromEntries(Object.entries(e.tests).filter(([, v]) => v).map(([k]) => [k, `orqen env test ${k}`]));
    const hecho: string[] = [];
    const fallar = (paso: string, salida: string): EstadoEntorno => ({
      ok: false, variables: e.variables, comandos, salida: salida.slice(-3000),
      detalle: `Falló "${paso}". ${hecho.length ? `Antes: ${hecho.join(", ")}. ` : ""}Revisá orqen/config.yaml / ${e.compose}; si no lo podés resolver, bloqueá el REC.`,
    });
    for (const cmd of e.preparar) { const r = this.linea(cmd); if (!r.ok) return fallar(cmd, r.salida); }
    if (e.preparar.length) hecho.push("dependencias instaladas");
    if (this.serviciosCompose(apps)) {
      const r = this.linea(this.compose("up -d --wait --remove-orphans", apps), 15);
      if (!r.ok) return fallar("docker compose up", r.salida);
      hecho.push(apps ? "servicios y apps levantados" : "servicios levantados");
    }
    for (const cmd of [...e.migrar, ...e.seed]) { const r = this.linea(cmd); if (!r.ok) return fallar(cmd, r.salida); }
    if (e.migrar.length) hecho.push("migraciones aplicadas");
    if (e.seed.length) hecho.push("datos de prueba cargados");
    return { ok: true, detalle: hecho.length ? `Entorno listo: ${hecho.join(", ")}.` : "No hay nada que levantar.", variables: e.variables, comandos };
  }

  bajarEntorno() {
    if (!this.cfg.entorno || !this.serviciosCompose(true)) return;
    this.linea(this.compose("down -v --remove-orphans", true), 5);
  }

  correrTests() {
    const tests = Object.entries(this.cfg.entorno?.tests ?? {}).filter(([, v]) => v) as [string, string][];
    if (!tests.length) return this.linea(this.cfg.comandoTests);
    // Todos los tipos configurados en orqen/config.yaml (unitarios, integración, e2e, visual), con las variables del entorno.
    let ok = true, salida = "";
    for (const [tipo, cmd] of tests) {
      const r = this.linea(cmd);
      ok &&= r.ok;
      salida += `\n===== tests ${tipo}: ${cmd} → ${r.ok ? "OK" : "FALLÓ"} =====\n${r.salida.slice(-Math.floor(15_000 / tests.length))}\n`;
    }
    return { ok, salida: salida.trim() };
  }

  push(rama: string) { this.git("push", "-u", "origin", rama); }

  abrirPr(vars: Record<string, string>) {
    if (!this.cfg.comandoPr) return "";
    // los valores vienen de Jira: se limpian para que no puedan inyectar shell
    const cmd = this.cfg.comandoPr.replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? "").replace(/["'`$\\;|&<>]/g, ""));
    const p = spawnSync(cmd, { shell: true, cwd: this.cfg.repoPath, encoding: "utf8" });
    return (p.stdout || p.stderr || "").trim();
  }
}
