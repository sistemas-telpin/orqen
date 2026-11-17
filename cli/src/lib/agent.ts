/**
 * Inspect a repository using an installed AI agent in headless mode.
 * The agent receives the initial detection and JSON Schema and returns a validated stack proposal.
 * Validation errors are sent back to the agent for one retry.
 *
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ejecutarAsync, partirComando, version } from "./proc.ts";
import { resumenComoTexto, resumirRepo } from "./repo-summary.ts";
import { Stack, esquemaStackJson } from "./stack.ts";

export interface AgenteConocido {
  id: string; nombre: string; binario: string;
  /** Full analysis with tools, also used for unattended stages. */
  comando: string;
  /** Quick analysis in a single turn with no tools. */
  rapido: string;
}

/**
 * Pass the prompt on stdin to avoid cmd.exe command-line length limits.
 * Commands with a {prompt} placeholder receive the prompt as an argument.
 */
export const AGENTES: AgenteConocido[] = [
  { id: "claude", nombre: "Claude Code", binario: "claude", comando: "claude -p --permission-mode acceptEdits", rapido: "claude -p --model haiku" },
  { id: "codex", nombre: "Codex CLI", binario: "codex", comando: "codex exec --full-auto -", rapido: "codex exec --sandbox read-only -" },
  { id: "gemini", nombre: "Gemini CLI", binario: "gemini", comando: "gemini --yolo", rapido: "gemini" },
];

export function agentesInstalados(): (AgenteConocido & { version: string })[] {
  return AGENTES.flatMap((a) => {
    const v = version(a.binario);
    return v === null ? [] : [{ ...a, version: v }];
  });
}

export const RUTA_PROPUESTA = "orqen/tmp/stack-proposal.json";

export function promptExploracion(deteccion: { stack: Stack; evidencias: string[] }, errores?: string[]): string {
  return [
    "You are the ORQEN setup agent.",
    "Inspect this repository from its root and propose its stack and environments",
    "so other agents can start it and run all tests (unit, integration,",
    "end-to-end, and visual) without manual setup. Each part runs on the host with its own command",
    "(npm run dev, npm start, mvn spring-boot:run, dotnet watch run…): set `comandos.dev` and `puerto` on each component.",
    "Do not propose Docker unless the repository already uses it for development.",
    "",
    "Rules:",
    "- Read only. The output file below is the only repository file you may write.",
    "- Do not install dependencies, run builds or tests, commit changes, or use the network.",
    "- Use manifests, configuration, source code, Dockerfiles, CI, and READMEs. Record unverified assumptions in `notas`.",
    "- Use short lowercase names for components and services.",
    "- List in `servicios` what the project needs besides its code (databases, queues), with a catalog `tipo`.",
    "- Test commands must run from the repository root. Use `cd <path> && ...` if needed.",
    "- `variables`: settings apps and tests need (database URL, API URL…), taken from .env.example or config files; no secrets.",
    "- Write in English.",
    "",
    "Automatic detection results (correct any errors or omissions):",
    "```json",
    JSON.stringify(deteccion.stack, null, 2),
    "```",
    "Evidence:",
    ...deteccion.evidencias.map((e) => `- ${e}`),
    "",
    "Output JSON Schema:",
    "```json",
    JSON.stringify(esquemaStackJson()),
    "```",
    "",
    ...(errores?.length
      ? ["The previous output failed validation. Fix these errors:", ...errores.map((e) => `- ${e}`), ""]
      : []),
    `Write only JSON (no Markdown) to \`${RUTA_PROPUESTA}\`. Then reply "done".`,
  ].join("\n");
}

/** Extract the last JSON object when the agent prints it instead of writing the output file. */
export function extraerJson(texto: string): unknown {
  const bloques = [...texto.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1]);
  for (const b of bloques.reverse()) { try { return JSON.parse(b); } catch { /* Try the next block. */ } }
  const i = texto.indexOf("{"), f = texto.lastIndexOf("}");
  if (i >= 0 && f > i) { try { return JSON.parse(texto.slice(i, f + 1)); } catch { /* Ignore invalid JSON. */ } }
  // Claude's JSON mode wraps the response in { result }.
  return undefined;
}

export interface ResultadoExploracion { ok: boolean; stack?: Stack; errores: string[]; salida: string }

