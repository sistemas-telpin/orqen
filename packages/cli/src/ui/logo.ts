/**
 * Logo de ORQEN para la terminal y su pantalla de bienvenida animada.
 *
 * El isotipo (hexágono "Q") no es arte ASCII fijo: se dibuja por código en un lienzo de píxeles usando medios
 * bloques (▀ con color de frente y de fondo → 2 píxeles por celda, casi cuadrados) y antialiasing por intensidad.
 * Eso permite movimiento real y fluido: el trazo se dibuja solo, el degradado de la marca
 * (Azul Eléctrico #2563FF → Magenta Vivo #FF2D9A) gira, un cometa recorre el anillo, el hexágono "respira"
 * y tres satélites (los agentes) orbitan alrededor. "ORQEN" se revela con un barrido y después lo cruza un destello.
 *
 * Todo se calcula según el tiempo transcurrido (no por número de cuadro) y solo se reescriben los tramos de pantalla
 * que cambiaron, así que corre a ~60 fps sin acumular lag. Sin TTY / NO_COLOR / CI / terminal angosta: logo estático.
 */
import { emitKeypressEvents } from "node:readline";

type RGB = [number, number, number];
const AZUL: RGB = [0x25, 0x63, 0xff];
const MAGENTA: RGB = [0xff, 0x2d, 0x9a];
const GRIS: RGB = [0x94, 0xa3, 0xb8];
const BLANCO: RGB = [0xf4, 0xf6, 0xfa];

/** Isotipo en caracteres, solo para la versión sin color. */
const ISO = [
  "     ▄▄████▄▄     ",
  " ▄▄██▀▀    ▀▀██▄▄ ",
  " ██            ██ ",
  " ██            ██ ",
  " ██        ▄▄  ██ ",
  " ▀▀██▄▄    ▀███▀▀ ",
  "     ▀▀████▀▀██▄  ",
];

const LETRAS = [
  " ██████╗ ██████╗  ██████╗ ███████╗███╗   ██╗",
  "██╔═══██╗██╔══██╗██╔═══██╗██╔════╝████╗  ██║",
  "██║   ██║██████╔╝██║   ██║█████╗  ██╔██╗ ██║",
  "██║   ██║██╔══██╗██║▄▄ ██║██╔══╝  ██║╚██╗██║",
  "╚██████╔╝██║  ██║╚██████╔╝███████╗██║ ╚████║",
  " ╚═════╝ ╚═╝  ╚═╝ ╚══▀▀═╝ ╚══════╝╚═╝  ╚═══╝",
  "      A U T O N O M O U S   S Y S T E M S   ",
];

const LEMA = "Del requerimiento a producción.";
const SUB = "La capa que coordina el desarrollo autónomo.";

/* Geometría (en celdas y en píxeles del lienzo del isotipo) */
const MARGEN = 2;
const ISO_COLS = 22, FILAS = 10;                 // lienzo del isotipo: 22 × 20 px
const PX_W = ISO_COLS, PX_H = FILAS * 2;
const X_TEXTO = MARGEN + ISO_COLS + 2;            // columna (0-based) donde empieza "ORQEN"
const FILA_TEXTO = 2;                             // fila del lienzo donde empieza "ORQEN"
const ANCHO_TEXTO = LETRAS[0].length;
const ANCHO = X_TEXTO + ANCHO_TEXTO;
const CX = 11, CY = 10;                           // centro del hexágono (px)
const APOTEMA = 6.9, GROSOR = 2.5;

export function hayColor(stream: NodeJS.WriteStream = process.stdout): boolean {
  if (process.env.NO_COLOR || process.env.ORQEN_SIN_COLOR) return false;
  if (process.env.FORCE_COLOR) return true;
  return !!stream.isTTY;
}

const limitar = (v: number, a = 0, b = 1) => Math.max(a, Math.min(b, v));
const mezclar = (a: RGB, b: RGB, t: number): RGB => a.map((v, i) => Math.round(v + (b[i] - v) * limitar(t))) as RGB;
const atenuar = (c: RGB, k: number): RGB => c.map((v) => Math.round(v * limitar(k))) as RGB;
const marca = (u: number): RGB => mezclar(AZUL, MAGENTA, u);
const pintar = ([r, g, b]: RGB, s: string) => `\x1b[38;2;${r};${g};${b}m${s}`;
const RESET = "\x1b[0m";
const suaveSalida = (t: number) => 1 - Math.pow(1 - limitar(t), 3);
const suaveEntradaSalida = (t: number) => { const x = limitar(t); return x * x * (3 - 2 * x); };
const frac = (v: number) => ((v % 1) + 1) % 1;

