//! Illustrations for the tutorial's "In the app" view: the real screens redrawn small, with the same pieces and colors,
//! this project's keys, and a pulsing ring + numbered tags on what the step talks about.
//! Drawn instead of screenshots so they never go stale, stay sharp at any size and follow the theme.
use std::time::Duration;

use gpui::{Animation, AnimationExt as _, AnyElement, Div, FontWeight, IntoElement, SharedString, div, prelude::*, px, relative};

use crate::theme::*;
use crate::ui::{chip, dot, icon, live_dot, mono};

/// This project's data (from `orqen tutorial --json` → `sample`).
pub struct Sample {
    pub ext: String,
    pub int: Option<String>,
    pub tool: String,
    pub procs: Vec<String>,
}

fn t(es: bool, a: &'static str, b: &'static str) -> &'static str { if es { a } else { b } }

/// The figure of a tutorial step (by step id), if it has one.
pub fn figure(step: &str, es: bool, d: &Sample) -> Option<AnyElement> {
    let f = match step {
        "welcome" => welcome(es),
        "words" => words(es, d),
        "map" => map(es, d),
        "next" => next(es, d),
        "pending" => pending(es, d),
        "analysis" => analysis(es, d),
        "implement" => implement(es, d),
        "review" => review(es, d),
        "watch" => watch(es, d),
        "env" => env(es, d),
        "problems" => problems(es, d),
        "cheatsheet" => cheatsheet(es),
        _ => return None,
    };
    Some(div().w_full().child(f).into_any_element())
}

// ================================================================ annotations

/// Pulsing magenta ring around what the step is about.
fn hl(id: &'static str, el: impl IntoElement) -> Div {
    div().relative().child(el).child(
        div().absolute().top(px(-4.)).left(px(-4.)).right(px(-4.)).bottom(px(-4.)).rounded(px(10.)).border_2().border_color(c(MAGENTA))
            .with_animation(id, Animation::new(Duration::from_millis(1400)).repeat().with_easing(gpui::pulsating_between(0.3, 1.0)), |d, t| d.opacity(t)),
    )
}

/// Ring with its number on the corner (matches a numbered tag).
fn hln(id: &'static str, n: usize, el: impl IntoElement) -> Div {
    hl(id, el).child(div().absolute().top(px(-11.)).left(px(-11.)).child(num(n)))
}

/// Same for a whole panel inside a frame (the frame clips outside): ring and number drawn inside.
fn hln_in(id: &'static str, n: usize, el: impl IntoElement) -> Div {
    div().relative().child(el)
        .child(div().absolute().top(px(3.)).left(px(3.)).right(px(3.)).bottom(px(3.)).rounded(px(8.)).border_2().border_color(c(MAGENTA))
            .with_animation(id, Animation::new(Duration::from_millis(1400)).repeat().with_easing(gpui::pulsating_between(0.3, 1.0)), |d, t| d.opacity(t)))
        .child(div().absolute().top(px(8.)).right(px(10.)).child(num(n)))
}

/// Numbered callout.
fn tag(n: usize, text: impl Into<SharedString>) -> Div {
    div().flex_none().flex().items_center().gap(px(6.)).h(px(22.)).pl(px(3.)).pr(px(10.)).rounded_full().bg(c(0x2A0D24)).border_1().border_color(c(MAGENTA))
        .child(num(n))
        .child(div().text_size(px(11.)).text_color(c(0xFFD1E8)).child(text.into()))
}

fn num(n: usize) -> Div {
    div().size(px(16.)).flex_none().rounded_full().bg(c(MAGENTA)).flex().items_center().justify_center()
        .text_size(px(10.)).font_weight(FontWeight::BOLD).text_color(c(0xFFFFFF)).child(n.to_string())
}

