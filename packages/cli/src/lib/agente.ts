/**
 * Exploración del repo con el agente de IA que la persona ya tiene instalado (Claude Code, Codex, Gemini...)
 * en modo headless. El agente recibe la detección determinística + el JSON Schema del stack y escribe su
 * propuesta en .orqen/tmp/stack-propuesto.json. orqen la valida con zod y, si no cumple, reintenta una vez
 * pasándole los errores.
 */
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ejecutarAsync, partirComando, version } from "./proc.ts";
import { resumenComoTexto, resumirRepo } from "./resumen-repo.ts";
import { Stack, esquemaStackJson } from "./stack.ts";

export interface AgenteConocido {
  id: string; nombre: string; binario: string;
  /** Modo agente (explora con herramientas; también es el que usa el modo desatendido). */
  comando: string;
  /** Modo rápido: un solo turno, sin herramientas, con el modelo más veloz del agente. */
  rapido: string;
}

/**
 * Comandos headless por defecto. El prompt va por stdin (evita el límite de largo de línea de cmd.exe).
 * Si el comando tiene {prompt}, se pasa como argumento en su lugar.
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

export const RUTA_PROPUESTA = ".orqen/tmp/stack-propuesto.json";

export function promptExploracion(deteccion: { stack: Stack; evidencias: string[] }, errores?: string[]): string {
  return [
    "Sos el agente de inicialización de ORQEN, una plataforma que orquesta agentes de IA para desarrollar software.",
    "Tu tarea: explorar ESTE repositorio (estás parado en su raíz) y proponer el stack tecnológico y los entornos",
    "necesarios para que otros agentes puedan levantar el proyecto y correr TODOS sus tests (unitarios, integración,",
    "e2e y visuales) sin que una persona abra una terminal. Los servicios (bases de datos, colas, caches, etc.)",
    "se van a levantar con Docker Compose; las apps se pueden correr en contenedores o en la máquina.",
    "",
    "Reglas:",
    "- Solo lectura: NO modifiques, crees ni borres archivos del repo, salvo el archivo de salida indicado abajo.",
    "- No instales dependencias, no ejecutes builds ni tests, no hagas commits. Sin red.",
    "- Basate en evidencia (manifiestos, configs, código, Dockerfiles, CI, READMEs). Lo que no puedas confirmar va en `notas`.",
    "- Usá nombres cortos en minúsculas para componentes y servicios (son nombres de servicios de compose).",
    "- Para cada servicio usá el `tipo` del catálogo; `imagen` solo si hace falta una distinta a la estándar.",
    "- Los comandos de tests deben poder correrse desde la raíz del repo (usá `cd <ruta> && ...` si hace falta).",
    "- `variables`: lo que las apps/tests necesitan para conectarse a los servicios desde la máquina (host localhost).",
    "- Escribí en español rioplatense.",
    "",
    "Detección automática previa (puede estar incompleta o equivocada; corregila):",
    "```json",
    JSON.stringify(deteccion.stack, null, 2),
    "```",
    "Evidencias:",
    ...deteccion.evidencias.map((e) => `- ${e}`),
    "",
    "JSON Schema de la salida:",
    "```json",
    JSON.stringify(esquemaStackJson()),
    "```",
    "",
    ...(errores?.length
      ? ["Tu intento anterior no pasó la validación. Corregí estos errores:", ...errores.map((e) => `- ${e}`), ""]
      : []),
    `Escribí SOLO el JSON (sin markdown) en el archivo \`${RUTA_PROPUESTA}\`. Después respondé "listo".`,
  ].join("\n");
}

/** Saca el último objeto JSON de un texto (por si el agente lo imprimió en vez de escribir el archivo). */
export function extraerJson(texto: string): unknown {
  const bloques = [...texto.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1]);
  for (const b of bloques.reverse()) { try { return JSON.parse(b); } catch { /* sigue */ } }
  const i = texto.indexOf("{"), f = texto.lastIndexOf("}");
  if (i >= 0 && f > i) { try { return JSON.parse(texto.slice(i, f + 1)); } catch { /* nada */ } }
  // claude -p --output-format json envuelve la respuesta en { result }
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
  mkdirSync(join(repo, ".orqen", "tmp"), { recursive: true });
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
    if (r.error) return { ok: false, errores: [`No pude ejecutar "${bin}": ${r.error.message}`], salida };
    let datos: unknown;
    if (existsSync(archivo)) { try { datos = JSON.parse(readFileSync(archivo, "utf8")); } catch (e) { errores = [`JSON inválido: ${(e as Error).message}`]; } }
    if (datos === undefined) datos = extraerJson(r.stdout);
    if (datos === undefined) {
      errores = errores ?? [r.codigo !== 0 ? `El agente terminó con código ${r.codigo}` : `No encontré ${RUTA_PROPUESTA} ni JSON en la respuesta`];
    } else {
      const v = Stack.safeParse(datos);
      if (v.success) return { ok: true, stack: v.data, errores: [], salida };
      errores = v.error.issues.map((i) => `${i.path.join(".") || "(raíz)"}: ${i.message}`);
    }
    if (intento === 0) o.alReintentar?.(errores);
  }
  return { ok: false, errores: errores ?? [], salida };
}

