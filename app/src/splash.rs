//! Opening splash: the CLI welcome animation (`cli/src/ui/logo.ts`) redrawn with vectors on the GPU.
//!
//! Same script and the same scene as the terminal version, at full resolution and frame rate:
//!   particles converge → the hexagon spins in with a bounce → flash, shock wave and halo →
//!   the wordmark arrives with a blue/magenta chromatic split → satellites, comet on the ring,
//!   parallax stars, underline pulse, subtitle typed in, tagline.
//! The scene lives in "CLI pixel" units (a 90 × 24 canvas) scaled to the window, so the
//! composition is identical to the terminal one.
use std::f32::consts::{PI, TAU};
use std::sync::OnceLock;

use gpui::{
    App, Bounds, BorderStyle, BoxShadow, Font, FontWeight, Hsla, IntoElement, PathBuilder, Pixels, Point, Rgba, SharedString, Styled,
    TextRun, Window, canvas, FillOptions, FillRule, PathStyle, fill, font, linear_color_stop, linear_gradient, point, px, quad, size, transparent_black,
};

#[cfg(target_os = "macos")]
use crate::theme::UI_FONT;

/// The whole splash, fade-out included (seconds).
pub const DURATION: f32 = 4.0;
/// When the fade-out starts; clicking jumps here.
pub const FADE_AT: f32 = 3.4;

type Rgb = [f32; 3];
const AZUL: Rgb = [0x25 as f32 / 255., 0x63 as f32 / 255., 1.0];
const MAGENTA: Rgb = [1.0, 0x2d as f32 / 255., 0x9a as f32 / 255.];
const GRIS: Rgb = [0x94 as f32 / 255., 0xa3 as f32 / 255., 0xb8 as f32 / 255.];
const BLANCO: Rgb = [0xf4 as f32 / 255., 0xf6 as f32 / 255., 0xfa as f32 / 255.];
const WHITE: Rgb = [1.0, 1.0, 1.0];

const SUBTITULO: &str = "AI SOFTWARE FACTORY KIT";
const LEMA: &str = "From request to production.";
const SUB: &str = "Orchestrate autonomous development.";

/* ───────────────────────── geometry (CLI pixels) ───────────────────────── */

const W: f32 = 90.0;
const H: f32 = 24.0;
const CX: f32 = 13.0;
const CY: f32 = 12.0;
const APOTEMA: f32 = 6.9;
const GROSOR: f32 = 2.5;
const X0: f32 = 28.0;
const Y0: f32 = 5.0;
const LETRA_H: f32 = 12.0;
const PASO: f32 = 12.0;
const ANCHO_PALABRA: f32 = 58.0;
const Y_SUBRAYADO: f32 = 19.0;

/* ───────────────────────── script (seconds) ───────────────────────── */

const T_HEX: f32 = 0.7;
const T_IMPACTO: f32 = 1.5;
const CICLO: f32 = 6.5;
const T_GIRO: f32 = 1.1;
const VEL_ONDA: f32 = 105.0;
const DUR_ONDA: f32 = 1.15;
const T_LISTO: f32 = 2.9;

/* ───────────────────────── helpers ───────────────────────── */

fn limitar(v: f32) -> f32 { v.clamp(0.0, 1.0) }
fn mezclar(a: Rgb, b: Rgb, t: f32) -> Rgb { let k = limitar(t); [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k] }
fn atenuar(c: Rgb, k: f32) -> Rgb { let q = limitar(k); [c[0] * q, c[1] * q, c[2] * q] }
fn marca(u: f32) -> Rgb { mezclar(AZUL, MAGENTA, u) }
fn frac(v: f32) -> f32 { v.rem_euclid(1.0) }
fn salida_cubica(t: f32) -> f32 { 1.0 - (1.0 - limitar(t)).powi(3) }
fn entrada_cubica(t: f32) -> f32 { limitar(t).powi(3) }
fn entrada_salida(t: f32) -> f32 { let x = limitar(t); x * x * (3.0 - 2.0 * x) }
fn salida_rebote(t: f32) -> f32 { let x = limitar(t) - 1.0; 1.0 + 2.2 * x * x * x + 1.2 * x * x }
fn col(c: Rgb, a: f32) -> Hsla { Rgba { r: c[0], g: c[1], b: c[2], a: a.clamp(0.0, 1.0) }.into() }