export async function explorarConAgente(
  repo: string,
  comando: string,
  deteccion: { stack: Stack; evidencias: string[] },
  o: { timeoutMs?: number; alReintentar?: (errores: string[]) => void } = {},
): Promise<ResultadoExploracion> {
  const archivo = join(repo, RUTA_PROPUESTA);
  mkdirSync(join(repo, "orqen", "tmp"), { recursive: true });
  let errores: string[] | undefined;
  let salida = "";
  for (let intento = 0; intento < 2; intento++) {
    if (existsSync(archivo)) rmSync(archivo);
    const prompt = promptExploracion(deteccion, errores);
    const [bin, ...args] = partirComando(comando);
    const usaArg = args.some((a) => a.includes("{prompt}"));
    const r = await ejecutarAsync(bin, usaArg ? args.map((a) => a.replace("{prompt}", prompt)) : args, {
      cwd: repo, entrada: usaArg ? undefined : prompt, timeoutMs: o.timeoutMs ?? 15 * 60_000,
    });
    salida = (r.stdout + "\n" + r.stderr).trim();
    if (r.error) return { ok: false, errores: [`Could not execute "${bin}": ${r.error.message}`], salida };
    let datos: unknown;
    if (existsSync(archivo)) { try { datos = JSON.parse(readFileSync(archivo, "utf8")); } catch (e) { errores = [`Invalid JSON: ${(e as Error).message}`]; } }
    if (datos === undefined) datos = extraerJson(r.stdout);
    if (datos === undefined) {
      errores = errores ?? [r.codigo !== 0 ? `The agent exited with code ${r.codigo}` : `Could not find ${RUTA_PROPUESTA} or JSON in the response`];
    } else {
      const v = Stack.safeParse(datos);
      if (v.success) return { ok: true, stack: v.data, errores: [], salida };
      errores = v.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
    }
    if (intento === 0) o.alReintentar?.(errores);
  }
  return { ok: false, errores: errores ?? [], salida };
}

/** Use a known agent's quick command, or keep the supplied command. */
export function comandoRapido(comando: string): string {
  const bin = partirComando(comando)[0];
  return AGENTES.find((a) => a.binario === bin)?.rapido ?? comando;
}

export function promptRapido(repo: string, deteccion: { stack: Stack; evidencias: string[] }, errores?: string[]): string {
  return [
    "You are the ORQEN setup agent. Use only the information below. Do not call tools,",
    "read files, or run commands. In one response, propose a stack and environments so",
    "other agents can start the project and run its unit, integration, end-to-end, and visual tests.",
    "Each part runs on the host with its own command (npm run dev, npm start, mvn spring-boot:run…): set `comandos.dev`",
    "and `puerto` on each component. Do not propose Docker unless the repository already uses it for development.",
    "",
    "Rules:",
    "- Use only the evidence below. Briefly record anything you cannot confirm in `notas`.",
    "- Use short lowercase names for components and services.",
    "- List in `servicios` what the project needs besides its code (databases, queues), with a catalog `tipo`.",
    "- Test commands run from the repository root and must work in both sh and cmd.exe.",
    "- `variables`: settings apps and tests need (database URL, API URL…), taken from .env.example or config files; no secrets.",
    "- Write in English. Limit `resumen` to two sentences.",
    "",
    "Automatic detection results (correct any errors or omissions):",
    JSON.stringify(deteccion.stack),
    "",
    resumenComoTexto(resumirRepo(repo)),
    "",
    "Output JSON Schema:",
    JSON.stringify(esquemaStackJson()),
    "",
    ...(errores?.length ? ["The previous output failed validation. Fix these errors:", ...errores.map((e) => `- ${e}`), ""] : []),
    "Return only the JSON object, without extra text or Markdown.",
  ].join("\n");
}

/**
 * Quick analysis sends a repository summary in the prompt without editing the repository.
 * It can run in the background while the user answers setup prompts.
 */