/// Steps left → right with arrows: (caption, picture).
fn flow(panels: Vec<(&'static str, AnyElement)>) -> Div {
    let n = panels.len();
    let mut row = div().w_full().flex().items_start().gap(px(8.));
    for (i, (cap, el)) in panels.into_iter().enumerate() {
        row = row.child(div().flex_1().min_w(px(0.)).flex().flex_col().gap(px(8.))
            .child(div().flex().items_center().gap(px(7.)).child(num(i + 1)).child(div().text_size(px(12.)).font_weight(FontWeight::SEMIBOLD).text_color(c(TEXT)).child(cap)))
            .child(div().p(px(10.)).rounded(px(12.)).border_1().border_color(c(BORDER_2)).bg(c(PANEL)).child(el)));
        if i + 1 < n { row = row.child(div().pt(px(52.)).flex_none().child(icon("arrow", 14., MAGENTA_TEXT))); }
    }
    row
}

/// Small legend line: a piece of the screen = what it means.
fn legend(sample: impl IntoElement, text: &'static str) -> Div {
    div().flex().items_center().gap(px(10.)).child(div().w(px(100.)).flex_none().flex().justify_end().child(sample))
        .child(div().text_size(px(12.)).text_color(c(MUTED)).child("="))
        .child(div().flex_1().min_w(px(0.)).text_size(px(12.)).text_color(c(TEXT_2)).child(text))
}

// ================================================================ pieces of the real screens

fn frame() -> Div {
    div().w_full().rounded(px(12.)).border_1().border_color(c(BORDER_2)).bg(c(BG)).overflow_hidden().flex().flex_col()
}

fn titlebar() -> Div {
    let tab = |name: &'static str, col: u32, on: bool| div().h_full().px(px(14.)).flex().items_center().gap(px(7.))
        .when(on, |d| d.bg(c(PANEL)).border_r_1().border_color(c(BORDER)))
        .child(dot(col)).child(div().text_size(px(11.5)).text_color(c(if on { TEXT } else { MUTED })).child(name));
    div().h(px(32.)).flex_none().flex().items_center().gap(px(6.)).bg(c(SIDEBAR)).border_b_1().border_color(c(BORDER))
        .child(tab("mi-proyecto", BLUE_TEXT, true)).child(tab("otro-proyecto", MAGENTA_TEXT, false))
        .child(div().w(px(26.)).flex().justify_center().text_size(px(16.)).text_color(c(MUTED)).child("+"))
}

fn sidebar(es: bool, env_on: bool, mark: Option<usize>) -> Div {
    let item = |ic: &'static str, name: &'static str, on: bool, badge: &'static str, hot: bool| div().flex().items_center().gap(px(8.)).h(px(28.)).px(px(8.)).rounded(px(7.))
        .text_size(px(12.)).when(on, |d| d.bg(c(SURFACE_2)).text_color(c(TEXT))).when(!on, |d| d.text_color(c(TEXT_2)))
        .child(icon(ic, 13., if on { TEXT } else { MUTED })).child(div().flex_1().child(name))
        .child(div().px(px(6.)).rounded_full().text_size(px(10.)).when(hot, |d| d.bg(c(MAGENTA)).text_color(c(0xFFFFFF))).when(!hot, |d| d.bg(c(BORDER_2)).text_color(c(TEXT_2))).child(badge));
    let nav = div().flex().flex_col().gap(px(2.))
        .child(item("pending", t(es, "Pendientes", "Pending"), !env_on, "3", true))
        .child(item("env", t(es, "Entornos", "Environments"), env_on, "2/3", false));
    div().w(px(150.)).flex_none().h_full().bg(c(SIDEBAR)).border_r_1().border_color(c(BORDER)).p(px(8.)).flex().flex_col().gap(px(8.))
        .child(match mark { Some(n) => hl("fig-nav", nav).child(div().absolute().bottom(px(-30.)).left(px(0.)).child(tag(n, t(es, "Pantallas", "Screens")))), None => nav })
}

fn bottombar(es: bool) -> Div {
    div().h(px(30.)).flex_none().flex().items_center().gap(px(12.)).px(px(8.)).bg(c(0x080B12)).border_t_1().border_color(c(BORDER)).text_size(px(10.5)).text_color(c(MUTED))
        .child(div().flex().items_center().gap(px(5.)).child(icon("gear", 12., MUTED)).child(t(es, "Configuración", "Settings")))
}

fn quotas() -> Div {
    div().flex().items_center().gap(px(6.)).text_size(px(10.5)).child(div().text_color(c(TEXT_2)).child("claude")).child(div().text_color(c(DIM)).child("5h"))
        .child(div().w(px(32.)).h(px(4.)).rounded_full().bg(c(BORDER)).child(div().h_full().w(relative(0.32)).rounded_full().bg(c(0x94A3B8))))
        .child(mono("32%").text_color(c(TEXT_2)))
}

fn group(st: &str, es: bool, n: usize) -> Div {
    div().flex().items_center().gap(px(7.)).h(px(22.)).px(px(6.)).text_size(px(10.5)).text_color(c(MUTED))
        .child(dot(stage_color(st))).child(div().text_color(c(TEXT_2)).child(stage_name(st, es)))
        .child(mono(st.to_string()).text_size(px(9.5)).text_color(c(DIM))).child(div().flex_1()).child(n.to_string())
}

/// A row of the Pending list.
fn row(key: &str, int: Option<&str>, lane: Option<&str>, sub: impl Into<SharedString>, sub_col: u32, working: Option<&'static str>, on: bool) -> Div {
    div().flex().flex_col().gap(px(4.)).p(px(8.)).rounded(px(8.)).border_1()
        .when(on, |d| d.bg(c(SURFACE_2)).border_color(c(0x23345F))).when(!on, |d| d.border_color(gpui::transparent_black()))
        .child(div().flex().items_center().gap(px(6.))
            .child(mono(key.to_string()).text_size(px(11.)).text_color(c(BLUE_TEXT)))
            .children(int.map(|k| chip(k.to_string(), 0x4A1E3D, 0xFFB3D9)))
            .children(lane.map(|l| chip(l.to_string(), BORDER_2, MUTED)))
            .child(div().flex_1())
            .children(working.map(|id| live_dot(id, BLUE_TEXT))))
        .child(div().text_size(px(11.)).text_color(c(sub_col)).child(sub.into()))
}

fn pipeline(es: bool, cur: usize) -> Div {
    let flow = ["ANALYSIS", "DEVELOPMENT", "TESTING", "CODE_REVIEW", "DELIVERY", "ACCEPTANCE", "CLOSED"];
    div().flex().flex_wrap().gap(px(3.)).children(flow.iter().enumerate().map(move |(i, st)| {
        let (done, now) = (i < cur, i == cur);
        div().flex().items_center().gap(px(4.)).h(px(20.)).px(px(7.)).rounded_full().text_size(px(10.))
            .when(now, |d| d.bg(c(SURFACE_2)).border_1().border_color(c(BLUE)).text_color(c(TEXT)).font_weight(FontWeight::SEMIBOLD))
            .when(done, |d| d.border_1().border_color(c(0x1E2638)).bg(c(SURFACE)).text_color(c(TEXT_2)))
            .when(!now && !done, |d| d.border_1().border_dashed().border_color(c(BORDER_2)).text_color(c(DIM)))
            .children(done.then(|| icon("check", 9., GREEN)))
            .children(now.then(|| dot(BLUE_TEXT)))
            .child(stage_name(st, es))
    }))
}

fn detail_head(d: &Sample, es: bool, cur: usize, lane: Option<&str>) -> Div {
    div().flex().flex_col().gap(px(8.))
        .child(div().flex().items_center().gap(px(7.))
            .child(mono(d.ext.clone()).text_size(px(13.)).font_weight(FontWeight::SEMIBOLD).text_color(c(BLUE_TEXT)))
            .children(d.int.clone().map(|k| chip(format!("{} {k}", t(es, "issue", "issue")), 0x4A1E3D, 0xFFB3D9)))
            .children(lane.map(|l| chip(format!("{} {l}", t(es, "carril", "lane")), BORDER_2, TEXT_2))))
        .child(pipeline(es, cur))
}

/// A "what's next" card (click = copy).
fn card(what: impl Into<SharedString>, cmd: impl Into<SharedString>) -> Div {
    div().flex().items_center().gap(px(8.)).p(px(8.)).rounded(px(9.)).border_1().border_color(c(0x1E2638)).bg(c(SURFACE))
        .child(div().flex_1().min_w(px(0.)).flex().flex_col().gap(px(2.)).child(div().text_size(px(10.5)).text_color(c(MUTED)).child(what.into()))
            .child(mono(cmd.into()).text_size(px(11.)).text_color(c(TEXT))))
        .child(icon("copy", 12., MUTED))
}

fn section(label: &'static str) -> Div { div().text_size(px(9.5)).text_color(c(DIM)).child(label) }

/// Claude Code with the pasted command.
fn claude(cmd: impl Into<SharedString>) -> Div {
    div().flex().flex_col().gap(px(6.)).p(px(10.)).rounded(px(9.)).bg(c(0x070A12)).border_1().border_color(c(0x3A2A1E))
        .child(div().flex().items_center().gap(px(6.)).child(div().size(px(8.)).rounded_full().bg(c(0xD97757))).child(div().text_size(px(10.5)).text_color(c(0xF0B79E)).child("Claude Code")))
        .child(div().flex().items_start().gap(px(6.)).font_family(MONO_FONT).text_size(px(11.))
            .child(div().text_color(c(DIM)).child(">")).child(div().min_w(px(0.)).text_color(c(TEXT)).child(cmd.into()))
            .child(div().w(px(6.)).h(px(13.)).bg(c(TEXT_2)).with_animation("fig-caret", Animation::new(Duration::from_millis(1000)).repeat().with_easing(gpui::pulsating_between(0.0, 1.0)), |d, t| d.opacity(t))))
}

fn event(when: &'static str, from: &str, to: &str, detail: impl Into<SharedString>, es: bool) -> Div {
    div().flex().gap(px(8.)).py(px(4.))
        .child(mono(when).w(px(64.)).flex_none().text_size(px(10.)).text_color(c(DIM)))
        .child(div().flex_1().min_w(px(0.)).flex().flex_col().gap(px(1.))
            .child(div().flex().items_center().gap(px(5.)).text_size(px(11.))
                .child(div().text_color(c(stage_color(from))).child(stage_name(from, es))).child(icon("arrow", 9., DIM))
                .child(div().text_color(c(stage_color(to))).child(stage_name(to, es))))
            .child(div().text_size(px(10.5)).text_color(c(TEXT_2)).child(detail.into())))
}

fn toast(es: bool, cmd: &str) -> Div {
    div().flex().items_center().gap(px(6.)).px(px(9.)).py(px(4.)).rounded(px(7.)).bg(c(0x0F2A1E)).border_1().border_color(c(0x1D5C40))
        .text_size(px(10.5)).text_color(c(0xA7F3D0)).child(icon("check", 10., GREEN)).child(format!("{} · {}", t(es, "Copiado", "Copied"), cmd.split_whitespace().next().unwrap_or("")))
}

// ================================================================ one figure per step

fn welcome(es: bool) -> Div {
    let faint = |w: f32| div().h(px(9.)).w(px(w)).rounded_full().bg(c(0x141B2B));
    let list = div().flex_1().p(px(14.)).flex().flex_col().gap(px(10.))
        .child(faint(120.)).child(faint(220.)).child(faint(180.)).child(faint(240.)).child(faint(150.));
    frame()
        .child(titlebar().child(tag(1, t(es, "Un proyecto por pestaña · el + agrega otro", "One project per tab · + adds another"))))
        .child(div().h(px(170.)).flex().child(sidebar(es, false, Some(2))).child(list.bg(c(PANEL))))
        .child(bottombar(es).child(tag(3, t(es, "Conectores y este tutorial", "Connectors and this tutorial"))).child(div().flex_1()).child(quotas()).child(tag(4, t(es, "Cuotas de IA", "AI quotas"))))
}

fn words(es: bool, d: &Sample) -> Div {
    let list = div().w(px(250.)).flex_none().p(px(8.)).rounded(px(12.)).border_1().border_color(c(BORDER_2)).bg(c(PANEL))
        .child(group("DEVELOPMENT", es, 1))
        .child(row(&d.ext, d.int.as_deref(), Some("light"), format!("{} claude", t(es, "Trabajando:", "Working:")), MUTED, Some("fig-w-dot"), true));
    let mut legends = div().flex_1().flex().flex_col().gap(px(10.))
        .child(legend(mono(d.ext.clone()).text_size(px(11.)).text_color(c(BLUE_TEXT)), t(es, "request: el pedido del cliente", "request: the customer ticket")));
    if let Some(k) = &d.int { legends = legends.child(legend(chip(k.clone(), 0x4A1E3D, 0xFFB3D9), t(es, "issue: la tarea del equipo", "issue: the team's task"))); }
    legends = legends
        .child(legend(div().flex().items_center().gap(px(6.)).child(dot(stage_color("DEVELOPMENT"))).child(div().text_size(px(11.)).text_color(c(TEXT_2)).child(stage_name("DEVELOPMENT", es))), t(es, "etapa: el grupo donde está", "stage: the group it is in")))
        .child(legend(chip("light", BORDER_2, MUTED), t(es, "carril: direct, light o full", "lane: direct, light or full")))
        .child(legend(div().flex().items_center().gap(px(6.)).child(live_dot("fig-w-dot2", BLUE_TEXT)).child(div().text_size(px(11.)).text_color(c(MUTED)).child(t(es, "Trabajando", "Working"))), t(es, "un agente está trabajando en el pedido", "an agent is working on the request")));
    div().flex().items_center().gap(px(20.)).child(hl("fig-w", list)).child(legends.min_w(px(0.)))
}

fn map(es: bool, d: &Sample) -> Div {
    let head = div().p(px(14.)).rounded(px(12.)).border_1().border_color(c(BORDER_2)).bg(c(PANEL)).child(detail_head(d, es, 1, Some("light")));
    div().flex().flex_col().gap(px(14.))
        .child(hl("fig-map", head))
        .child(div().flex().flex_wrap().items_center().gap(px(16.)).text_size(px(11.5)).text_color(c(TEXT_2))
            .child(div().flex().items_center().gap(px(6.)).child(icon("check", 11., GREEN)).child(t(es, "etapa terminada", "finished stage")))
            .child(div().flex().items_center().gap(px(6.)).child(div().w(px(18.)).h(px(12.)).rounded_full().border_1().border_color(c(BLUE))).child(t(es, "donde está ahora", "where it is now")))
            .child(div().flex().items_center().gap(px(6.)).child(div().w(px(18.)).h(px(12.)).rounded_full().border_1().border_dashed().border_color(c(BORDER_2))).child(t(es, "lo que falta", "what is left")))
            .child(div().flex().items_center().gap(px(6.)).child(dot(AMBER)).child(t(es, "BLOCKED: espera a una persona", "BLOCKED: waiting for a person"))))
}

fn next(es: bool, d: &Sample) -> Div {
    let cmd = format!("/orqen:analyze {}", d.ext);
    flow(vec![
        (t(es, "Elegí el pedido", "Pick the request"), div().flex().flex_col().gap(px(4.)).child(group("NEW", es, 1))
            .child(hl("fig-n1", row(&d.ext, None, None, t(es, "Espera al analista", "Waiting for the analyst"), MUTED, None, true))).into_any_element()),
        (t(es, "Clic en QUÉ SIGUE", "Click WHAT'S NEXT"), div().flex().flex_col().gap(px(6.)).child(section(t(es, "QUÉ SIGUE", "WHAT'S NEXT")))
            .child(hl("fig-n2", card(t(es, "Analizar (analista, en Claude Code)", "Analyze (analyst, in Claude Code)"), cmd.clone())))
            .child(toast(es, &cmd)).into_any_element()),
        (t(es, "Pegalo en Claude Code", "Paste it in Claude Code"), claude(cmd.clone()).into_any_element()),
    ])
}

fn pending(es: bool, d: &Sample) -> Div {
    let list = div().w(px(230.)).flex_none().h_full().border_r_1().border_color(c(BORDER)).p(px(8.)).flex().flex_col().gap(px(2.))
        .child(group("NEW", es, 1)).child(row("SOP-131", None, None, t(es, "Espera al analista", "Waiting for the analyst"), MUTED, None, false))
        .child(group("DEVELOPMENT", es, 1)).child(row(&d.ext, d.int.as_deref(), Some("light"), t(es, "Listo para un agente", "Ready for an agent"), MUTED, None, true))
        .child(group("BLOCKED", es, 1)).child(row("SOP-118", None, None, t(es, "Bloqueado: espera a una persona", "Blocked: waiting for a person"), AMBER, None, false));
    let detail = div().flex_1().min_w(px(0.)).p(px(12.)).flex().flex_col().gap(px(10.))
        .child(detail_head(d, es, 1, Some("light")))
        .child(div().flex().flex_col().gap(px(5.)).child(section(t(es, "QUÉ SIGUE", "WHAT'S NEXT")))
            .child(card(t(es, "Implementar", "Implement"), format!("/orqen:implement {}", d.int.clone().unwrap_or(d.ext.clone())))))
        .child(div().flex().flex_col().child(section(t(es, "RECORRIDO", "HISTORY")))
            .child(event("11-18 10:42", "ANALYSIS", "DEVELOPMENT", t(es, "Análisis cerrado", "Analysis closed"), es)));
    frame().child(div().h(px(300.)).flex().bg(c(PANEL)).child(sidebar(es, false, None)).child(hln_in("fig-p1", 1, list.h_full())).child(div().flex_1().min_w(px(0.)).child(hln_in("fig-p2", 2, detail.h_full()))))
        .child(bottombar(es).child(tag(1, t(es, "Quién tiene que actuar en cada pedido", "Who has to act on each request"))).child(tag(2, t(es, "Etapa, qué sigue y qué le pasó", "Stage, what's next and what happened"))))
}

fn analysis(es: bool, d: &Sample) -> Div {
    let cmd = format!("/orqen:analyze {}", d.ext);
    flow(vec![
        (t(es, "Elegilo y copiá Analizar", "Pick it and copy Analyze"), div().flex().flex_col().gap(px(8.))
            .child(row(&d.ext, None, None, t(es, "Espera al analista", "Waiting for the analyst"), MUTED, None, true))
            .child(hl("fig-a2", card(t(es, "Analizar", "Analyze"), cmd.clone()))).into_any_element()),
        (t(es, "Conversá con el agente", "Talk with the agent"), claude(cmd.clone()).into_any_element()),
        (t(es, "Pasa solo a Desarrollo", "It moves to Development"), div().flex().flex_col().gap(px(4.)).child(group("DEVELOPMENT", es, 1))
            .child(row(&d.ext, d.int.as_deref(), Some("light"), t(es, "Listo para un agente", "Ready for an agent"), MUTED, None, true)).into_any_element()),
    ])
}

fn implement(es: bool, d: &Sample) -> Div {
    let key = d.int.clone().unwrap_or(d.ext.clone());
    let part = |name: &'static str, st: &'static str, col: u32| div().flex().items_center().gap(px(7.)).text_size(px(10.5))
        .child(dot(col)).child(div().flex_1().text_color(c(TEXT_2)).child(name)).child(div().text_color(c(col)).child(st));
    flow(vec![
        (t(es, "Copiá Implementar", "Copy Implement"), hl("fig-i1", card(t(es, "Implementar", "Implement"), format!("/orqen:implement {key}"))).into_any_element()),
        (t(es, "Pegalo en Claude Code", "Paste it in Claude Code"), claude(format!("/orqen:implement {key}")).into_any_element()),
        (t(es, "Mirá cómo avanza", "Watch it progress"), div().flex().flex_col().gap(px(8.))
            .child(hl("fig-i2", row(&d.ext, d.int.as_deref(), Some("light"), format!("{} claude", t(es, "Trabajando:", "Working:")), MUTED, Some("fig-i-dot"), true)))
            .child(div().flex().flex_col().gap(px(5.)).child(section(t(es, "IMPLEMENTACIÓN", "IMPLEMENTATION")))
                .child(part("api", t(es, "integrada", "integrated"), GREEN)).child(part("ui", t(es, "trabajando", "working"), BLUE_TEXT)).child(part("tests", t(es, "en cola", "queued"), DIM)))
            .into_any_element()),
    ])
}

fn review(es: bool, d: &Sample) -> Div {
    let key = d.int.clone().unwrap_or(d.ext.clone());
    let detail = div().p(px(14.)).rounded(px(12.)).border_1().border_color(c(BORDER_2)).bg(c(PANEL)).flex().flex_col().gap(px(12.))
        .child(div().flex().items_center().gap(px(10.)).child(detail_head(d, es, 3, None))
            .child(div().flex_1())
            .child(hln("fig-r0", 1, div().flex().items_center().gap(px(5.)).px(px(6.)).child(icon("branch", 11., DIM)).child(mono(format!("feature/{}", d.ext.to_lowercase())).text_size(px(10.5)).text_color(c(MUTED))))))
        .child(div().flex().flex_col().gap(px(6.)).child(section(t(es, "QUÉ SIGUE", "WHAT'S NEXT")))
            .child(hln("fig-r1", 2, div().flex().gap(px(8.))
                .child(div().flex_1().child(card(t(es, "Abrir el PR", "Open the PR"), format!("/orqen:pr {key}"))))
                .child(div().flex_1().child(card(t(es, "Code review (senior)", "Code review (senior)"), format!("/orqen:code-review {key}")))))));
    div().flex().flex_col().gap(px(10.)).child(detail)
        .child(div().flex().items_center().gap(px(10.))
            .child(tag(1, t(es, "La rama del pedido: el PR se abre desde ahí", "The request branch: the PR is opened from it")))
            .child(tag(2, t(es, "Un clic copia cada comando", "One click copies each command"))))
}

fn watch(es: bool, d: &Sample) -> Div {
    let feed = div().flex().flex_col()
        .child(crate::ui::appear("fig-wa-ev", 0, event("11-18 11:05", "DEVELOPMENT", "TESTING", t(es, "Tests en verde, pasa a testing", "Tests green, moves to testing"), es)))
        .child(event("11-18 10:42", "ANALYSIS", "DEVELOPMENT", t(es, "Análisis cerrado", "Analysis closed"), es))
        .child(event("11-18 09:15", "NEW", "ANALYSIS", t(es, "Lo tomó el analista", "Taken by the analyst"), es));
    flow(vec![
        (t(es, "El punto azul = trabajando", "Blue dot = working"), hl("fig-wa1", row(&d.ext, d.int.as_deref(), Some("light"), format!("{} claude", t(es, "Trabajando:", "Working:")), MUTED, Some("fig-wa-dot"), true)).into_any_element()),
        (t(es, "El recorrido se completa solo", "The history fills itself"), div().flex().flex_col().gap(px(4.)).child(section(t(es, "RECORRIDO", "HISTORY"))).child(hl("fig-wa2", feed)).into_any_element()),
    ])
}

fn env(es: bool, d: &Sample) -> Div {
    let procs: Vec<String> = if d.procs.is_empty() { vec!["backend".into(), "frontend".into(), "db".into()] } else { d.procs.iter().take(4).cloned().collect() };
    let rows = procs.iter().enumerate().map(|(i, p)| {
        let on = i + 1 < procs.len() || procs.len() == 1;
        div().flex().items_center().gap(px(10.)).py(px(6.)).border_b_1().border_color(c(0x141A28)).text_size(px(11.))
            .child(if i == 0 { hln("fig-e1", 1, div().size(px(7.)).rounded_full().bg(c(GREEN))).into_any_element() } else { div().size(px(7.)).rounded_full().bg(c(if on { GREEN } else { BORDER_2 })).into_any_element() })
            .child(mono(p.clone()).w(px(90.)).text_color(c(TEXT)))
            .child(mono(if on { format!(":{}", 3000 + i) } else { "—".into() }).w(px(60.)).text_color(c(MUTED)))
            .child(div().flex_1())
            .child(if i == 0 { hln("fig-e3", 3, div().text_color(c(BLUE_TEXT)).child(t(es, "viendo", "viewing"))).into_any_element() } else { div().text_color(c(BLUE_TEXT)).child(t(es, "ver log", "view log")).into_any_element() })
    }).collect::<Vec<_>>();
    let btn = |s: &'static str, primary: bool| div().h(px(24.)).px(px(9.)).flex().items_center().rounded(px(6.)).text_size(px(10.5))
        .when(primary, |d| d.bg(c(BLUE)).text_color(c(0xFFFFFF))).when(!primary, |d| d.border_1().border_color(c(BORDER_2)).text_color(c(TEXT_2))).child(s);
    let main = div().flex_1().min_w(px(0.)).p(px(12.)).flex().flex_col().gap(px(10.))
        .child(div().flex().items_center().gap(px(8.)).child(div().text_size(px(13.)).font_weight(FontWeight::SEMIBOLD).text_color(c(TEXT)).child(t(es, "Entornos", "Environments")))
            .child(div().flex_1())
            .child(hln("fig-e2", 2, div().flex().gap(px(6.)).child(btn(t(es, "Apagar", "Stop"), false)).child(btn(t(es, "Levantar todo (con e2e)", "Start everything (with e2e)"), false)).child(btn(t(es, "Levantar", "Start"), true)))))
        .child(div().flex().flex_col().children(rows))
        .child(div().p(px(8.)).rounded(px(8.)).bg(c(0x070A12)).border_1().border_color(c(BORDER)).flex().flex_col().gap(px(2.)).font_family(MONO_FONT).text_size(px(10.)).text_color(c(MUTED))
            .child(div().flex().items_center().gap(px(6.)).child(live_dot("fig-e-live", GREEN)).child(div().text_color(c(TEXT_2)).child(format!("{} · {}", procs[0], t(es, "en vivo", "live")))))
            .child(div().child("> listening on http://localhost:3000")).child(div().child("GET /api/health 200 4ms")));
    frame().child(div().h(px(235.)).flex().bg(c(PANEL)).child(sidebar(es, true, None)).child(main))
        .child(bottombar(es).child(tag(1, t(es, "Prendido / apagado", "Running / stopped"))).child(tag(2, t(es, "Levantar y apagar con un clic", "Start and stop with one click"))).child(tag(3, t(es, "El log en vivo", "The live log"))))
}

fn problems(es: bool, d: &Sample) -> Div {
    let banner = div().p(px(8.)).rounded(px(8.)).bg(c(0x1D1810)).text_size(px(11.)).text_color(c(AMBER))
        .child(format!("{} {}: 401 Unauthorized", t(es, "No se pudieron consultar los requests", "Could not query the requests"), d.tool));
    let gear = div().flex().flex_wrap().items_center().gap(px(6.)).text_size(px(11.)).text_color(c(TEXT_2))
        .child(icon("gear", 12., MUTED)).child(t(es, "Configuración", "Settings")).child(icon("arrow", 10., DIM))
        .child(icon("plug", 12., MUTED)).child(t(es, "Conectores", "Connectors")).child(icon("arrow", 10., DIM))
        .child(div().px(px(8.)).py(px(2.)).rounded(px(6.)).border_1().border_color(c(0x23345F)).bg(c(0x0F1A36)).text_color(c(0xA9C1FF)).child(t(es, "Probar conexión", "Test connection")));
    flow(vec![
        (t(es, "Pedido trabado", "Request stuck"), div().flex().flex_col().gap(px(4.)).child(group("BLOCKED", es, 1))
            .child(hl("fig-pr1", row("SOP-118", None, None, t(es, "Bloqueado: espera a una persona", "Blocked: waiting for a person"), AMBER, None, true)))
            .child(div().text_size(px(10.5)).text_color(c(MUTED)).child(t(es, "El motivo está en su RECORRIDO.", "The reason is in its HISTORY."))).into_any_element()),
        (t(es, "No lee los tickets", "It can't read the tickets"), div().flex().flex_col().gap(px(8.)).child(hl("fig-pr2", banner)).child(gear).into_any_element()),
    ])
}

fn cheatsheet(es: bool) -> Div {
    let tile = |ic: &'static str, title: &'static str, body: &'static str| div().flex_1().min_w(px(0.)).p(px(14.)).rounded(px(12.)).border_1().border_color(c(BORDER_2)).bg(c(PANEL)).flex().flex_col().gap(px(8.))
        .child(div().size(px(30.)).rounded(px(8.)).bg(c(0x141B2B)).flex().items_center().justify_center().child(icon(ic, 15., BLUE_TEXT)))
        .child(div().text_size(px(13.)).font_weight(FontWeight::SEMIBOLD).text_color(c(TEXT)).child(title))
        .child(div().text_size(px(11.5)).text_color(c(MUTED)).child(body));
    div().flex().gap(px(12.))
        .child(tile("pending", t(es, "Pendientes", "Pending"), t(es, "Qué hay para hacer y qué sigue en cada pedido.", "What needs doing and what's next for each request.")))
        .child(tile("copy", t(es, "QUÉ SIGUE", "WHAT'S NEXT"), t(es, "Un clic copia el comando para Claude Code.", "One click copies the command for Claude Code.")))
        .child(tile("env", t(es, "Entornos", "Environments"), t(es, "Qué está prendido, levantar, apagar, log en vivo.", "What is running, start, stop, live log.")))
        .child(tile("gear", t(es, "Configuración", "Settings"), t(es, "Conectores de tickets y este tutorial.", "Ticket connectors and this tutorial.")))
}