/** Comando rápido que corresponde a un comando de agente (si es uno conocido); si no, el mismo comando. */
export function comandoRapido(comando: string): string {
  const bin = partirComando(comando)[0];
  return AGENTES.find((a) => a.binario === bin)?.rapido ?? comando;
}

export function promptRapido(repo: string, deteccion: { stack: Stack; evidencias: string[] }, errores?: string[]): string {
  return [
    "Sos el agente de inicialización de ORQEN. Con la información de abajo (NO uses herramientas, NO leas archivos,",
    "NO ejecutes nada: respondé en un solo turno) proponé el stack tecnológico y los entornos necesarios para que",
    "otros agentes levanten el proyecto y corran sus tests (unitarios, integración, e2e, visuales) sin una persona.",
    "Los servicios (bases de datos, colas, caches) se levantan con Docker Compose.",
    "",
    "Reglas:",
    "- Basate solo en la evidencia de abajo. Lo que no puedas confirmar va en `notas` (breve).",
    "- Nombres cortos en minúsculas para componentes y servicios (son nombres de servicios de compose).",
    "- `tipo` de cada servicio: uno del catálogo del schema; `imagen` solo si hace falta una distinta a la estándar.",
    "- Los comandos de tests se corren desde la raíz del repo y tienen que andar en sh y en cmd.exe.",
    "- `variables`: lo que las apps/tests necesitan para conectarse a los servicios desde la máquina (localhost).",
    "- Español rioplatense. `resumen`: máximo 2 oraciones.",
    "",
    "Detección automática (puede estar incompleta o equivocada; corregila):",
    JSON.stringify(deteccion.stack),
    "",
    resumenComoTexto(resumirRepo(repo)),
    "",
    "JSON Schema de la salida:",
    JSON.stringify(esquemaStackJson()),
    "",
    ...(errores?.length ? ["Tu intento anterior no pasó la validación. Corregí:", ...errores.map((e) => `- ${e}`), ""] : []),
    "Respondé ÚNICAMENTE con el objeto JSON (sin texto antes ni después, sin markdown).",
  ].join("\n");
}

/**
 * Exploración rápida: un solo turno con el resumen del repo en el prompt. No toca el repo, así que puede
 * correr en segundo plano mientras la persona contesta el resto de las preguntas.
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
    if (r.error) return { ok: false, errores: [`No pude ejecutar "${bin}": ${r.error.message}`], salida };
    const datos = extraerJson(r.stdout);
    if (datos === undefined) {
      // Sin JSON (timeout, error de autenticación, etc.): no tiene sentido reintentar.
      return { ok: false, errores: [r.codigo !== 0 ? `El agente terminó con código ${r.codigo}: ${salida.slice(-300)}` : "El agente no devolvió JSON"], salida };
    }
    const v = Stack.safeParse(datos);
    if (v.success) return { ok: true, stack: v.data, errores: [], salida };
    errores = v.error.issues.map((i) => `${i.path.join(".") || "(raíz)"}: ${i.message}`);
  }
  return { ok: false, errores: errores ?? [], salida };
}