struct Azar(u32);
impl Azar {
    fn next(&mut self) -> f32 {
        self.0 = self.0.wrapping_mul(1664525).wrapping_add(1013904223);
        self.0 as f32 / 4294967296.0
    }
}

struct Estrella { x: f32, y: f32, vel: f32, brillo: f32, fase: f32, tono: f32, radio: f32 }
struct Agente { x: f32, y: f32, llega: f32, tono: f32, curva: f32 }
struct Satelite { vel: f32, fase: f32, color: Rgb, radio: f32, achate: f32, incl: f32 }
struct Escena { estrellas: Vec<Estrella>, agentes: Vec<Agente>, satelites: [Satelite; 3] }

fn escena() -> &'static Escena {
    static E: OnceLock<Escena> = OnceLock::new();
    E.get_or_init(|| {
        let mut r = Azar(0x0c9e);
        // Stars cover the whole window (normalized coordinates), two parallax layers.
        let estrellas = (0..170).map(|_| {
            let capa = r.next() >= 0.6;
            Estrella {
                x: r.next(), y: r.next(),
                vel: if capa { 3.4 + r.next() * 2.0 } else { 1.1 + r.next() },
                brillo: if capa { 0.34 + r.next() * 0.2 } else { 0.16 + r.next() * 0.12 },
                fase: r.next() * TAU, tono: r.next(),
                radio: if capa { 0.22 + r.next() * 0.1 } else { 0.14 + r.next() * 0.08 },
            }
        }).collect();
        let agentes = (0..28).map(|i| {
            let ang = (i as f32 / 28.0) * TAU + r.next() * 0.3;
            let dist = 26.0 + r.next() * 44.0;
            Agente { x: CX + ang.cos() * dist * 1.5, y: CY + ang.sin() * dist * 0.5, llega: 0.5 + r.next() * 0.5, tono: i as f32 / 28.0, curva: (r.next() - 0.5) * 14.0 }
        }).collect();
        let satelites = [
            Satelite { vel: 1.5, fase: 0.4, color: BLANCO, radio: 10.2, achate: 0.42, incl: -0.5 },
            Satelite { vel: -1.05, fase: 2.6, color: MAGENTA, radio: 10.4, achate: 0.5, incl: 0.75 },
            Satelite { vel: 0.78, fase: 4.4, color: AZUL, radio: 9.8, achate: 0.34, incl: 1.45 },
        ];
        Escena { estrellas, agentes, satelites }
    })
}

/// Maps scene units to window pixels.
#[derive(Clone, Copy)]
struct Lienzo { ox: f32, oy: f32, s: f32 }
impl Lienzo {
    fn p(&self, x: f32, y: f32) -> Point<Pixels> { point(px(self.ox + x * self.s), px(self.oy + y * self.s)) }
    fn b(&self, x: f32, y: f32, w: f32, h: f32) -> Bounds<Pixels> { Bounds { origin: self.p(x, y), size: size(px(w * self.s), px(h * self.s)) } }
}

fn disco(window: &mut Window, l: Lienzo, x: f32, y: f32, r: f32, c: Rgb, a: f32) {
    if a <= 0.01 { return; }
    let r = r.max(0.5 / l.s);
    window.paint_quad(quad(l.b(x - r, y - r, 2.0 * r, 2.0 * r), px(r * l.s), col(c, a), px(0.), transparent_black(), BorderStyle::Solid));
}

/// Soft blob of light (a blurred circle).
fn brillo(window: &mut Window, l: Lienzo, x: f32, y: f32, r: f32, blur: f32, c: Rgb, a: f32) {
    if a <= 0.005 { return; }
    let shadow = BoxShadow { color: col(c, a), offset: point(px(0.), px(0.)), blur_radius: px(blur * l.s), spread_radius: px(0.) };
    window.paint_shadows(l.b(x - r, y - r, 2.0 * r, 2.0 * r), px(r * l.s).into(), &[shadow]);
}

/// Circle outline (shock waves).
fn aro(window: &mut Window, l: Lienzo, x: f32, y: f32, r: f32, ancho: f32, c: Rgb, a: f32) {
    if a <= 0.005 { return; }
    let ro = r + ancho / 2.0;
    window.paint_quad(quad(l.b(x - ro, y - ro, 2.0 * ro, 2.0 * ro), px(ro * l.s), transparent_black(), px(ancho * l.s), col(c, a), BorderStyle::Solid));
}