export async function explorarRapido(
  repo: string,
  comando: string,
  deteccion: { stack: Stack; evidencias: string[] },
  o: { timeoutMs?: number } = {},
): Promise<ResultadoExploracion> {
  let errores: string[] | undefined;
  let salida = "";
  const [bin, ...args] = partirComando(comando);
  const usaArg = args.some((a) => a.includes("{prompt}"));
  for (let intento = 0; intento < 2; intento++) {
    const prompt = promptRapido(repo, deteccion, errores);
    const r = await ejecutarAsync(bin, usaArg ? args.map((a) => a.replace("{prompt}", prompt)) : args, {
      cwd: repo, entrada: usaArg ? undefined : prompt, timeoutMs: o.timeoutMs ?? 90_000,
    });
    salida = (r.stdout + "\n" + r.stderr).trim();
    if (r.error) return { ok: false, errores: [`Could not execute "${bin}": ${r.error.message}`], salida };
    const datos = extraerJson(r.stdout);
    if (datos === undefined) {
      // Skip the retry when the agent returns no JSON (e.g. timeout or authentication failure).
      return { ok: false, errores: [r.codigo !== 0 ? `The agent exited with code ${r.codigo}: ${salida.slice(-300)}` : "The agent returned no JSON"], salida };
    }
    const v = Stack.safeParse(datos);
    if (v.success) return { ok: true, stack: v.data, errores: [], salida };
    errores = v.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
  }
  return { ok: false, errores: errores ?? [], salida };
}

/**
 * Run quick analysis in a separate process without sharing the terminal.
 * The promise resolves with the result. cancelar() stops the process.
 */
export function explorarRapidoAislado(
  repo: string,
  comando: string,
  deteccion: { stack: Stack; evidencias: string[] },
  o: { timeoutMs?: number } = {},
): { resultado: Promise<ResultadoExploracion>; cancelar: () => void } {
  const timeoutMs = o.timeoutMs ?? 90_000;
  const dir = mkdtempSync(join(tmpdir(), "orqen-ai-"));
  const salida = join(dir, "result.json"), archivoTrabajo = join(dir, "job.json");
  writeFileSync(archivoTrabajo, JSON.stringify({ repo, comando, deteccion, salida, timeoutMs }));
  const enTs = import.meta.url.endsWith(".ts");          // Detect whether the worker runs from source or compiled JavaScript.
  const script = fileURLToPath(new URL(`../ai-worker.${enTs ? "ts" : "js"}`, import.meta.url));
  const cargadores: string[] = []; // Keep loaders such as tsx but omit flags such as --test.
  process.execArgv.forEach((a, i, xs) => {
    if (/^--(import|require|loader|experimental-loader)$/.test(a) && xs[i + 1]) cargadores.push(a, xs[i + 1]);
    else if (/^--(import|require|loader|experimental-loader)=/.test(a)) cargadores.push(a);
  });
  const hijo = spawn(process.execPath, [...cargadores, script, archivoTrabajo], {
    // Resolve loaders from the package directory. The worker uses the explicit repo path.
    detached: true, stdio: "ignore", windowsHide: true, cwd: dirname(script),
  });
  hijo.unref();
  let terminado = false, temporizador: NodeJS.Timeout | undefined;
  const limpiar = () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ } };
  const cancelar = () => {
    if (terminado) return;
    terminado = true;
    clearInterval(temporizador);
    try { if (hijo.pid) process.kill(hijo.pid); } catch { /* The process already exited. */ }
    limpiar();
  };
  process.once("exit", cancelar);
  const resultado = new Promise<ResultadoExploracion>((resolve) => {
    const inicio = Date.now();
    let error: string | undefined, salioEn: number | undefined;
    hijo.once("error", (e) => { error = e.message; });
    hijo.once("exit", (codigo) => { salioEn = Date.now(); if (codigo) error = `the analysis process exited with code ${codigo}`; });
    temporizador = setInterval(() => {
      let r: ResultadoExploracion | undefined;
      if (existsSync(salida)) { try { r = JSON.parse(readFileSync(salida, "utf8")); } catch { /* The worker is still writing the result. */ } }
      else if (error) r = { ok: false, errores: [`Could not complete analysis: ${error}`], salida: "" };
      else if (salioEn && Date.now() - salioEn > 1000) r = { ok: false, errores: ["The analysis process exited without a result"], salida: "" };
      else if (Date.now() - inicio > timeoutMs * 2 + 10_000) r = { ok: false, errores: ["Analysis timed out"], salida: "" };
      if (!r) return;
      clearInterval(temporizador);
      terminado = true;
      process.removeListener("exit", cancelar);
      limpiar();
      resolve(r);
    }, 150);
  });
  return { resultado, cancelar };
}