/* ───────────────────────── Isotipo por píxeles ───────────────────────── */

interface EstadoIso {
  /** Segundos de animación; `undefined` = pose de reposo (logo estático). */
  t?: number;
}

/** Distancia con signo al hexágono de vértice arriba y apotema `a` (negativa adentro). */
function sdHex(x: number, y: number, a: number) {
  const ax = Math.abs(x), ay = Math.abs(y);
  return Math.max(ax, ax * 0.5 + ay * 0.8660254) - a;
}

/** Distancia a un segmento (cápsula). */
function sdSegmento(x: number, y: number, x1: number, y1: number, x2: number, y2: number) {
  const dx = x2 - x1, dy = y2 - y1;
  const h = limitar(((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy));
  return Math.hypot(x - x1 - dx * h, y - y1 - dy * h);
}

const SATELITES = [
  { vel: 1.55, fase: 0.4, color: BLANCO, rx: 10.2, ry: 9.2 },
  { vel: -1.05, fase: 2.6, color: MAGENTA, rx: 10.4, ry: 9.4 },
  { vel: 0.8, fase: 4.4, color: AZUL, rx: 9.9, ry: 9.0 },
] as const;

/** Color (premultiplicado sobre negro) de cada píxel del isotipo. */
function pixelesIso({ t }: EstadoIso): Float32Array {
  const buf = new Float32Array(PX_W * PX_H * 3);
  const reposo = t === undefined;
  const tt = t ?? 0;
  const respiro = reposo ? 0 : 0.22 * Math.sin(tt * 1.7);
  const trazo = reposo ? 1 : suaveEntradaSalida(tt / 0.95);          // cuánto del anillo ya se dibujó (0..1)
  const cola = reposo ? 1 : suaveSalida((tt - 0.85) / 0.35);         // la colita de la Q
  const cometa = reposo ? -1 : frac(tt / 2.6);
  const sat = reposo ? 0 : limitar((tt - 1.2) / 0.8);
  const aMedio = APOTEMA + respiro - GROSOR / 2;

  for (let py = 0; py < PX_H; py++) {
    for (let px = 0; px < PX_W; px++) {
      const x = px + 0.5 - CX, y = py + 0.5 - CY;
      const ang = frac(Math.atan2(x, -y) / (Math.PI * 2));           // 0 arriba, crece en sentido horario
      let r = 0, g = 0, b = 0;

      // Anillo hexagonal
      let cob = limitar(0.5 - (Math.abs(sdHex(x, y, aMedio)) - GROSOR / 2));
      if (cob > 0 && trazo < 1) cob *= limitar((trazo * 1.04 - ang) * 30);   // borde blando del trazo que avanza
      // Colita de la Q (crece desde adentro hacia afuera)
      const x2 = 2.1 + 4.2 * cola, y2 = 3.0 + 5.2 * cola;
      const cobCola = cola > 0 ? limitar(0.5 - (sdSegmento(x, y, 2.1, 3.0, x2, y2) - 1.15)) : 0;
      const c = Math.max(cob, cobCola);
      if (c > 0) {
        // Reposo: degradado diagonal de la marca. Animado: el degradado gira alrededor del hexágono.
        const u = reposo ? limitar((x + y) / 22 + 0.5) : 0.5 + 0.5 * Math.sin(Math.PI * 2 * (ang - tt / 4.2));
        let col = marca(u);
        if (!reposo) {
          const punta = trazo < 1 ? limitar(1 - Math.abs(trazo * 1.04 - ang) * 14) : 0;   // la punta del trazo brilla
          const estela = cob > 0 && trazo >= 1 ? Math.exp(-frac(cometa - ang) * 11) : 0;   // cometa con estela
          col = mezclar(col, [255, 255, 255], Math.max(punta, estela * 0.85));
        }
        r = col[0] * c; g = col[1] * c; b = col[2] * c;
      }

      // Satélites en órbita, con estela
      if (sat > 0) for (const s of SATELITES) {
        for (let k = 0; k < 7; k++) {
          const a = s.fase + s.vel * (tt - k * 0.045);
          const d = Math.hypot(x - Math.sin(a) * s.rx, y + Math.cos(a) * s.ry);
          const i = limitar(1.05 - d) * sat * (1 - k / 7) ** 1.6;
          if (i > 0) { r = Math.max(r, s.color[0] * i); g = Math.max(g, s.color[1] * i); b = Math.max(b, s.color[2] * i); }
        }
      }
      const o = (py * PX_W + px) * 3;
      buf[o] = r; buf[o + 1] = g; buf[o + 2] = b;
    }
  }
  return buf;
}

/** Convierte los píxeles en FILAS líneas de medios bloques (cada una, ISO_COLS celdas). */
function filasIso(estado: EstadoIso): string[] {
  const buf = pixelesIso(estado);
  const out: string[] = [];
  for (let fila = 0; fila < FILAS; fila++) {
    let s = "", fg = "", bg = "";
    for (let col = 0; col < ISO_COLS; col++) {
      const a = ((fila * 2) * PX_W + col) * 3, b = ((fila * 2 + 1) * PX_W + col) * 3;
      const arriba = Math.max(buf[a], buf[a + 1], buf[a + 2]) >= 16, abajo = Math.max(buf[b], buf[b + 1], buf[b + 2]) >= 16;
      const ca = `${Math.round(buf[a])};${Math.round(buf[a + 1])};${Math.round(buf[a + 2])}`;
      const cb = `${Math.round(buf[b])};${Math.round(buf[b + 1])};${Math.round(buf[b + 2])}`;
      if (!arriba && !abajo) { if (bg) { s += "\x1b[49m"; bg = ""; } s += " "; continue; }
      const quiereFg = arriba ? ca : cb, quiereBg = arriba && abajo ? cb : "";
      if (quiereBg !== bg) { s += quiereBg ? `\x1b[48;2;${quiereBg}m` : "\x1b[49m"; bg = quiereBg; }
      if (quiereFg !== fg) { s += `\x1b[38;2;${quiereFg}m`; fg = quiereFg; }
      s += arriba ? "▀" : "▄";
    }
    out.push(s + RESET);
  }
  return out;
}

/* ───────────────────────── "ORQEN" ───────────────────────── */

/** Una fila del bloque de texto (i = índice en LETRAS) en el instante t; `undefined` = reposo. */
function filaTexto(i: number, t?: number): string {
  const esSub = i === LETRAS.length - 1;
  let s = "", ultimo = "";
  [...LETRAS[i]].forEach((ch, x) => {
    if (ch === " ") { s += " "; return; }
    let color: RGB = esSub ? GRIS : BLANCO;
    if (t !== undefined) {
      const nace = esSub ? 1.45 + x * 0.014 : 0.45 + (x / ANCHO_TEXTO) * 0.75;
      const edad = t - nace;
      if (edad < 0) { s += " "; return; }
      // Nace con el color de la marca y se enfría a blanco.
      color = mezclar(marca(x / ANCHO_TEXTO), color, edad / 0.55);
      if (!esSub && edad < 0.09) ch = "▓";                                  // el frente del barrido, más "pixelado"
      // Destello periódico con los colores de la marca.
      const ciclo = 3.6, frente = -14 + ((Math.max(0, t - 2.4) % ciclo) / ciclo) * (ANCHO_TEXTO + 60);
      const k = suaveEntradaSalida(1 - Math.abs(x + i * 1.5 - frente) / 8);
      if (t > 2.4 && k > 0) color = mezclar(color, marca(x / ANCHO_TEXTO), k * 0.9);
    }
    const clave = color.join(";");
    if (clave !== ultimo) { s += `\x1b[38;2;${clave}m`; ultimo = clave; }
    s += ch;
  });
  return s + RESET;
}

function lineaLema(color: boolean, brillo = 1): string {
  return color
    ? `  \x1b[1m${pintar(atenuar(MAGENTA, brillo), "//")}${pintar(atenuar(BLANCO, brillo), ` ${LEMA}`)}${RESET}  ${pintar(atenuar(GRIS, brillo), SUB)}${RESET}`
    : `  // ${LEMA}  ${SUB}`;
}

/* ───────────────────────── Logo estático ───────────────────────── */

/** Filas del logo en color (isotipo por píxeles + texto) para el instante t, o en reposo. */
function filasLogo(t?: number): { iso: string[]; texto: string[] } {
  const texto = Array.from({ length: FILAS }, (_, f) => {
    const i = f - FILA_TEXTO;
    return i >= 0 && i < LETRAS.length ? filaTexto(i, t) : "";
  });
  return { iso: filasIso({ t }), texto };
}

/** Logo estático (multilínea). Sin color usa el isotipo en caracteres. */
export function logo(color = hayColor()): string {
  if (!color) {
    const filas = ISO.map((iso, i) => `  ${iso}   ${LETRAS[i]}`);
    return ["", ...filas, "", lineaLema(false), ""].join("\n");
  }
  const { iso, texto } = filasLogo();
  return ["", ...iso.map((l, f) => `${" ".repeat(MARGEN)}${l}  ${texto[f]}`), "", lineaLema(true), ""].join("\n");
}

/** Versión para terminales angostas. */
function logoCompacto(color: boolean, columnas: number): string {
  if (columnas >= ANCHO_TEXTO + 4) {
    const filas = LETRAS.map((l, i) => `  ${color ? pintar(i === LETRAS.length - 1 ? GRIS : mezclar(AZUL, MAGENTA, i / LETRAS.length), l) + RESET : l}`);
    return ["", ...filas, ""].join("\n");
  }
  return color ? `\n  \x1b[1m${pintar(AZUL, "OR")}${pintar(mezclar(AZUL, MAGENTA, 0.5), "Q")}${pintar(MAGENTA, "EN")}${RESET}  ${pintar(GRIS, LEMA)}${RESET}\n` : `\n  ORQEN  ${LEMA}\n`;
}

export function puedeAnimar(stream: NodeJS.WriteStream = process.stdout): boolean {
  return !!stream.isTTY && hayColor(stream) && !process.env.CI && !process.env.ORQEN_SIN_ANIMACION
    && process.env.TERM !== "dumb" && (stream.columns ?? 80) >= ANCHO + 2 && (stream.rows ?? 24) >= 22;
}

/* ───────────────────────── Pantalla animada ───────────────────────── */

export interface OpcionesLogo {
  /** Animar (si la terminal lo permite). */
  animar?: boolean;
  /** Seguir en loop hasta que la persona presione Enter (pantalla de bienvenida). */
  esperarTecla?: boolean;
  /** Líneas de bienvenida debajo del lema (solo mientras se espera la tecla). */
  bienvenida?: string[];
  stream?: NodeJS.WriteStream;
  entrada?: NodeJS.ReadStream;
}

/**
 * Tramos de pantalla para el instante t. Cada línea es una lista de tramos [columna (1-based), contenido];
 * el renderizador solo reescribe los tramos cuyo contenido cambió respecto del cuadro anterior.
 * Expuesto para tests.
 */
export function escena(t: number, bienvenida: string[] = [], conTecla = false): [number, string][][] {
  const { iso, texto } = filasLogo(t);
  const lineas: [number, string][][] = iso.map((l, f) => [[MARGEN + 1, l], [X_TEXTO + 1, texto[f]]]);
  lineas.push([[1, ""]]);
  lineas.push([[1, t > 1.7 ? lineaLema(true, (t - 1.7) / 0.5) : ""]]);
  if (conTecla) {
    lineas.push([[1, ""]]);
    bienvenida.forEach((b, i) => {
      const k = limitar((t - 2.1 - i * 0.16) / 0.45);
      lineas.push([[1, k > 0 ? `  ${pintar(atenuar(i === 0 ? BLANCO : GRIS, k), b)}${RESET}` : ""]]);
    });
    lineas.push([[1, ""]]);
    const inicio = 2.3 + bienvenida.length * 0.16;
    const pulso = 0.6 + 0.4 * Math.sin((t - inicio) * 3);
    lineas.push([[1, t > inicio ? `  ${pintar(atenuar(marca(0.5 + 0.5 * Math.sin(t * 1.3)), pulso), "▸")} ${pintar(atenuar(BLANCO, 0.55 + 0.45 * pulso), "Enter para comenzar")}${RESET}` : ""]]);
  }
  return lineas;
}

/**
 * Muestra el logo. Con terminal interactiva lo anima a ~60 fps y, si `esperarTecla`, queda en loop hasta Enter.
 * Al terminar deja el logo estático en pantalla (queda en el historial de la terminal).
 */
export async function mostrarLogo(o: OpcionesLogo | boolean = {}): Promise<void> {
  const op: OpcionesLogo = typeof o === "boolean" ? { animar: o } : o;
  const stream = op.stream ?? process.stdout, entrada = op.entrada ?? process.stdin;
  const color = hayColor(stream);
  const columnas = stream.columns ?? 80;
  if (stream.isTTY && columnas < ANCHO + 2) { stream.write(logoCompacto(color, columnas) + "\n"); return; }
  if (op.animar === false || !puedeAnimar(stream)) { stream.write(logo(color) + "\n"); return; }

  const loop = !!op.esperarTecla && !!entrada.isTTY;
  const bienvenida = loop ? op.bienvenida ?? [] : [];
  let terminar = false, salir = false;
  // Eventos `keypress` de readline (el mismo mecanismo que usan los prompts que vienen después):
  // mezclar un listener crudo de `data` rompe flechas y espacio en Windows.
  const alTeclear = (_s: string, tecla: { name?: string; ctrl?: boolean } = {}) => {
    if (tecla.ctrl && tecla.name === "c") { salir = true; terminar = true; }
    else if (tecla.name === "return" || tecla.name === "enter" || tecla.name === "space") terminar = true;
  };
  const alRedimensionar = () => { terminar = true; };
  const restaurar = () => stream.write("\x1b[?25h");
  process.once("exit", restaurar);
  if (loop) { emitKeypressEvents(entrada); entrada.setRawMode(true); entrada.resume(); entrada.on("keypress", alTeclear); }
  stream.on("resize", alRedimensionar);

  const total = escena(0, bienvenida, loop).length;
  const previo: string[][] = [];
  const inicio = performance.now();
  const INTERVALO = 1000 / 60;
  let proximo = inicio;
  try {
    stream.write("\x1b[?25l\n" + "\n".repeat(total));
    for (;;) {
      const ahora = performance.now();
      const t = (ahora - inicio) / 1000;
      if (terminar || (!loop && t > 2.6)) break;
      // Si la terminal todavía no terminó de dibujar el cuadro anterior, este se saltea (no se acumula lag).
      if (ahora >= proximo && !stream.writableNeedDrain) {
        proximo = Math.max(proximo + INTERVALO, ahora);
        let salida = "";
        escena(t, bienvenida, loop).forEach((tramos, f) => {
          tramos.forEach(([col, texto], k) => {
            if (previo[f]?.[k] === texto) return;
            (previo[f] ??= [])[k] = texto;
            // Último tramo de la línea: limpia lo que quede a la derecha.
            salida += `\x1b[${total - f}A\x1b[${col}G${texto}${k === tramos.length - 1 ? "\x1b[K" : ""}\x1b[${total - f}B`;
          });
        });
        // 2026: salida sincronizada (la terminal presenta el cuadro entero de una vez, sin tearing).
        if (salida) stream.write(`\x1b[?2026h${salida}\r\x1b[?2026l`);
      }
      // En Windows el timer avanza de a ~15,6 ms: pedir 1 ms da ~64 fps estables. En el resto, dormir hasta el próximo cuadro.
      await new Promise((r) => setTimeout(r, process.platform === "win32" ? 1 : Math.max(1, proximo - performance.now())));
    }
  } finally {
    if (loop) { entrada.off("keypress", alTeclear); entrada.setRawMode(false); entrada.pause(); }
    stream.off("resize", alRedimensionar);
    // Cuadro final: el logo en reposo; se borra la bienvenida y el cursor queda justo debajo del lema.
    const final = logo(true).split("\n").slice(1);
    stream.write(`\x1b[${total}A\r` + final.map((l) => `${l}\x1b[K\n`).join("") + "\x1b[J");
    restaurar();
    process.removeListener("exit", restaurar);
  }
  if (salir) { stream.write("\n"); process.exit(130); }
}

export function imprimirLogo() {
  process.stdout.write(logo() + "\n");
}
