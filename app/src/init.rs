//! Visual `orqen init` for a folder without orqen: project options and live progress.
//! Provider accounts are managed separately in Settings > Connectors.
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use gpui::{
    AnyElement, Context, EventEmitter, FontWeight, IntoElement, Render, SharedString, Window, div, linear_color_stop,
    linear_gradient, prelude::*, px,
};

use crate::cli::Cli;
use crate::logo::logo;
use crate::theme::*;
use crate::ui::{Kind, appear, button, icon, live_dot, mono};

pub struct Initialized;

#[derive(PartialEq)]
enum Phase { Intro, Form, Running, Failed }

pub struct InitWizard {
    cli: Cli,
    es: bool,
    ai: bool,
    openspec: bool,
    log: Arc<Mutex<Vec<String>>>,
    phase: Phase,
    opened: Instant,
}

impl EventEmitter<Initialized> for InitWizard {}

fn t(es: bool, a: &'static str, b: &'static str) -> &'static str { if es { a } else { b } }

impl InitWizard {
    pub fn new(cli: Cli, es: bool, _cx: &mut Context<Self>) -> Self {
        Self { cli, es, ai: true, openspec: true, log: Arc::new(Mutex::new(vec![])), phase: Phase::Intro, opened: Instant::now() }
    }

    fn start(&mut self, cx: &mut Context<Self>) {
        if self.phase == Phase::Running { return; }
        self.phase = Phase::Running;
        self.log.lock().unwrap().clear();
        let mut args = vec!["init", "--yes", "--no-animation"];
        if !self.ai { args.push("--no-ai"); }
        if !self.openspec { args.push("--no-openspec"); }
        let args: Vec<String> = args.into_iter().map(String::from).collect();
        let (cli, log) = (self.cli.clone(), self.log.clone());
        let done: Arc<Mutex<Option<bool>>> = Arc::new(Mutex::new(None));
        let flag = done.clone();
        std::thread::spawn(move || {
            let a: Vec<&str> = args.iter().map(String::as_str).collect();
            let ok = cli.stream(&a, None, log.clone()).unwrap_or(false) && cli.has_orqen();
            *flag.lock().unwrap() = Some(ok);
        });
        // repaint while the CLI writes, until it ends
        cx.spawn(async move |this, cx| loop {
            cx.background_executor().timer(Duration::from_millis(250)).await;
            let r = *done.lock().unwrap();
            let alive = this.update(cx, |this, cx| {
                if let Some(ok) = r { if ok { cx.emit(Initialized); } else { this.phase = Phase::Failed; } }
                cx.notify();
            }).is_ok();
            if !alive || r.is_some() { break; }
        }).detach();
        cx.notify();
    }