fn poligono(window: &mut Window, l: Lienzo, pts: &[(f32, f32)], fondo: impl Into<gpui::Background>) {
    let mut b = PathBuilder::fill();
    b.move_to(l.p(pts[0].0, pts[0].1));
    for &(x, y) in &pts[1..] { b.line_to(l.p(x, y)); }
    b.close();
    if let Ok(path) = b.build() { window.paint_path(path, fondo); }
}

/// Point on the hexagon of apothem `a` along the direction `theta` (0 = up, clockwise), as in `sdHex`.
fn hex_pt(theta: f32, a: f32) -> (f32, f32) {
    let (dx, dy) = (theta.sin(), -theta.cos());
    let norma = dx.abs().max(dx.abs() * 0.5 + dy.abs() * 0.866_025_4);
    (dx * a / norma, dy * a / norma)
}

/// A concrete family so the weight is honored (the generic system font ignores it on some platforms).
#[cfg(target_os = "windows")]
const DISPLAY_FONT: &str = "Segoe UI";
#[cfg(target_os = "macos")]
const DISPLAY_FONT: &str = UI_FONT;
#[cfg(not(any(target_os = "windows", target_os = "macos")))]
const DISPLAY_FONT: &str = "Inter";

fn fuente(weight: FontWeight) -> Font { Font { weight, ..font(DISPLAY_FONT) } }

/// Paints one piece of text with its top-left at `origin` and returns its width in pixels.
fn texto(window: &mut Window, cx: &mut App, s: &str, size_px: f32, f: Font, c: Hsla, origin: Point<Pixels>) -> f32 {
    let run = TextRun { len: s.len(), font: f, color: c, background_color: None, underline: None, strikethrough: None };
    let line = window.text_system().shape_line(SharedString::from(s.to_string()), px(size_px), &[run], None);
    let _ = line.paint(origin, px(size_px * 1.25), window, cx);
    f32::from(line.width)
}

fn ancho(window: &mut Window, s: &str, size_px: f32, f: Font) -> (f32, f32, f32) {
    let run = TextRun { len: s.len(), font: f, color: transparent_black(), background_color: None, underline: None, strikethrough: None };
    let line = window.text_system().shape_line(SharedString::from(s.to_string()), px(size_px), &[run], None);
    (f32::from(line.width), f32::from(line.ascent), f32::from(line.descent))
}

/* ───────────────────────── wordmark letters ───────────────────────── */

/// Stroke of the letters (the CLI font uses 3 of 10).
const TRAZO: f32 = 2.8;

fn arco(v: &mut Vec<(f32, f32)>, cx: f32, cy: f32, r: f32, a0: f32, a1: f32) {
    const PASOS: usize = 10;
    for k in 0..=PASOS {
        let a = (a0 + (a1 - a0) * k as f32 / PASOS as f32).to_radians();
        v.push((cx + r * a.cos(), cy + r * a.sin()));
    }
}

fn rect_redondeado(x0: f32, y0: f32, x1: f32, y1: f32, r: f32) -> Vec<(f32, f32)> {
    let mut v = vec![];
    arco(&mut v, x1 - r, y0 + r, r, -90.0, 0.0);
    arco(&mut v, x1 - r, y1 - r, r, 0.0, 90.0);
    arco(&mut v, x0 + r, y1 - r, r, 90.0, 180.0);
    arco(&mut v, x0 + r, y0 + r, r, 180.0, 270.0);
    v
}

fn area(v: &[(f32, f32)]) -> f32 {
    (0..v.len()).map(|i| { let (a, b) = (v[i], v[(i + 1) % v.len()]); a.0 * b.1 - b.0 * a.1 }).sum::<f32>() / 2.0
}

