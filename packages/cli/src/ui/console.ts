/** Prompt helpers with non-interactive defaults and cancellation handling. */
import * as p from "@clack/prompts";
import { createTwoFilesPatch } from "diff";
import pc from "picocolors";

export { p, pc };

/** Brand colors with an ANSI fallback. */
const tc = (r: number, g: number, b: number) => (s: string) => (pc.isColorSupported ? `\x1b[38;2;${r};${g};${b}m${s}\x1b[39m` : s);
export const azul = tc(0x25, 0x63, 0xff);
export const magenta = tc(0xff, 0x2d, 0x9a);
export const gris = tc(0x94, 0xa3, 0xb8);

export function salirSiCancela<T>(v: T): Exclude<T, symbol> {
  if (p.isCancel(v)) {
    p.cancel("Canceled.");
    process.exit(130);
  }
  return v as Exclude<T, symbol>;
}

export const interactivo = () => !!process.stdin.isTTY && !!process.stdout.isTTY;

export async function confirmar(mensaje: string, porDefecto: boolean, yes: boolean): Promise<boolean> {
  if (yes) return porDefecto;
  return salirSiCancela(await p.confirm({ message: mensaje, initialValue: porDefecto }));
}

export async function elegir<T extends string>(mensaje: string, opciones: { value: T; label: string; hint?: string }[], porDefecto: T, yes: boolean): Promise<T> {
  if (yes) return porDefecto;
  return salirSiCancela<T | symbol>(await p.select<T>({ message: mensaje, options: opciones as any, initialValue: porDefecto }));
}

export async function elegirVarios<T extends string>(mensaje: string, opciones: { value: T; label: string; hint?: string }[], iniciales: T[], yes: boolean, requerido = false): Promise<T[]> {
  if (yes || !opciones.length) return iniciales;
  return salirSiCancela<T[] | symbol>(await p.multiselect<T>({ message: mensaje, options: opciones as any, initialValues: iniciales, required: requerido }));
}

export async function texto(mensaje: string, inicial: string, yes: boolean, placeholder?: string): Promise<string> {
  if (yes) return inicial;
  const v: string = salirSiCancela(await p.text({ message: mensaje, initialValue: inicial, placeholder }));
  return (v ?? "").trim();
}

export async function textoValidado(mensaje: string, inicial: string, validar: (v: string) => string | undefined, placeholder?: string): Promise<string> {
  const v: string = salirSiCancela(await p.text({ message: mensaje, initialValue: inicial, placeholder, validate: (x) => validar((x ?? "").trim()) }));
  return (v ?? "").trim();
}

export async function secreto(mensaje: string): Promise<string> {
  const v: string = salirSiCancela(await p.password({ message: mensaje, mask: "•" }));
  return (v ?? "").trim();
}

/** Truncated, colored unified diff for conflict prompts. */
export function diffColoreado(ruta: string, actual: string, nuevo: string, maxLineas = 60): string {
  const patch = createTwoFilesPatch(`${ruta} (local)`, `${ruta} (orqen)`, actual, nuevo, "", "", { context: 2 });
  const lineas = patch.split("\n").slice(2);
  const pintadas = lineas.map((l) =>
    l.startsWith("+") && !l.startsWith("+++") ? pc.green(l)
      : l.startsWith("-") && !l.startsWith("---") ? pc.red(l)
        : l.startsWith("@@") ? pc.cyan(l) : gris(l));
  return pintadas.length > maxLineas
    ? [...pintadas.slice(0, maxLineas), gris(`… ${pintadas.length - maxLineas} more lines`)].join("\n")
    : pintadas.join("\n");
}

export function tick(ok: boolean, requerido = true) {
  return ok ? pc.green("✔") : requerido ? pc.red("✘") : pc.yellow("▲");
}
