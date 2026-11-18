//! The ORQEN mark (hexagonal Q, blue → magenta) drawn with paths so it can be animated stroke by stroke.
use gpui::{IntoElement, Pixels, Styled, canvas, linear_color_stop, linear_gradient, point, px, PathBuilder};

use crate::theme::{BLUE, MAGENTA, h};

const HEX: [(f32, f32); 6] = [(12.0, 2.8), (20.0, 7.4), (20.0, 16.6), (12.0, 21.2), (4.0, 16.6), (4.0, 7.4)];

/// `progress` 0..1 draws the hexagon; `tail` 0..1 draws the tail of the Q.
pub fn logo(size: f32, stroke: f32, progress: f32, tail: f32) -> impl IntoElement {
    canvas(|_, _, _| {}, move |bounds, _, window, _| {
        let k = size / 24.0;
        let at = |x: f32, y: f32| point(bounds.origin.x + px(x * k), bounds.origin.y + px(y * k));
        let width: Pixels = px(stroke * k);
        let p = progress.clamp(0.0, 1.0);
        if p > 0.0 {
            let mut b = PathBuilder::stroke(width);
            b.move_to(at(HEX[0].0, HEX[0].1));
            let sides = p * 6.0;
            for i in 0..6 {
                let (a, z) = (HEX[i], HEX[(i + 1) % 6]);
                let f = (sides - i as f32).clamp(0.0, 1.0);
                if f <= 0.0 { break; }
                b.line_to(at(a.0 + (z.0 - a.0) * f, a.1 + (z.1 - a.1) * f));
            }
            if p >= 1.0 { b.close(); }
            if let Ok(path) = b.build() {
                window.paint_path(path, linear_gradient(135., linear_color_stop(h(BLUE), 0.), linear_color_stop(h(MAGENTA), 1.)));
            }
        }
        let t = tail.clamp(0.0, 1.0);
        if t > 0.0 {
            let mut b = PathBuilder::stroke(width);
            b.move_to(at(13.5, 14.5));
            b.line_to(at(13.5 + 6.0 * t, 14.5 + 6.0 * t));
            if let Ok(path) = b.build() { window.paint_path(path, h(MAGENTA)); }
        }
    })
    .size(px(size))
}