/// Contours of O R Q E N in a 10 × 12 box; outlines wind one way and holes the other (non-zero fill).
fn letras() -> &'static [Vec<Vec<(f32, f32)>>; 5] {
    static L: OnceLock<[Vec<Vec<(f32, f32)>>; 5]> = OnceLock::new();
    L.get_or_init(|| {
        let t = TRAZO;
        let o = vec![(rect_redondeado(0.0, 0.0, 10.0, 12.0, 4.4), false), (rect_redondeado(t, t, 10.0 - t, 12.0 - t, 4.4 - t), true)];
        let mut q = o.clone();
        {   // the tail, like the logo: a diagonal from the counter out past the bottom-right corner
            let (p1, p2) = ((5.3_f32, 6.9_f32), (10.3_f32, 12.3_f32));
            let (dx, dy) = (p2.0 - p1.0, p2.1 - p1.1);
            let n = (dx * dx + dy * dy).sqrt();
            let (nx, ny) = (-dy / n * t / 2.0, dx / n * t / 2.0);
            q.push((vec![(p1.0 + nx, p1.1 + ny), (p2.0 + nx, p2.1 + ny), (p2.0 - nx, p2.1 - ny), (p1.0 - nx, p1.1 - ny)], false));
        }
        let r = {
            let (alto, rb) = (7.6, 3.8);
            let mut fuera = vec![(0.0, 12.0), (0.0, 0.0)];
            arco(&mut fuera, 10.0 - rb, rb, rb, -90.0, 90.0);
            fuera.extend([(6.2, alto), (10.0, 12.0), (6.8, 12.0), (3.3, alto), (t, alto), (t, 12.0)]);
            let mut dentro = vec![(t, t)];
            arco(&mut dentro, 10.0 - rb, rb, rb - t, -90.0, 90.0);
            dentro.push((t, alto - t));
            vec![(fuera, false), (dentro, true)]
        };
        let m = 6.0;
        let e = vec![(vec![(0.0, 0.0), (10.0, 0.0), (10.0, t), (t, t), (t, m - t / 2.0), (8.6, m - t / 2.0), (8.6, m + t / 2.0), (t, m + t / 2.0),
            (t, 12.0 - t), (10.0, 12.0 - t), (10.0, 12.0), (0.0, 12.0)], false)];
        let b = 10.0 - t;
        let n = vec![(vec![(0.0, 0.0), (t, 0.0), (b, 6.3), (b, 0.0), (10.0, 0.0), (10.0, 12.0), (b, 12.0), (t, 5.7), (t, 12.0), (0.0, 12.0)], false)];
        let orientar = |cs: Vec<(Vec<(f32, f32)>, bool)>| cs.into_iter().map(|(mut v, hueco)| { if (area(&v) > 0.0) == hueco { v.reverse(); } v }).collect::<Vec<_>>();
        [orientar(o), orientar(r), orientar(q), orientar(e), orientar(n)]
    })
}

/// Paints letter `i` of ORQEN with its top-left corner at (x, y) in scene units.
fn letra(window: &mut Window, l: Lienzo, i: usize, x: f32, y: f32, fondo: gpui::Background) {
    let mut b = PathBuilder::fill().with_style(PathStyle::Fill(FillOptions::default().with_fill_rule(FillRule::NonZero)));
    for c in &letras()[i] {
        b.move_to(l.p(x + c[0].0, y + c[0].1));
        for &(px_, py_) in &c[1..] { b.line_to(l.p(x + px_, y + py_)); }
        b.close();
    }
    if let Ok(path) = b.build() { window.paint_path(path, fondo); }
}

/* ───────────────────────── element ───────────────────────── */

/// The splash scene at `t` seconds; fills its parent.
pub fn splash(t: f32) -> impl IntoElement {
    canvas(|_, _, _| {}, move |bounds, _, window, cx| pintar(t, bounds, window, cx)).size_full()
}

