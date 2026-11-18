//! Small building blocks shared by the screens.
use std::time::Duration;

use gpui::{
    Animation, AnimationExt as _, AnyElement, ClickEvent, Div, ElementId, FontWeight, Hsla, IntoElement, Length, SharedString, Stateful, Svg,
    Window, App, div, linear_color_stop, linear_gradient, prelude::*, px, relative, svg,
};

use crate::theme::*;

pub fn icon(name: &str, size: f32, color: u32) -> Svg {
    svg().path(SharedString::from(format!("icons/{name}.svg"))).size(px(size)).flex_none().text_color(c(color))
}

/// Placeholder block of a component that is still loading: a light slice sweeps left → right, like a pulse.
/// It has the size of what will be there, so nothing jumps when the data arrives.
pub fn skeleton(id: impl Into<ElementId>, w: impl Into<Length> + Clone, h: f32) -> Div {
    let glow = Hsla { a: 0.85, ..gpui::rgb(0x223050).into() };
    let clear = Hsla { a: 0.0, ..glow };
    div().relative().overflow_hidden().flex_none().w(w).h(px(h)).rounded(px((h / 2.0).min(6.0))).bg(c(0x121927))
        .child(div().absolute().top_0().bottom_0().w(relative(0.6)).flex()
            .child(div().h_full().flex_1().bg(linear_gradient(90., linear_color_stop(clear, 0.), linear_color_stop(glow, 1.))))
            .child(div().h_full().flex_1().bg(linear_gradient(90., linear_color_stop(glow, 0.), linear_color_stop(clear, 1.))))
            .with_animation(id, Animation::new(Duration::from_millis(1500)).repeat().with_easing(gpui::ease_in_out),
                |d, t| d.left(relative(-0.6 + 1.6 * t))))
}

/// A line of text that is still loading: same height as text of `size` (GPUI's line height is 1.618 × size).
pub fn skeleton_text(id: impl Into<ElementId>, w: impl Into<Length> + Clone, size: f32) -> Div {
    div().h(px(size * 1.618)).flex().items_center().child(skeleton(id, w, (size * 0.62).round().max(6.0)))
}

/// Something is in progress (an action, a check): a thin track with a slice running left → right.
pub fn progress_slice(id: impl Into<ElementId>, w: f32) -> Div {
    let mid = Hsla { a: 1.0, ..gpui::rgb(0x9A4BE0).into() };
    div().relative().overflow_hidden().flex_none().w(px(w)).h(px(3.)).rounded_full().bg(c(0x172036))
        .child(div().absolute().top_0().bottom_0().w(relative(0.45)).flex()
            .child(div().h_full().flex_1().bg(linear_gradient(90., linear_color_stop(Hsla { a: 0.0, ..h(BLUE) }, 0.), linear_color_stop(mid, 1.))))
            .child(div().h_full().flex_1().bg(linear_gradient(90., linear_color_stop(mid, 0.), linear_color_stop(Hsla { a: 0.0, ..h(MAGENTA) }, 1.))))
            .with_animation(id, Animation::new(Duration::from_millis(1300)).repeat().with_easing(gpui::ease_in_out),
                |d, t| d.left(relative(-0.45 + 1.45 * t))))
}

/// Text of something in progress, softly pulsing, over a progress slice.
pub fn busy(id: impl Into<ElementId>, text: impl Into<SharedString>) -> impl IntoElement {
    let id: ElementId = id.into();
    div().flex().flex_col().gap(px(4.))
        .child(div().text_size(px(12.)).text_color(c(TEXT_2)).child(text.into())
            .with_animation(ElementId::NamedChild(Box::new(id.clone()), "t".into()), Animation::new(Duration::from_millis(1600)).repeat().with_easing(gpui::pulsating_between(0.55, 1.0)), |d, t| d.opacity(t)))
        .child(progress_slice(ElementId::NamedChild(Box::new(id), "p".into()), 120.))
}

