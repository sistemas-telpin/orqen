/**
 * ORQEN terminal logo and animated welcome screen.
 *
 * Draw the hexagon and wordmark on a pixel canvas using two pixels per
 * terminal cell, with foreground and background colors on the upper half block (▀).
 * The scene is rendered in real time.
 *
 *   Intro: particles converge, the hexagon rotates into view, and a flash and halo
 *           highlight the wordmark with a blue and magenta color shift.
 *   Loop: a rotating gradient, comet trail, pulsing halo, orbiting satellites,
 *           parallax stars, and an underline pulse. The hexagon rotates again
 *           every few seconds and sends another wave across the wordmark.
 *
 * Animation uses elapsed time and redraws only changed screen segments.
 * Non-interactive, NO_COLOR, CI, and small terminals use the static logo.
 */
import { emitKeypressEvents } from "node:readline";

type RGB = [number, number, number];
const AZUL: RGB = [0x25, 0x63, 0xff];
const MAGENTA: RGB = [0xff, 0x2d, 0x9a];
const GRIS: RGB = [0x94, 0xa3, 0xb8];
const BLANCO: RGB = [0xf4, 0xf6, 0xfa];

const LEMA = "From request to production.";
const SUB = "Orchestrate autonomous development.";
const SUBTITULO = "AI Software Factory KIT";

/* ───────────────────────── utilidades ───────────────────────── */

export function hayColor(stream: NodeJS.WriteStream = process.stdout): boolean {
  if (process.env.NO_COLOR || process.env.ORQEN_SIN_COLOR) return false;
  if (process.env.FORCE_COLOR) return true;
  return !!stream.isTTY;
}

const limitar = (v: number, a = 0, b = 1) => (v < a ? a : v > b ? b : v);
const mezclar = (a: RGB, b: RGB, t: number): RGB => { const k = limitar(t); return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k]; };
const atenuar = (c: RGB, k: number): RGB => { const q = limitar(k); return [c[0] * q, c[1] * q, c[2] * q]; };
const marca = (u: number): RGB => mezclar(AZUL, MAGENTA, u);
const rgb = (c: RGB) => `${Math.round(c[0])};${Math.round(c[1])};${Math.round(c[2])}`;
const pintar = (c: RGB, s: string) => `\x1b[38;2;${rgb(c)}m${s}`;
const RESET = "\x1b[0m";
const frac = (v: number) => ((v % 1) + 1) % 1;
const salidaCubica = (t: number) => 1 - Math.pow(1 - limitar(t), 3);
const entradaCubica = (t: number) => Math.pow(limitar(t), 3);
const entradaSalida = (t: number) => { const x = limitar(t); return x * x * (3 - 2 * x); };
const salidaRebote = (t: number) => { const x = limitar(t) - 1; return 1 + 2.2 * x * x * x + 1.2 * x * x; };   // easeOutBack