    fn form(&self, cx: &mut Context<Self>) -> AnyElement {
        let es = self.es;
        let name = self.cli.repo.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let check = |id: &'static str, on: bool, title: &'static str, body: &'static str, which: u8, cx: &mut Context<Self>| {
            div().id(id).flex().items_start().gap(px(12.)).p(px(12.)).rounded(px(10.)).border_1().border_color(c(if on { 0x23345F } else { 0x1E2638 })).cursor_pointer()
                .hover(|h| h.bg(c(HOVER)))
                .child(div().mt(px(1.)).size(px(18.)).flex_none().rounded(px(5.)).flex().items_center().justify_center()
                    .when(on, |d| d.bg(c(BLUE))).when(!on, |d| d.border_1().border_color(c(BORDER_2)))
                    .children(on.then(|| icon("check", 12., 0xFFFFFF))))
                .child(div().flex_1().flex().flex_col().gap(px(2.)).child(div().text_size(px(13.)).text_color(c(TEXT)).child(title)).child(div().text_size(px(12.)).text_color(c(MUTED)).child(body)))
                .on_click(cx.listener(move |this, _, _, cx| { if which == 0 { this.ai = !this.ai } else { this.openspec = !this.openspec }; cx.notify(); }))
        };
        let section = |title: &'static str| div().mt(px(8.)).text_size(px(11.)).font_weight(FontWeight::SEMIBOLD).text_color(c(DIM)).child(title);
        div().id("init-scroll").size_full().overflow_y_scroll().flex().flex_col().items_center().child(
            div().flex_none().w_full().max_w(px(720.)).px(px(24.)).py(px(36.)).flex().flex_col().gap(px(14.))
                .child(appear("init-head", 0, div().flex().items_center().gap(px(16.))
                    .child(logo(44., 3.0, 1.0, 1.0))
                    .child(div().flex().flex_col().gap(px(3.))
                        .child(div().text_size(px(22.)).font_weight(FontWeight::SEMIBOLD).text_color(c(TEXT)).child(format!("{} {name}", t(es, "Inicializar ORQEN en", "Set up ORQEN in"))))
                        .child(mono(self.cli.repo.display().to_string()).text_size(px(11.5)).text_color(c(DIM))))))
                .child(section(t(es, "OPCIONES", "OPTIONS")))
                .child(check("opt-ai", self.ai, t(es, "Analizar el repo con IA", "Analyze the repo with AI"), t(es, "Más preciso; usa el agente instalado (Claude Code, Codex…). Tarda un poco más.", "More accurate; uses the installed agent (Claude Code, Codex…). Takes a bit longer."), 0, cx))
                .child(check("opt-os", self.openspec, t(es, "Instalar OpenSpec", "Install OpenSpec"), t(es, "Las especificaciones de los cambios (carriles light y full).", "Specs of the changes (light and full lanes)."), 1, cx))
                .child(div().mt(px(10.)).flex().items_center().gap(px(12.))
                    .child(div().flex_1().text_size(px(11.5)).text_color(c(DIM)).child(t(es, "Las cuentas se configuran una sola vez en Configuración → Conectores.", "Provider accounts are configured once in Settings → Connectors.")))
                    .child(button("init-cancel", t(es, "Cancelar", "Cancel"), Kind::Ghost, cx.listener(|this, _, _, cx| { this.phase = Phase::Intro; cx.notify(); })))
                    .child(button("init-go", t(es, "Inicializar", "Set up"), Kind::Primary, cx.listener(|this, _, _, cx| this.start(cx)))))
        ).into_any_element()
    }

    fn intro(&self, cx: &mut Context<Self>) -> AnyElement {
        let es = self.es;
        let name = self.cli.repo.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let steps = [
            t(es, "Detecta cómo está armado el proyecto y cómo se levanta cada parte", "Detects how the project is built and how each part starts"),
            t(es, "Instala las guías y comandos para los agentes (AGENTS.md, /orqen:*)", "Installs the guides and commands for the agents (AGENTS.md, /orqen:*)"),
            t(es, "Configura OpenSpec para las especificaciones", "Sets up OpenSpec for the specs"),
            t(es, "Los conectores se configuran después, desde Configuración", "Configure connectors afterwards in Settings"),
        ];
        div().size_full().flex().items_center().justify_center().child(
            div().w_full().max_w(px(560.)).px(px(24.)).flex().flex_col().items_center().gap(px(18.))
                .child(appear("intro-logo", 0, logo(64., 3.4, 1.0, 1.0)))
                .child(appear("intro-title", 60, div().flex().flex_col().items_center().gap(px(6.))
                    .child(div().text_size(px(22.)).font_weight(FontWeight::SEMIBOLD).text_color(c(TEXT)).child(format!("{name} {}", t(es, "todavía no usa ORQEN", "doesn't use ORQEN yet"))))
                    .child(mono(self.cli.repo.display().to_string()).text_size(px(11.5)).text_color(c(DIM)))))
                .child(appear("intro-steps", 120, div().w_full().flex().flex_col().gap(px(9.)).p(px(16.)).rounded(px(12.)).bg(c(SURFACE)).border_1().border_color(c(0x1E2638))
                    .child(div().text_size(px(11.)).font_weight(FontWeight::SEMIBOLD).text_color(c(DIM)).child(t(es, "AL INICIALIZAR, ORQEN…", "SETTING UP, ORQEN…")))
                    .children(steps.iter().map(|s| div().flex().items_center().gap(px(10.)).text_size(px(12.5)).text_color(c(TEXT_2)).child(icon("check", 12., BLUE_TEXT)).child(*s)))))
                .child(appear("intro-go", 180, button("intro-go", t(es, "Inicializar repo", "Set up repo"), Kind::Primary, cx.listener(|this, _, _, cx| { this.phase = Phase::Form; cx.notify(); }))))
                .child(div().text_size(px(11.5)).text_color(c(DIM)).child(t(es, "No toca tu código: agrega la carpeta orqen/ y las guías para los agentes.", "It doesn't touch your code: it adds the orqen/ folder and the agent guides.")))
        ).into_any_element()
    }

    fn progress(&self, cx: &mut Context<Self>) -> AnyElement {
        let es = self.es;
        let lines = self.log.lock().unwrap().clone();
        let running = self.phase == Phase::Running;
        let steps: Vec<String> = lines.iter().filter_map(|l| {
            let x = l.trim_start_matches(['│', ' ']);
            x.strip_prefix("◇").or(x.strip_prefix("◆")).map(|s| s.trim().trim_end_matches(['─', '╮', ' ']).trim().to_string())
        }).filter(|s| !s.is_empty()).collect();
        let n = steps.len();
        let tail: Vec<String> = lines.iter().rev().take(14).rev().cloned().collect();
        div().size_full().flex().justify_center().child(
            div().w_full().max_w(px(720.)).px(px(24.)).py(px(36.)).flex().flex_col().gap(px(16.))
                .child(div().flex().items_center().gap(px(14.))
                    .child(logo(40., 3.0, if running { ((self.opened.elapsed().as_secs_f32() * 0.6) % 1.0).max(0.15) } else { 1.0 }, if running { 0.0 } else { 1.0 }))
                    .child(div().flex().flex_col().gap(px(3.))
                        .child(div().text_size(px(20.)).font_weight(FontWeight::SEMIBOLD).text_color(c(TEXT)).child(if running { t(es, "Inicializando…", "Setting up…") } else { t(es, "No se pudo inicializar", "Setup failed") }))
                        .child(div().text_size(px(12.)).text_color(c(MUTED)).child(if running { t(es, "orqen está preparando el proyecto. Puede tardar un par de minutos.", "orqen is preparing the project. It can take a couple of minutes.") } else { t(es, "Revisá el detalle de abajo y probá de nuevo.", "Check the detail below and try again.") }))))
                .child(div().h(px(4.)).rounded_full().bg(c(BORDER)).child(div().h_full().rounded_full().w(gpui::relative(((n as f32 + 1.0) / 9.0).min(if running { 0.95 } else { 1.0 })))
                    .bg(linear_gradient(90., linear_color_stop(h(BLUE), 0.), linear_color_stop(h(MAGENTA), 1.)))))
                .child(div().flex().flex_col().gap(px(6.)).children(steps.iter().enumerate().map(|(i, s)| {
                    let last = i + 1 == n && running;
                    let failed = i + 1 == n && !running;
                    appear(("st", i), 0, div().flex().items_center().gap(px(10.)).text_size(px(13.)).text_color(c(if last { TEXT } else { TEXT_2 }))
                        .child(if last { div().size(px(12.)).flex().items_center().justify_center().child(live_dot(("st-s", i), BLUE_TEXT)).into_any_element() } else if failed { icon("x", 12., RED).into_any_element() } else { icon("check", 12., GREEN).into_any_element() })
                        .child(SharedString::from(s.clone())))
                })))
                .child(div().p(px(12.)).rounded(px(10.)).bg(c(0x070A12)).border_1().border_color(c(BORDER)).font_family(MONO_FONT).text_size(px(11.)).text_color(c(MUTED))
                    .children(tail.into_iter().map(|l| div().truncate().child(l))))
                .when(!running, |d| d.child(div().flex().gap(px(8.))
                    .child(button("init-back", t(es, "Volver", "Back"), Kind::Ghost, cx.listener(|this, _, _, cx| { this.phase = Phase::Form; cx.notify(); })))
                    .child(button("init-retry", t(es, "Reintentar", "Retry"), Kind::Primary, cx.listener(|this, _, _, cx| { this.phase = Phase::Form; this.start(cx); })))))
        ).into_any_element()
    }
}

impl Render for InitWizard {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if self.phase == Phase::Running { window.request_animation_frame(); }
        let body = match self.phase { Phase::Intro => self.intro(cx), Phase::Form => self.form(cx), _ => self.progress(cx) };
        div().size_full().bg(c(PANEL)).child(body)
    }
}

