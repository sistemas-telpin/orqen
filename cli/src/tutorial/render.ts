/** Render tutorial steps for the terminal (colors) or as Markdown (for an agent to show verbatim). */
import { gris, magenta, pc } from "../ui/console.ts";
import type { Bloque, Paso } from "./content.ts";

const codigo = (s: string) => s.replace(/`([^`]+)`/g, (_, x) => pc.cyan(x));

/** Split "cmd   # comment" so the comment can be dimmed. */
function partirComentario(l: string): [string, string] {
  const i = l.search(/\s{2,}# /);
  return i < 0 ? [l, ""] : [l.slice(0, i), l.slice(i)];
}

export function renderTerminal(paso: Paso, encabezado: string): string {
  const out: string[] = ["", `${magenta("●")} ${gris(encabezado)}  ${pc.bold(paso.titulo)}`, ""];
  for (const b of paso.bloques) out.push(...bloqueTerminal(b), "");
  return out.join("\n");
}

function bloqueTerminal(b: Bloque): string[] {
  switch (b.t) {
    case "p": return [codigo(b.texto)];
    case "h": return [pc.bold(b.texto)];
    case "cmd": return b.lineas.map((l) => { const [c, com] = partirComentario(l); return `   ${pc.cyan(c)}${gris(com)}`; });
    case "ul": return b.items.map((x) => ` • ${codigo(x)}`);
    case "ol": return b.items.map((x, i) => ` ${pc.bold(`${i + 1}.`)} ${codigo(x)}`);
    case "pre": return b.lineas.map((l) => gris("│") + " " + l);
    case "tip": return [`${pc.yellow("★")} ${codigo(b.texto)}`];
  }
}

export function renderMarkdown(paso: Paso, encabezado: string): string {
  const out: string[] = [`### ${encabezado} · ${paso.titulo}`, ""];
  for (const b of paso.bloques) out.push(...bloqueMarkdown(b), "");
  return out.join("\n").trimEnd() + "\n";
}

function bloqueMarkdown(b: Bloque): string[] {
  switch (b.t) {
    case "p": return [b.texto];
    case "h": return [`**${b.texto}**`];
    case "cmd": return ["```", ...b.lineas, "```"];
    case "ul": return b.items.map((x) => `- ${x}`);
    case "ol": return b.items.map((x, i) => `${i + 1}. ${x}`);
    case "pre": return ["```text", ...b.lineas, "```"];
    case "tip": return [`> ${b.texto}`];
  }
}