function azar(semilla: number) {
  let s = semilla >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

/* ───────────────────────── canvas geometry ───────────────────────── */

const W = 90, FILAS = 12, H = FILAS * 2;          // 90 × 24 px
const CX = 13, CY = 12;                           // hexagon center
const APOTEMA = 6.9, GROSOR = 2.5;
const X0 = 28, Y0 = 5;                            // Wordmark origin.
const LETRA_W = 10, LETRA_H = 12, PASO = 12;
const ANCHO_PALABRA = PASO * 4 + LETRA_W;         // 58
const Y_SUBRAYADO = 19;                           // px
const FILA_SUBTITULO = 10;
const COL_SUBTITULO = X0 + Math.floor((ANCHO_PALABRA - SUBTITULO.length) / 2);

/** Pixel font for ORQEN (10 × 12 with a 3-pixel stroke). */
const FUENTE = [
  ["..######..", ".########.", "##########", "###....###", "###....###", "###....###", "###....###", "###....###", "###....###", "##########", ".########.", "..######.."],
  ["########..", "#########.", "##########", "###....###", "###....###", "#########.", "########..", "###.###...", "###..###..", "###...###.", "###....###", "###....###"],
  ["..######..", ".########.", "##########", "###....###", "###....###", "###....###", "###....###", "###.##.###", "###..#####", "#########.", ".#########", "..####.###"],
  ["##########", "##########", "##########", "###.......", "###.......", "########..", "########..", "###.......", "###.......", "##########", "##########", "##########"],
  ["###....###", "####...###", "#####..###", "#####..###", "######.###", "###.######", "###.######", "###..#####", "###..#####", "###...####", "###....###", "###....###"],
];
/** Check if the wordmark covers a canvas pixel. */
function tinta(x: number, y: number): boolean {
  const lx = x - X0, ly = y - Y0;
  if (lx < 0 || ly < 0 || ly >= LETRA_H || lx >= ANCHO_PALABRA) return false;
  const col = lx % PASO;
  return col < LETRA_W && FUENTE[(lx / PASO) | 0][ly][col] === "#";
}

function sdHex(x: number, y: number, a: number) {
  const ax = Math.abs(x), ay = Math.abs(y);
  return Math.max(ax, ax * 0.5 + ay * 0.8660254) - a;
}
function sdSegmento(x: number, y: number, x1: number, y1: number, x2: number, y2: number) {
  const dx = x2 - x1, dy = y2 - y1;
  const h = limitar(((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy || 1));
  return Math.hypot(x - x1 - dx * h, y - y1 - dy * h);
}

/* ───────────────────────── guion (segundos) ───────────────────────── */

const T_HEX = 0.7;          // Hexagon entry starts.
const T_IMPACTO = 1.5;      // queda armado: destello + primera onda
const CICLO = 6.5;          // Time between rotations and waves.
const T_GIRO = 1.1;         // Duration of the rotation before each wave.
const VEL_ONDA = 105;       // px/s
const DUR_ONDA = 1.15;
const T_LISTO = 2.9;        // todo armado

const ESCENA = (() => {
  const rnd = azar(0x0c9e);
  const estrellas = Array.from({ length: 52 }, () => {
    const capa = rnd() < 0.6 ? 0 : 1;
    return { x: rnd() * W, y: rnd() * H, vel: capa ? 3.4 + rnd() * 2 : 1.1 + rnd(), brillo: capa ? 0.34 + rnd() * 0.2 : 0.16 + rnd() * 0.12, fase: rnd() * 6.28, tono: rnd() };
  });
  const agentes = Array.from({ length: 20 }, (_, i) => {
    const ang = (i / 20) * Math.PI * 2 + rnd() * 0.3, dist = 26 + rnd() * 44;
    return { x: CX + Math.cos(ang) * dist * 1.5, y: CY + Math.sin(ang) * dist * 0.5, llega: 0.5 + rnd() * 0.5, tono: i / 20, curva: (rnd() - 0.5) * 14 };
  });
  const satelites = [
    { vel: 1.5, fase: 0.4, color: BLANCO, radio: 10.2, achate: 0.42, incl: -0.5 },
    { vel: -1.05, fase: 2.6, color: MAGENTA, radio: 10.4, achate: 0.5, incl: 0.75 },
    { vel: 0.78, fase: 4.4, color: AZUL, radio: 9.8, achate: 0.34, incl: 1.45 },
  ];
  return { estrellas, agentes, satelites };
})();

/* ───────────────────────── frame rendering ───────────────────────── */

/** Canvas pixels are RGB premultiplied over black. Undefined time renders the static pose. */
function pixeles(t?: number): Float32Array {
  const buf = new Float32Array(W * H * 3);
  const reposo = t === undefined;
  const tt = t ?? 1e3;
  const poner = (px: number, py: number, c: RGB, k: number) => {
    if (k <= 0 || px < 0 || py < 0 || px >= W || py >= H) return;
    const o = (py * W + px) * 3;
    if (c[0] * k > buf[o]) buf[o] = c[0] * k;
    if (c[1] * k > buf[o + 1]) buf[o + 1] = c[1] * k;
    if (c[2] * k > buf[o + 2]) buf[o + 2] = c[2] * k;
  };
  /** Draw an antialiased disk with a subpixel center. */
  const disco = (x: number, y: number, radio: number, c: RGB, k: number) => {
    if (k <= 0.02) return;
    for (let py = Math.floor(y - radio - 1); py <= y + radio + 1; py++)
      for (let px = Math.floor(x - radio - 1); px <= x + radio + 1; px++)
        poner(px, py, c, limitar(radio + 0.5 - Math.hypot(px + 0.5 - x, py + 0.5 - y)) * k);
  };

  // Active waves at impact and once per cycle.
  const ondas: number[] = [];
  if (!reposo) for (let n = Math.max(0, Math.floor((tt - T_IMPACTO) / CICLO) - 1); ; n++) {
    const tn = T_IMPACTO + n * CICLO;
    if (tn > tt) break;
    ondas.push(tn);
  }
  const ultimaOnda = ondas.at(-1) ?? Infinity;

  // ── Background parallax stars ──
  if (!reposo) {
    const entrada = limitar(tt / 1.2);
    for (const e of ESCENA.estrellas) {
      const x = (((e.x - tt * e.vel) % W) + W) % W;
      const b = e.brillo * (0.65 + 0.35 * Math.sin(tt * 1.7 + e.fase)) * entrada;
      const c = mezclar(GRIS, marca(e.tono), 0.5);
      const xi = Math.floor(x), f = x - xi, y = e.y | 0;                    // Interpolate brightness between adjacent pixels.
      poner(xi, y, c, b * (1 - f)); poner((xi + 1) % W, y, c, b * f);
    }
  }

  // ── Intro: particles converge at the center ──
  if (!reposo && tt < 1.2) for (const a of ESCENA.agentes) {
    for (let k = 0; k < 6; k++) {
      const p = entradaCubica((tt - k * 0.035) / a.llega);
      if (p <= 0 || p >= 1) continue;
      const lado = Math.sin(p * Math.PI) * a.curva;                          // trayectoria apenas curva
      const x = a.x + (CX - a.x) * p + lado * 0.6, y = a.y + (CY - a.y) * p - lado * 0.25;
      disco(x, y, 0.55, mezclar(marca(a.tono), BLANCO, p * 0.6), (0.35 + 0.65 * p) * (1 - k / 6));
    }
  }

  // ── Hexagon entry scale, rotation, and halo ──
  const escala = reposo ? 1 : tt < T_HEX ? 0 : salidaRebote((tt - T_HEX) / 0.75);
  let giro = 0;
  if (!reposo) {
    if (tt < T_IMPACTO + 0.2) giro = (1 - salidaCubica((tt - T_HEX) / (T_IMPACTO - T_HEX + 0.2))) * Math.PI * 3;
    else {
      const enCiclo = (tt - T_IMPACTO) % CICLO;                              // The rotation finishes when the wave begins.
      if (enCiclo > CICLO - T_GIRO) giro = entradaSalida((enCiclo - (CICLO - T_GIRO)) / T_GIRO) * Math.PI * 2;
    }
  }
  const cosGiro = Math.cos(giro);
  const sx = Math.max(Math.abs(cosGiro), 0.07);
  const desdeOnda = tt - ultimaOnda;
  const destello = reposo ? 0 : desdeOnda >= 0 ? Math.exp(-desdeOnda * 3.6) : 0;
  const halo = reposo ? 0.1 : (0.17 + 0.06 * Math.sin(tt * 1.9) + 0.75 * destello) * limitar(escala);
  const respiro = reposo ? 0 : 0.2 * Math.sin(tt * 1.7);
  const cola = reposo ? 1 : salidaCubica((tt - (T_IMPACTO - 0.1)) / 0.4);
  const cometa = reposo || tt < T_IMPACTO ? -1 : frac(tt / 2.6);
  const luz = 0.6 + 0.4 * sx;                                               // Darken the hexagon when viewed edge-on.
  const aMedio = APOTEMA + respiro - GROSOR / 2;

  // ── Project satellites into screen space and draw the far side before the ring. ──
  const entradaSat = reposo ? 0 : limitar((tt - 1.9) / 0.9);
  const dibujarSatelites = (frente: boolean) => {
    if (entradaSat <= 0) return;
    for (const s of ESCENA.satelites) for (let k = 0; k < 8; k++) {
      const a = s.fase + s.vel * (tt - k * 0.04);
      const z = Math.sin(a);                                                 // > 0: in front of the hexagon
      if ((z > 0) !== frente) continue;
      const ex = Math.cos(a) * s.radio, ey = z * s.radio * s.achate;
      const x = CX + ex * Math.cos(s.incl) - ey * Math.sin(s.incl), y = CY + ex * Math.sin(s.incl) + ey * Math.cos(s.incl);
      disco(x, y, 0.5 + 0.25 * (z + 1), s.color, entradaSat * (0.5 + 0.5 * (z + 1) / 2) * Math.pow(1 - k / 8, 1.5));
    }
  };
  dibujarSatelites(false);

  // ── Hexagon halo, ring, and Q tail ──
  if (escala > 0.02) for (let py = 0; py < H; py++) for (let px = 0; px < X0 - 1; px++) {
    const x = (px + 0.5 - CX) / (sx * escala), y = (py + 0.5 - CY) / escala;
    const k = escala * Math.max(sx, 0.4);                                    // Convert hexagon units to pixels as it rotates.
    const dAnillo = (Math.abs(sdHex(x, y, aMedio)) - GROSOR / 2) * k;
    const xc = 2.1 + 4.2 * cola, yc = 3.0 + 5.2 * cola;
    const dCola = cola > 0 ? (sdSegmento(x, y, 2.1, 3.0, xc, yc) - 1.15) * k : 99;
    const d = Math.min(dAnillo, dCola);
    const ang = frac(Math.atan2(x, -y) / (Math.PI * 2));
    const u = reposo ? limitar((x + y) / 22 + 0.5) : 0.5 + 0.5 * Math.sin(Math.PI * 2 * (ang - tt / 4.2));
    let col = marca(u);
    if (d < 9) poner(px, py, col, Math.exp(-Math.max(d, 0) / 2.1) * halo * luz);                      // halo
    const cob = limitar(0.5 - d);
    if (cob > 0) {
      if (cometa >= 0 && dAnillo < dCola) col = mezclar(col, [255, 255, 255], Math.exp(-frac(cometa - ang) * 11) * 0.85);
      col = mezclar(col, [255, 255, 255], destello * 0.7);
      const o = (py * W + px) * 3, q = cob * luz;                            // The ring covers pixels behind it.
      buf[o] = buf[o] * (1 - cob) + col[0] * q; buf[o + 1] = buf[o + 1] * (1 - cob) + col[1] * q; buf[o + 2] = buf[o + 2] * (1 - cob) + col[2] * q;
    }
  }
  dibujarSatelites(true);

  // ── Waves light the ORQEN letters with a chromatic shift ──
  for (let py = Y0 - 4; py < Y0 + LETRA_H + 4; py++) for (let px = X0 - 6; px < X0 + ANCHO_PALABRA + 6; px++) {
    if (px < 0 || px >= W || py < 0 || py >= H) continue;
    if (reposo) { if (tinta(px, py)) poner(px, py, BLANCO, 1); continue; }
    const dist = Math.hypot(px + 0.5 - CX, py + 0.5 - CY);
    const edad = tt - (T_IMPACTO + dist / VEL_ONDA);                         // Time since the first wave reached this pixel.
    if (edad < -0.12) continue;
    const e = limitar(edad / 0.5);
    // Later waves produce a fading color flash.
    let flash = 0;
    for (const tn of ondas) if (tn > T_IMPACTO) { const d2 = tt - (tn + dist / VEL_ONDA); if (d2 >= 0) flash = Math.max(flash, Math.exp(-d2 * 4.2)); }
    const corr = Math.round(5 * (1 - e) * (1 - e) + 2 * flash);              // Blue and magenta separation.
    const sube = Math.round(3 * (1 - salidaCubica(e)));
    const u = (px - X0) / ANCHO_PALABRA;
    if (corr > 0) {
      const fantasma = Math.max((1 - e) * 0.95, flash * 0.75);
      if (tinta(px + corr, py + sube)) poner(px, py, AZUL, fantasma);
      if (tinta(px - corr, py + sube)) poner(px, py, MAGENTA, fantasma);
    }
    if (edad >= 0 && tinta(px, py + sube)) {
      // Color sweep between waves.
      const frente = -20 + frac((tt - T_LISTO) / CICLO + 0.5) * (ANCHO_PALABRA + 90);
      const barrido = tt > T_LISTO ? entradaSalida(1 - Math.abs(px - X0 + (py - Y0) * 1.3 - frente) / 9) : 0;
      poner(px, py, mezclar(mezclar(marca(u), BLANCO, e), marca(u), Math.max(flash * 0.95, barrido * 0.85)), Math.pow(e, 0.5));
    }
  }

  // ── Traveling underline pulse ──
  {
    const p = reposo ? 1 : salidaCubica((tt - 2.1) / 0.7);
    if (p > 0) {
      const pulso = X0 + frac((tt - T_LISTO) / 2.4) * (ANCHO_PALABRA + 16) - 8;
      for (let px = X0; px < X0 + ANCHO_PALABRA * p; px++) {
        const bulto = reposo || tt < T_LISTO ? 0 : Math.exp(-Math.pow((px + 0.5 - pulso) / 3, 2));
        poner(px, Y_SUBRAYADO, mezclar(marca((px - X0) / ANCHO_PALABRA), [255, 255, 255], bulto * 0.8), 0.42 + 0.58 * bulto);
      }
    }
  }

  // ── Ondas expansivas (sobre todo el lienzo) ──
  for (const tn of ondas) {
    const tau = tt - tn;
    if (tau > DUR_ONDA) continue;
    const radio = VEL_ONDA * tau, fuerza = Math.pow(1 - tau / DUR_ONDA, 1.4) * 0.6;
    for (let py = 0; py < H; py++) for (let px = 0; px < W; px++) {
      const banda = 1 - Math.abs(Math.hypot(px + 0.5 - CX, py + 0.5 - CY) - radio) / 2.4;
      if (banda > 0) poner(px, py, marca(0.5 + 0.5 * Math.sin(radio * 0.07)), banda * fuerza);
    }
  }
  return buf;
}

const TRAMO = 6;   // Cells per segment. Redraw only changed segments.

/**
 * Convert the canvas to rows of segments with one-based column positions.
 * Overlay the subtitle as text.
 */
function filasLienzo(t?: number): [number, string][][] {
  const buf = pixeles(t);
  const out: [number, string][][] = [];
  for (let fila = 0; fila < FILAS; fila++) {
    const tramos: [number, string][] = [];
    for (let c0 = 0; c0 < W; c0 += TRAMO) {
      let s = "", fg = "", bg = "";
      for (let col = c0; col < Math.min(W, c0 + TRAMO); col++) {
        // Reveal the subtitle one character at a time.
        if (fila === FILA_SUBTITULO && col >= COL_SUBTITULO && col < COL_SUBTITULO + SUBTITULO.length) {
          const i = col - COL_SUBTITULO, ch = SUBTITULO[i];
          const k = t === undefined ? 1 : limitar((t - 2.35 - i * 0.016) / 0.25);
          if (k > 0) {
            if (bg) { s += "\x1b[49m"; bg = ""; }
            if (ch === " ") { s += " "; continue; }
            const cf = rgb(atenuar(mezclar(marca(i / SUBTITULO.length), GRIS, k), 0.3 + 0.7 * k));
            if (cf !== fg) { s += `\x1b[38;2;${cf}m`; fg = cf; }
            s += ch; continue;
          }
        }
        const a = (fila * 2 * W + col) * 3, b = ((fila * 2 + 1) * W + col) * 3;
        const arriba = Math.max(buf[a], buf[a + 1], buf[a + 2]) >= 13, abajo = Math.max(buf[b], buf[b + 1], buf[b + 2]) >= 13;
        if (!arriba && !abajo) { if (bg) { s += "\x1b[49m"; bg = ""; } s += " "; continue; }
        const ca = `${Math.min(255, Math.round(buf[a]))};${Math.min(255, Math.round(buf[a + 1]))};${Math.min(255, Math.round(buf[a + 2]))}`;
        const cb = `${Math.min(255, Math.round(buf[b]))};${Math.min(255, Math.round(buf[b + 1]))};${Math.min(255, Math.round(buf[b + 2]))}`;
        const qFg = arriba ? ca : cb, qBg = arriba && abajo ? cb : "";
        if (qBg !== bg) { s += qBg ? `\x1b[48;2;${qBg}m` : "\x1b[49m"; bg = qBg; }
        if (qFg !== fg) { s += `\x1b[38;2;${qFg}m`; fg = qFg; }
        s += arriba ? "▀" : "▄";
      }
      tramos.push([c0 + 1, s + RESET]);
    }
    out.push(tramos);
  }
  return out;
}

function lineaLema(color: boolean, brillo = 1): string {
  return color
    ? `  \x1b[1m${pintar(atenuar(MAGENTA, brillo), "//")}${pintar(atenuar(BLANCO, brillo), ` ${LEMA}`)}${RESET}  ${pintar(atenuar(GRIS, brillo), SUB)}${RESET}`
    : `  // ${LEMA}  ${SUB}`;
}

/* ───────────────────────── static logo ───────────────────────── */

/** Text version for terminals without color or with limited width. */
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
  `    ${SUBTITULO}     `,
];
const ANCHO_MEDIO = 2 + ISO[0].length + 3 + LETRAS[0].length;

function logoCaracteres(color: boolean): string {
  const filas = ISO.map((iso, i) => {
    if (!color) return `  ${iso}   ${LETRAS[i]}`;
    let izq = "";
    [...iso].forEach((ch, x) => { izq += ch === " " ? ch : pintar(marca((x + i) / (iso.length + ISO.length)), ch); });
    return `  ${izq}${RESET}   ${pintar(i === ISO.length - 1 ? GRIS : BLANCO, LETRAS[i])}${RESET}`;
  });
  return ["", ...filas, "", lineaLema(color), ""].join("\n");
}

/**
 * Use the pixel canvas for color terminals at least 92 columns wide.
 * Use text on smaller terminals.
 */
export function logo(color = hayColor(), columnas = process.stdout.columns ?? 100): string {
  if (!color || columnas < W + 2) return logoCaracteres(color);
  return ["", ...filasLienzo().map((tramos) => tramos.map(([, s]) => s).join("")), "", lineaLema(true), ""].join("\n");
}

/** Text version for narrow terminals. */
function logoCompacto(color: boolean, columnas: number): string {
  if (columnas >= LETRAS[0].length + 4) {
    const filas = LETRAS.map((l, i) => `  ${color ? pintar(i === LETRAS.length - 1 ? GRIS : mezclar(AZUL, MAGENTA, i / LETRAS.length), l) + RESET : l}`);
    return ["", ...filas, ""].join("\n");
  }
  return color ? `\n  \x1b[1m${pintar(AZUL, "OR")}${pintar(mezclar(AZUL, MAGENTA, 0.5), "Q")}${pintar(MAGENTA, "EN")}${RESET}  ${pintar(GRIS, LEMA)}${RESET}\n` : `\n  ORQEN  ${LEMA}\n`;
}

/* ───────────────────────── pantalla animada ───────────────────────── */

export interface OpcionesLogo {
  /** Animate when the terminal supports it. */
  animar?: boolean;
  /** Loop until the user presses Enter. */
  esperarTecla?: boolean;
  /** Welcome text displayed under the tagline while waiting for Enter. */
  bienvenida?: string[];
  stream?: NodeJS.WriteStream;
  entrada?: NodeJS.ReadStream;
}

/**
 * Render the frame at time t as rows of one-based column positions and text.
 * The renderer redraws changed segments. Exported for tests.
 */
export function escena(t: number, bienvenida: string[] = [], conTecla = false): [number, string][][] {
  const lineas = filasLienzo(t);
  lineas.push([[1, ""]]);
  lineas.push([[1, t > 2.5 ? lineaLema(true, (t - 2.5) / 0.5) : ""]]);
  if (conTecla) {
    lineas.push([[1, ""]]);
    bienvenida.forEach((b, i) => {
      const k = limitar((t - T_LISTO - i * 0.16) / 0.45);
      lineas.push([[1, k > 0 ? `  ${pintar(atenuar(i === 0 ? BLANCO : GRIS, k), b)}${RESET}` : ""]]);
    });
    lineas.push([[1, ""]]);
    const inicio = T_LISTO + 0.2 + bienvenida.length * 0.16;
    const pulso = 0.6 + 0.4 * Math.sin((t - inicio) * 3);
    lineas.push([[1, t > inicio ? `  ${pintar(atenuar(marca(0.5 + 0.5 * Math.sin(t * 1.3)), pulso), "▸")} ${pintar(atenuar(BLANCO, 0.55 + 0.45 * pulso), "Press Enter to begin")}${RESET}` : ""]]);
  }
  return lineas;
}

export function puedeAnimar(stream: NodeJS.WriteStream = process.stdout, lineas = FILAS + 4): boolean {
  return !!stream.isTTY && hayColor(stream) && !process.env.CI && !process.env.ORQEN_SIN_ANIMACION
    && process.env.TERM !== "dumb" && (stream.columns ?? 80) >= W + 2 && (stream.rows ?? 24) >= lineas + 2;
}

/**
 * Show the logo and animate it at roughly 60 fps in an interactive terminal.
 * When waiting for input, loop until Enter, then leave the static logo in the terminal.
 */
export async function mostrarLogo(o: OpcionesLogo | boolean = {}): Promise<void> {
  const op: OpcionesLogo = typeof o === "boolean" ? { animar: o } : o;
  const stream = op.stream ?? process.stdout, entrada = op.entrada ?? process.stdin;
  const color = hayColor(stream);
  const columnas = stream.columns ?? 80;
  if (stream.isTTY && columnas < ANCHO_MEDIO + 2) { stream.write(logoCompacto(color, columnas) + "\n"); return; }

  const loop = !!op.esperarTecla && !!entrada.isTTY;
  const bienvenida = loop ? op.bienvenida ?? [] : [];
  const total = escena(0, bienvenida, loop).length;
  if (op.animar === false || !puedeAnimar(stream, total)) { stream.write(logo(color, columnas) + "\n"); return; }

  let terminar = false, salir = false;
  // Use readline keypress events, as do the prompts that follow.
  // A raw data listener interferes with arrow keys and space on Windows.
  const alTeclear = (_s: string, tecla: { name?: string; ctrl?: boolean } = {}) => {
    if (tecla.ctrl && tecla.name === "c") { salir = true; terminar = true; }
    else if (tecla.name === "return" || tecla.name === "enter" || tecla.name === "space") terminar = true;
  };
  const alRedimensionar = () => { terminar = true; };
  const restaurar = () => stream.write("\x1b[?25h");
  process.once("exit", restaurar);
  if (loop) { emitKeypressEvents(entrada); entrada.setRawMode(true); entrada.resume(); entrada.on("keypress", alTeclear); }
  stream.on("resize", alRedimensionar);

  const previo: string[][] = [];
  const inicio = performance.now();
  const INTERVALO = 1000 / 60;
  let proximo = inicio;
  try {
    stream.write("\x1b[?25l\n" + "\n".repeat(total));
    for (;;) {
      const ahora = performance.now();
      const t = (ahora - inicio) / 1000;
      if (terminar || (!loop && t > T_LISTO + 0.9)) break;
      // Skip this frame if the terminal is still drawing the previous one.
      if (ahora >= proximo && !stream.writableNeedDrain) {
        proximo = Math.max(proximo + INTERVALO, ahora);
        let salida = "";
        escena(t, bienvenida, loop).forEach((tramos, f) => {
          let fila = "";
          tramos.forEach(([col, texto], k) => {
            if (previo[f]?.[k] === texto) return;
            (previo[f] ??= [])[k] = texto;
            // Clear any leftover text to the right.
            fila += `\x1b[${col}G${texto}${tramos.length === 1 ? "\x1b[K" : ""}`;
          });
          if (fila) salida += `\x1b[${total - f}A${fila}\x1b[${total - f}B`;
        });
        // Synchronized output displays each frame at once.
        if (salida) stream.write(`\x1b[?2026h${salida}\r\x1b[?2026l`);
      }
      // Request a 1 ms delay on Windows for its roughly 15.6 ms timer resolution. Elsewhere, wait until the next frame.
      await new Promise((r) => setTimeout(r, process.platform === "win32" ? 1 : Math.max(1, proximo - performance.now())));
    }
  } finally {
    if (loop) { entrada.off("keypress", alTeclear); entrada.setRawMode(false); entrada.pause(); }
    stream.off("resize", alRedimensionar);
    // Leave the static logo, clear the welcome text, and put the cursor below the tagline.
    const final = logo(true, columnas).split("\n").slice(1);
    stream.write(`\x1b[${total}A\r` + final.map((l) => `${l}\x1b[K\n`).join("") + "\x1b[J");
    restaurar();
    process.removeListener("exit", restaurar);
  }
  if (salir) { stream.write("\n"); process.exit(130); }
}

export function imprimirLogo() {
  process.stdout.write(logo() + "\n");
}