/// Dot that pulses while something is running.
pub fn live_dot(id: impl Into<ElementId>, color: u32) -> impl IntoElement {
    div().size(px(7.)).rounded_full().bg(c(color)).flex_none().with_animation(
        id, Animation::new(Duration::from_millis(1600)).repeat().with_easing(gpui::pulsating_between(0.35, 1.0)),
        |d, t| d.opacity(t),
    )
}

pub fn dot(color: u32) -> Div { div().size(px(7.)).rounded_full().bg(c(color)).flex_none() }

pub fn mono(text: impl Into<SharedString>) -> Div { div().font_family(MONO_FONT).child(text.into()) }

pub fn label(text: impl Into<SharedString>) -> Div { div().text_size(px(11.)).text_color(c(DIM)).child(text.into()) }

pub fn chip(text: impl Into<SharedString>, border: u32, color: u32) -> Div {
    div().flex_none().px(px(8.)).py(px(1.)).rounded_full().border_1().border_color(c(border)).text_size(px(10.5)).text_color(c(color)).child(text.into())
}

pub enum Kind { Primary, Ghost, Accent }

pub fn button(id: impl Into<ElementId>, text: impl Into<SharedString>, kind: Kind, on_click: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static) -> Stateful<Div> {
    let base = div().id(id).flex().items_center().gap(px(6.)).h(px(28.)).px(px(11.)).rounded(px(7.)).text_size(px(12.)).cursor_pointer().flex_none();
    let b = match kind {
        Kind::Primary => base.bg(c(BLUE)).text_color(c(0xFFFFFF)).font_weight(FontWeight::SEMIBOLD).hover(|s| s.bg(c(0x3B74FF))),
        Kind::Ghost => base.border_1().border_color(c(BORDER_2)).text_color(c(TEXT_2)).hover(|s| s.bg(c(0x161D2D)).text_color(c(TEXT))),
        Kind::Accent => base.border_1().border_color(c(0x23345F)).bg(c(0x0F1A36)).text_color(c(0xA9C1FF)).hover(|s| s.bg(c(0x142247))),
    };
    b.active(|s| s.opacity(0.85)).child(text.into()).on_click(on_click)
}

pub fn icon_button(id: impl Into<ElementId>, name: &str, on_click: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static) -> Stateful<Div> {
    div().id(id).size(px(28.)).flex().items_center().justify_center().rounded(px(7.)).cursor_pointer()
        .hover(|s| s.bg(c(0x161D2D))).child(icon(name, 14., MUTED)).on_click(on_click)
}

/// Fades and lifts in when it appears; `delay_ms` staggers lists.
pub fn appear(id: impl Into<ElementId>, delay_ms: u64, el: impl IntoElement + 'static) -> AnyElement {
    let total = 320 + delay_ms;
    let start = delay_ms as f32 / total as f32;
    div().relative().child(el).with_animation(
        id, Animation::new(Duration::from_millis(total)).with_easing(move |t| {
            let x = ((t - start) / (1.0 - start)).clamp(0.0, 1.0);
            1.0 - (1.0 - x).powi(5)
        }),
        |d, t| d.opacity(t).top(px((1.0 - t) * 6.0)),
    ).into_any_element()
}

pub fn card() -> Div { div().rounded(px(12.)).border_1().border_color(c(0x1E2638)).bg(c(SURFACE)) }

pub fn h1(text: impl Into<SharedString>) -> Div {
    div().text_size(px(17.)).font_weight(FontWeight::SEMIBOLD).text_color(c(TEXT)).child(text.into())
}

pub fn empty(title: impl Into<SharedString>, body: impl Into<SharedString>) -> Div {
    div().flex().flex_col().items_center().justify_center().gap(px(8.)).p(px(40.)).size_full()
        .child(div().text_size(px(15.)).font_weight(FontWeight::SEMIBOLD).text_color(c(TEXT)).child(title.into()))
        .child(div().max_w(px(460.)).text_size(px(12.5)).text_color(c(MUTED)).text_center().child(body.into()))
}