fn pintar(tt: f32, bounds: Bounds<Pixels>, window: &mut Window, cx: &mut App) {
    let e = escena();
    let (bx, by) = (f32::from(bounds.origin.x), f32::from(bounds.origin.y));
    let (bw, bh) = (f32::from(bounds.size.width), f32::from(bounds.size.height));
    // 90 × 24 canvas + the tagline below, centered.
    let s = (bw * 0.66 / W).min(bh * 0.5 / H).clamp(4.0, 12.0);
    let l = Lienzo { ox: bx + (bw - W * s) / 2.0, oy: by + (bh - (H + 5.0) * s) / 2.0, s };
    // Window edges in scene units (stars and particles use the whole window).
    let (ux0, uy0) = ((bx - l.ox) / s, (by - l.oy) / s);
    let (uw, uh) = (bw / s, bh / s);

    // Waves: at impact and once per cycle.
    let mut ondas: Vec<f32> = vec![];
    let mut n = (((tt - T_IMPACTO) / CICLO).floor() - 1.0).max(0.0);
    loop { let tn = T_IMPACTO + n * CICLO; if tn > tt { break; } ondas.push(tn); n += 1.0; }
    let ultima_onda = ondas.last().copied().unwrap_or(f32::INFINITY);
    let desde_onda = tt - ultima_onda;
    let destello = if desde_onda >= 0.0 { (-desde_onda * 3.6).exp() } else { 0.0 };

    // ── Ambient light behind the mark ──
    let ambiente = limitar(tt / 1.6);
    // (wide radius + moderate blur instead of a huge blur: same soft light, a fraction of the pixels to shade)
    brillo(window, l, CX, CY, 22.0, 12.0, AZUL, 0.03 * ambiente);
    brillo(window, l, X0 + 34.0, 12.0, 30.0, 12.0, MAGENTA, 0.012 * ambiente);

    // ── Parallax stars ──
    let entrada = limitar(tt / 1.2);
    for st in &e.estrellas {
        let x = ux0 + frac(st.x - tt * st.vel / uw) * uw;
        let y = uy0 + st.y * uh;
        let b = st.brillo * (0.65 + 0.35 * (tt * 1.7 + st.fase).sin()) * entrada;
        disco(window, l, x, y, st.radio, mezclar(GRIS, marca(st.tono), 0.5), b * 1.5);
    }

    // ── Shock waves ──
    for &tn in &ondas {
        let tau = tt - tn;
        if tau > DUR_ONDA || tau < 0.0 { continue; }
        let r = VEL_ONDA * tau;
        let fuerza = (1.0 - tau / DUR_ONDA).powf(1.4) * 0.6;
        let c = marca(0.5 + 0.5 * (r * 0.07).sin());
        aro(window, l, CX, CY, r, 4.8, c, fuerza * 0.18);
        aro(window, l, CX, CY, r, 1.6, c, fuerza * 0.55);
        aro(window, l, CX, CY, r, 0.45, WHITE, fuerza * 0.5);
    }

    // ── Intro: particles converge on the center ──
    if tt < 1.25 {
        const COLA: usize = 10;
        let mut cabezas: Vec<(f32, f32, Rgb, f32)> = Vec::with_capacity(e.agentes.len());
        let mut discos: Vec<(f32, f32, f32, Rgb, f32)> = Vec::with_capacity(e.agentes.len() * COLA);
        for a in &e.agentes {
            for k in 0..COLA {
                let p = entrada_cubica((tt - k as f32 * 0.021) / a.llega);
                if p <= 0.0 || p >= 1.0 { continue; }
                let lado = (p * PI).sin() * a.curva;
                let x = a.x + (CX - a.x) * p + lado * 0.6;
                let y = a.y + (CY - a.y) * p - lado * 0.25;
                let c = mezclar(marca(a.tono), BLANCO, p * 0.6);
                let f = 1.0 - k as f32 / COLA as f32;
                if k == 0 { cabezas.push((x, y, marca(a.tono), 0.55 * (0.35 + 0.65 * p))); }
                discos.push((x, y, 0.55 * (0.45 + 0.55 * f), c, (0.35 + 0.65 * p) * f * f));
            }
        }
        for &(x, y, c, a) in &cabezas { brillo(window, l, x, y, 0.5, 1.6, c, a); }
        for &(x, y, r, c, a) in &discos { disco(window, l, x, y, r, c, a); }
    }

    // ── Hexagon: entry scale, rotation and halo ──
    let escala = if tt < T_HEX { 0.0 } else { salida_rebote((tt - T_HEX) / 0.75) };
    let giro = if tt < T_IMPACTO + 0.2 {
        (1.0 - salida_cubica((tt - T_HEX) / (T_IMPACTO - T_HEX + 0.2))) * PI * 3.0
    } else {
        let en_ciclo = (tt - T_IMPACTO) % CICLO;
        if en_ciclo > CICLO - T_GIRO { entrada_salida((en_ciclo - (CICLO - T_GIRO)) / T_GIRO) * TAU } else { 0.0 }
    };
    let sx = giro.cos().abs().max(0.07);
    let halo = (0.17 + 0.06 * (tt * 1.9).sin() + 0.75 * destello) * limitar(escala);
    let respiro = 0.2 * (tt * 1.7).sin();
    let cola = salida_cubica((tt - (T_IMPACTO - 0.1)) / 0.4);
    let cometa = if tt < T_IMPACTO { -1.0 } else { frac(tt / 2.6) };
    let luz = 0.6 + 0.4 * sx;
    let a_medio = APOTEMA + respiro - GROSOR / 2.0;
    let tr = |(x, y): (f32, f32)| (CX + x * sx * escala, CY + y * escala);

    // Satellites: projected orbits; the far side is drawn before the ring.
    let entrada_sat = limitar((tt - 1.9) / 0.9);
    let satelites = |window: &mut Window, frente: bool| {
        if entrada_sat <= 0.0 { return; }
        const COLA: usize = 16;
        let mut cabezas: Vec<(f32, f32, f32, Rgb, f32)> = vec![];
        let mut discos: Vec<(f32, f32, f32, Rgb, f32)> = vec![];
        for st in &e.satelites {
            for k in (0..COLA).rev() {
                let a = st.fase + st.vel * (tt - k as f32 * 0.02);
                let z = a.sin();
                if (z > 0.0) != frente { continue; }
                let (ex, ey) = (a.cos() * st.radio, z * st.radio * st.achate);
                let x = CX + ex * st.incl.cos() - ey * st.incl.sin();
                let y = CY + ex * st.incl.sin() + ey * st.incl.cos();
                let f = 1.0 - k as f32 / COLA as f32;
                let alfa = entrada_sat * (0.5 + 0.5 * (z + 1.0) / 2.0) * f.powf(1.5);
                let r = (0.5 + 0.25 * (z + 1.0)) * (0.35 + 0.65 * f) * 0.8;
                if k == 0 { cabezas.push((x, y, r, st.color, alfa * 0.6)); }
                discos.push((x, y, r, st.color, alfa));
            }
        }
        for &(x, y, r, c, a) in &cabezas { brillo(window, l, x, y, r, 1.8, c, a); }
        for &(x, y, r, c, a) in &discos { disco(window, l, x, y, r, c, a); }
    };
    satelites(window, false);

    if escala > 0.02 {
        let giro_grad = (tt / 4.2) * 360.0;
        // Halo: wide translucent strokes of the ring with a rotating blue → magenta gradient, plus a glow.
        brillo(window, l, CX, CY, a_medio * escala * sx.max(0.4), 5.0, mezclar(AZUL, MAGENTA, 0.5 + 0.5 * (tt * 0.9).sin()), halo * 0.55 * luz);
        brillo(window, l, CX, CY, a_medio * 0.6 * escala, 4.0, WHITE, destello * 0.5);
        let vertices: Vec<(f32, f32)> = (0..6).map(|i| tr(hex_pt(i as f32 * TAU / 6.0, a_medio))).collect();
        for extra in [7.0_f32, 4.6, 2.8, 1.4, 0.5] {
            let alfa = 0.125 * (-extra / 3.2).exp();
            let mut b = PathBuilder::stroke(px((GROSOR + 2.0 * extra) * escala * s));
            b.move_to(l.p(vertices[0].0, vertices[0].1));
            for v in &vertices[1..] { b.line_to(l.p(v.0, v.1)); }
            b.close();
            if let Ok(path) = b.build() {
                let k = halo * luz * alfa * 2.4;
                window.paint_path(path, linear_gradient(giro_grad, linear_color_stop(col(AZUL, k), 0.), linear_color_stop(col(MAGENTA, k), 1.)));
            }
        }

        // Ring: one segment per 5°, each with its own color (rotating gradient + comet + flash).
        const N: usize = 72;
        let (ri, ro) = (a_medio - GROSOR / 2.0, a_medio + GROSOR / 2.0);
        let color_en = |ang: f32, anillo: bool| {
            let u = 0.5 + 0.5 * (TAU * (ang - tt / 4.2)).sin();
            let mut c = marca(u);
            if anillo && cometa >= 0.0 { c = mezclar(c, WHITE, (-frac(cometa - ang) * 11.0).exp() * 0.85); }
            c = mezclar(c, WHITE, destello * 0.7);
            atenuar(c, luz)
        };
        for i in 0..N {
            let t0 = i as f32 / N as f32 * TAU;
            let t1 = (i + 1) as f32 / N as f32 * TAU + 0.006;
            let c = color_en((i as f32 + 0.5) / N as f32, true);
            poligono(window, l, &[tr(hex_pt(t0, ro)), tr(hex_pt(t1, ro)), tr(hex_pt(t1, ri)), tr(hex_pt(t0, ri))], col(c, 1.0));
        }

        // Tail of the Q: a capsule that grows from inside the ring.
        if cola > 0.0 {
            let (x1, y1) = (2.1, 3.0);
            let (x2, y2) = (2.1 + 4.2 * cola, 3.0 + 5.2 * cola);
            let ang = (y2 - y1).atan2(x2 - x1);
            let r = 1.15;
            let mut pts = vec![];
            for k in 0..=10 { let a = ang + PI / 2.0 + PI * k as f32 / 10.0; pts.push(tr((x1 + r * a.cos(), y1 + r * a.sin()))); }
            for k in 0..=10 { let a = ang - PI / 2.0 + PI * k as f32 / 10.0; pts.push(tr((x2 + r * a.cos(), y2 + r * a.sin()))); }
            let mx = (x1 + x2) / 2.0; let my = (y1 + y2) / 2.0;
            let c = color_en(frac(mx.atan2(-my) / TAU), false);
            poligono(window, l, &pts, col(c, 1.0));
        }
    }
    satelites(window, true);

    // ── Wordmark: the wave lights each letter, with a blue/magenta chromatic split ──
    // Vector letters with the geometry of the CLI pixel font (10 × 12, 12 apart): same look on every OS.
    // Drawn in three passes (glows, ghosts, letters) so the GPU rasterizes the paths in as few batches as possible.
    struct Letra { i: usize, lx: f32, y: f32, ee: f32, edad: f32, flash: f32, corr: f32, llega: f32 }
    let mut letras_vivas: Vec<Letra> = vec![];
    for i in 0..5 {
        let lx = X0 + i as f32 * PASO;
        let dist = (lx + 5.0 - CX).hypot(Y0 + LETRA_H / 2.0 - CY);
        let edad = tt - (T_IMPACTO + dist / VEL_ONDA);
        if edad < -0.12 { continue; }
        let ee = limitar(edad / 0.5);
        let mut flash = 0.0_f32;
        for &tn in &ondas { if tn > T_IMPACTO { let d2 = tt - (tn + dist / VEL_ONDA); if d2 >= 0.0 { flash = flash.max((-d2 * 4.2).exp()); } } }
        let corr = 3.4 * (1.0 - ee) * (1.0 - ee) + 1.4 * flash;
        let sube = 3.0 * (1.0 - salida_cubica(ee));
        letras_vivas.push(Letra { i, lx, y: Y0 - sube, ee, edad, flash, corr, llega: limitar((edad + 0.12) / 0.15) });
    }
    for le in &letras_vivas {
        let g = (1.0 - le.ee) * 0.3 + le.flash * 0.35;
        brillo(window, l, le.lx + 5.0, le.y + LETRA_H / 2.0, 4.5, 3.5, marca((le.lx + 5.0 - X0) / ANCHO_PALABRA), g * le.llega);
    }
    for le in &letras_vivas {
        if le.corr > 0.02 {
            let fantasma = ((1.0 - le.ee).powf(1.4) * 0.72).max(le.flash * 0.55) * le.llega;
            letra(window, l, le.i, le.lx - le.corr, le.y, col(AZUL, fantasma).into());
            letra(window, l, le.i, le.lx + le.corr, le.y, col(MAGENTA, fantasma).into());
        }
    }
    let frente = -20.0 + frac((tt - T_LISTO) / CICLO + 0.5) * (ANCHO_PALABRA + 90.0);
    for le in letras_vivas.iter().filter(|le| le.edad >= 0.0) {
        let (ee, flash) = (le.ee, le.flash);
        let color = |x: f32| {
            let u = (x - X0) / ANCHO_PALABRA;
            let barrido = if tt > T_LISTO { entrada_salida(1.0 - ((x - X0) + LETRA_H / 2.0 * 1.3 - frente).abs() / 9.0) } else { 0.0 };
            col(mezclar(mezclar(marca(u), BLANCO, ee), marca(u), (flash * 0.95).max(barrido * 0.85)), ee.sqrt())
        };
        letra(window, l, le.i, le.lx, le.y, linear_gradient(90., linear_color_stop(color(le.lx), 0.), linear_color_stop(color(le.lx + 10.0), 1.)));
    }
    let palabra_x0 = X0;
    let palabra_w = ANCHO_PALABRA;

    // ── Underline with a traveling pulse ──
    let p = salida_cubica((tt - 2.1) / 0.7);
    if p > 0.0 {
        let grueso = 0.42;
        let largo = palabra_w * p;
        window.paint_quad(fill(l.b(palabra_x0, Y_SUBRAYADO, largo, grueso), linear_gradient(90., linear_color_stop(col(AZUL, 0.75), 0.), linear_color_stop(col(mezclar(AZUL, MAGENTA, p), 0.75), 1.))).corner_radii(px(grueso * s / 2.0)));
        if tt > T_LISTO {
            let pulso = palabra_x0 + frac((tt - T_LISTO) / 2.4) * (palabra_w + 16.0) - 8.0;
            let dentro = limitar((pulso - palabra_x0 + 2.0) / 4.0) * limitar((palabra_x0 + largo + 2.0 - pulso) / 4.0);
            let c = mezclar(marca((pulso - palabra_x0) / palabra_w), WHITE, 0.5);
            brillo(window, l, pulso, Y_SUBRAYADO + grueso / 2.0, 1.2, 2.2, c, 0.8 * dentro);
            let ini = (pulso - 3.0).max(palabra_x0);
            let fin = (pulso + 3.0).min(palabra_x0 + largo);
            if fin > ini {
                // bright core of the pulse
                let core = 1.6_f32;
                let (a0, a1) = ((pulso - core).max(palabra_x0), (pulso + core).min(palabra_x0 + largo));
                if a1 > a0 { window.paint_quad(fill(l.b(a0, Y_SUBRAYADO, a1 - a0, grueso), col(WHITE, 0.85 * dentro)).corner_radii(px(grueso * s / 2.0))); }
            }
        }
    }

    // ── Subtitle, typed in letter by letter ──
    let fs_sub = (1.55 * s).max(10.0);
    let f_sub = fuente(FontWeight::MEDIUM);
    let esp = 0.32 * fs_sub;
    let chars: Vec<char> = SUBTITULO.chars().collect();
    let anchos_sub: Vec<f32> = chars.iter().map(|c| if *c == ' ' { fs_sub * 0.3 } else { ancho(window, &c.to_string(), fs_sub, f_sub.clone()).0 }).collect();
    let total_sub = anchos_sub.iter().sum::<f32>() + esp * (chars.len() as f32 - 1.0);
    let mut xs = l.ox + (palabra_x0 + palabra_w / 2.0) * s - total_sub / 2.0;
    let ys = l.oy + 20.4 * s;
    for (i, c) in chars.iter().enumerate() {
        let k = limitar((tt - 2.35 - i as f32 * 0.016) / 0.25);
        if k > 0.0 && *c != ' ' {
            let cc = mezclar(marca(i as f32 / chars.len() as f32), GRIS, k);
            texto(window, cx, &c.to_string(), fs_sub, f_sub.clone(), col(cc, 0.3 + 0.7 * k), point(px(xs), px(ys + (1.0 - k) * 0.6 * s)));
        }
        xs += anchos_sub[i] + esp;
    }

    // ── Tagline ──
    if tt > 2.5 {
        let k = salida_cubica((tt - 2.5) / 0.5);
        let fs_t = (1.45 * s).max(10.0);
        let bold = fuente(FontWeight::SEMIBOLD);
        let normal = fuente(FontWeight::NORMAL);
        let w1 = ancho(window, "//", fs_t, bold.clone()).0;
        let w2 = ancho(window, &format!(" {LEMA}"), fs_t, bold.clone()).0;
        let w3 = ancho(window, SUB, fs_t, normal.clone()).0;
        let gap = fs_t * 1.4;
        let total_t = w1 + w2 + gap + w3;
        let mut x = l.ox + W * s / 2.0 - total_t / 2.0;
        let y = l.oy + (H + 1.6) * s + (1.0 - k) * 0.8 * s;
        x += texto(window, cx, "//", fs_t, bold.clone(), col(MAGENTA, k), point(px(x), px(y)));
        x += texto(window, cx, &format!(" {LEMA}"), fs_t, bold, col(BLANCO, k), point(px(x), px(y)));
        x += gap;
        texto(window, cx, SUB, fs_t, normal, col(GRIS, k * 0.9), point(px(x), px(y)));
    }
}
