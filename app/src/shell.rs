//! The window: title bar with window controls, one tab per project (like Fork), the project view, and the bottom bar
//! with the settings gear and the AI quotas of this machine (like Orca). Also hosts the opening splash (splash.rs).
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use gpui::{
    AnyElement, Context, Entity, FontWeight, IntoElement, PathPromptOptions, Render, SharedString, Window, WindowControlArea, div,
    prelude::*, px,
};
use serde_json::Value;

use crate::cli::{self, Cli};
use crate::logo::logo;
use crate::project::{ProjectView, Settings};
use crate::splash;
use crate::state;
use crate::theme::*;
use crate::ui::{Kind, button, dot, icon, live_dot, mono, skeleton};

/// Colors that tell the tabs apart.
const TAB_COLORS: [u32; 6] = [BLUE_TEXT, MAGENTA_TEXT, GREEN, AMBER, VIOLET, 0x5EEAD4];

pub struct Shell {
    projects: Vec<Entity<ProjectView>>,
    active: usize,
    base: Cli,
    es: bool,
    /// When the splash started; None = it starts with the next frame (the clock runs from the first frame on screen,
    /// so a slow start never eats the animation).
    splash_at: Option<Instant>,
    /// Bring the window to the front on the next frame (another `orqen` sent a folder).
    activate: bool,
    usage: Option<Value>,
    inbox: Arc<Mutex<Vec<PathBuf>>>,
    /// The `+` dialog: import or create a project.
    new_project: Option<Entity<crate::create::NewProject>>,
}

fn t(es: bool, a: &'static str, b: &'static str) -> &'static str { if es { a } else { b } }
fn s(v: &Value, k: &str) -> String { v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string() }

impl Shell {
    pub fn new(base: Cli, tabs: Vec<PathBuf>, active: Option<PathBuf>, inbox: Arc<Mutex<Vec<PathBuf>>>, cx: &mut Context<Self>) -> Self {
        let es = std::env::var("ORQEN_LANG").map(|l| l.starts_with("es")).unwrap_or(true);
        let mut this = Self { projects: vec![], active: 0, base, es, splash_at: None, activate: false, usage: None, inbox, new_project: None };
        for repo in tabs { this.add(repo, false, cx); }
        if let Some(a) = active { this.open_repo(a, cx); }
        this.select(this.active.min(this.projects.len().saturating_sub(1)), cx);
        this.load_usage(cx);
        // another `orqen` sends its folder here (instance.rs); quotas every 5 minutes
        cx.spawn(async move |this, cx| {
            let mut n = 0u32;
            loop {
                cx.background_executor().timer(Duration::from_millis(300)).await;
                n += 1;
                let ok = this.update(cx, |this, cx| {
                    let incoming: Vec<PathBuf> = std::mem::take(&mut *this.inbox.lock().unwrap());
                    if !incoming.is_empty() {
                        for repo in incoming { this.open_repo(repo, cx); }
                        // opened from the terminal: come to the front and play the opening again
                        this.splash_at = None;
                        this.activate = true;
                        cx.notify();
                    }
                    if n % 1000 == 0 { this.load_usage(cx); }
                }).is_ok();
                if !ok { break; }
            }
        }).detach();
        this
    }

    fn add(&mut self, repo: PathBuf, select: bool, cx: &mut Context<Self>) {
        let cli = Cli { repo, ..self.base.clone() };
        let view = cx.new(|cx| ProjectView::new(cli, cx));
        cx.observe(&view, |_, _, cx| cx.notify()).detach();
        self.projects.push(view);
        if select { self.select(self.projects.len() - 1, cx); }
    }

    /// Opens a project in a tab (or switches to it if it is already open).
    pub fn open_repo(&mut self, path: PathBuf, cx: &mut Context<Self>) {
        let repo = cli::find_repo(&path).unwrap_or(path);
        let key = |p: &PathBuf| p.canonicalize().unwrap_or(p.clone());
        if let Some(i) = self.projects.iter().position(|p| key(&p.read(cx).cli.repo) == key(&repo)) { self.select(i, cx); }
        else { self.add(repo, true, cx); }
        self.save(cx);
    }

    fn select(&mut self, i: usize, cx: &mut Context<Self>) {
        self.active = i;
        for (n, p) in self.projects.iter().enumerate() {
            p.update(cx, |p, cx| { let was = p.active; p.active = n == i; if p.active && !was { p.refresh(cx); } });
        }
        self.save(cx);
        cx.notify();
    }

    fn close(&mut self, i: usize, cx: &mut Context<Self>) {
        if i >= self.projects.len() { return; }
        self.projects.remove(i);
        if self.active >= self.projects.len() { self.active = self.projects.len().saturating_sub(1); }
        if !self.projects.is_empty() { self.select(self.active, cx); } else { self.save(cx); cx.notify(); }
    }

    fn save(&self, cx: &mut Context<Self>) {
        let tabs: Vec<PathBuf> = self.projects.iter().map(|p| p.read(cx).cli.repo.clone()).collect();
        state::save(&tabs, tabs.get(self.active), &self.base);
    }

    /// The `+`: import an existing folder or create a project with `orqen bootstrap`.
    fn add_project(&mut self, cx: &mut Context<Self>) {
        // new projects go next to the current one (usually the folder with all the projects)
        let parent = self.projects.get(self.active).and_then(|p| p.read(cx).cli.repo.parent().map(|x| x.to_path_buf())).unwrap_or_else(state::home);
        let dialog = cx.new(|cx| crate::create::NewProject::new(self.base.clone(), self.es, parent, cx));
        cx.subscribe(&dialog, |this, _, _: &crate::create::Import, cx| { this.new_project = None; this.pick_folder(cx); cx.notify(); }).detach();
        cx.subscribe(&dialog, |this, _, e: &crate::create::Created, cx| { this.new_project = None; this.open_repo(e.0.clone(), cx); cx.notify(); }).detach();
        cx.subscribe(&dialog, |this, _, _: &crate::create::Closed, cx| { this.new_project = None; cx.notify(); }).detach();
        self.new_project = Some(dialog);
        cx.notify();
    }

    fn pick_folder(&mut self, cx: &mut Context<Self>) {
        let rx = cx.prompt_for_paths(PathPromptOptions { files: false, directories: true, multiple: false, prompt: Some(t(self.es, "Abrir proyecto", "Open project").into()) });
        cx.spawn(async move |this, cx| {
            if let Ok(Ok(Some(paths))) = rx.await {
                if let Some(p) = paths.into_iter().next() { this.update(cx, |this, cx| this.open_repo(p, cx)).ok(); }
            }
        }).detach();
    }

    fn load_usage(&mut self, cx: &mut Context<Self>) {
        let cli = self.base.clone();
        cx.spawn(async move |this, cx| {
            let r = cx.background_executor().spawn(async move { cli::usage(&cli) }).await;
            this.update(cx, |this, cx| { match r { Ok(v) => this.usage = Some(v), Err(_) => if this.usage.is_none() { this.usage = Some(serde_json::json!({ "failed": true })) } } cx.notify(); }).ok();
        }).detach();
    }

    fn settings(&mut self, cx: &mut Context<Self>) {
        let Some(p) = self.projects.get(self.active).cloned() else { return };
        p.update(cx, |p, cx| { let open = if p.settings.is_some() { None } else { Some(Settings::Connectors) }; p.open_settings(open, cx) });
    }

    // ================================================================ chrome

    fn title_bar(&self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let mac = cfg!(target_os = "macos");
        let active = self.projects.get(self.active).map(|p| p.read(cx).repo_name());
        div().h(px(38.)).flex_none().flex().items_center().bg(c(0x080B12)).border_b_1().border_color(c(BORDER))
            .child(div().id("drag").flex_1().h_full().flex().items_center().gap(px(10.)).pl(px(if mac { 84. } else { 14. }))
                .window_control_area(WindowControlArea::Drag)
                .on_click(|e, w, _| if e.click_count() == 2 { w.zoom_window() })
                .child(logo(17., 3.2, 1.0, 1.0))
                .child(div().text_size(px(12.5)).font_weight(FontWeight::BOLD).text_color(c(TEXT)).child("ORQEN"))
                .children(active.map(|n| div().flex().items_center().gap(px(8.)).child(div().text_color(c(DIM)).child("/")).child(div().text_size(px(12.5)).text_color(c(TEXT_2)).child(n)))))
            .when(!mac, |d| d.child(window_controls(window)))
    }

    fn tabs(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let es = self.es;
        let tabs = self.projects.iter().enumerate().map(|(i, p)| {
            let pv = p.read(cx);
            let on = i == self.active;
            let waiting = pv.pending.ready().map(|x| x.iter().filter(|e| s(e, "for") != "agent").count()).unwrap_or(0);
            let color = TAB_COLORS[i % TAB_COLORS.len()];
            div().id(("tab", i)).group(SharedString::from(format!("tab{i}"))).relative().flex_1().max_w(px(260.)).min_w(px(120.)).h_full()
                .flex().items_center().justify_center().gap(px(8.)).px(px(30.)).cursor_pointer().border_r_1().border_color(c(BORDER))
                .when(on, |d| d.bg(c(PANEL)).text_color(c(TEXT)))
                .when(!on, |d| d.text_color(c(MUTED)).hover(|h| h.bg(c(0x0C111C)).text_color(c(TEXT_2))))
                .child(dot(color))
                .child(div().text_size(px(12.5)).truncate().child(pv.repo_name()))
                .children((waiting > 0).then(|| div().px(px(6.)).rounded_full().text_size(px(10.)).bg(c(MAGENTA)).text_color(c(0xFFFFFF)).child(waiting.to_string())))
                .when(on, |d| d.child(div().absolute().top_0().left_0().right_0().h(px(2.)).bg(gpui::linear_gradient(90., gpui::linear_color_stop(h(BLUE), 0.), gpui::linear_color_stop(h(MAGENTA), 1.)))))
                .child(div().id(("tab-x", i)).absolute().right(px(8.)).size(px(18.)).rounded(px(5.)).flex().items_center().justify_center()
                    .invisible().when(on, |d| d.visible()).group_hover(SharedString::from(format!("tab{i}")), |s| s.visible())
                    .hover(|s| s.bg(c(0x1A2236))).child(icon("x", 10., MUTED))
                    .on_click(cx.listener(move |this, _, _, cx| { cx.stop_propagation(); this.close(i, cx) })))
                .on_click(cx.listener(move |this, _, _, cx| this.select(i, cx)))
        }).collect::<Vec<_>>();
        div().h(px(36.)).flex_none().flex().bg(c(SIDEBAR)).border_b_1().border_color(c(BORDER))
            .children(tabs)
            .child(div().id("add-tab").w(px(40.)).h_full().flex().items_center().justify_center().cursor_pointer().hover(|h| h.bg(c(0x0C111C)))
                .child(div().text_size(px(18.)).text_color(c(MUTED)).child("+"))
                .on_click(cx.listener(|this, _, _, cx| this.add_project(cx))))
            .child(div().flex_1())
            .when(self.projects.is_empty(), |d| d.child(div().px(px(14.)).flex().items_center().text_size(px(11.5)).text_color(c(DIM)).child(t(es, "Sin proyectos abiertos", "No open projects"))))
    }

    fn bottom_bar(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let es = self.es;
        let p = self.projects.get(self.active).map(|p| p.read(cx));
        let open = p.and_then(|p| p.items.ready().map(|a| a.iter().filter(|i| s(i, "state") != "CLOSED").count()));
        let running = p.and_then(|p| p.env.ready().and_then(|v| v["processes"].as_array()).map(|a| a.iter().filter(|x| x["corriendo"].as_bool() == Some(true)).count()));
        let toast = p.and_then(|p| p.toast.as_ref().map(|t| t.0.clone()));
        let settings_open = p.map(|p| p.settings.is_some()).unwrap_or(false);
        let agents = self.usage.as_ref().and_then(|u| u["agents"].as_array()).map(|a| a.iter().filter(|x| x["installed"].as_bool() == Some(true)).cloned().collect::<Vec<_>>());
        let quotas: Vec<AnyElement> = match &agents {
            _ if self.usage.as_ref().map(|u| u["failed"].as_bool() == Some(true)).unwrap_or(false) => vec![],
            None => (0..2usize).map(|i| div().flex().items_center().gap(px(7.))
                .child(skeleton(("q-n", i), px(40.), 7.)).child(skeleton(("q-l", i), px(16.), 7.)).child(skeleton(("q-b", i), px(36.), 4.)).child(skeleton(("q-p", i), px(24.), 7.))
                .into_any_element()).collect(),
            Some(a) if a.is_empty() => vec![div().child(t(es, "Sin agentes de IA instalados", "No AI agents installed")).into_any_element()],
            Some(a) => a.iter().enumerate().map(|(i, ag)| quota(i, ag)).collect(),
        };
        div().h(px(30.)).flex_none().flex().items_center().gap(px(14.)).pl(px(6.)).pr(px(14.)).bg(c(0x080B12)).border_t_1().border_color(c(BORDER))
            .text_size(px(11.)).text_color(c(MUTED))
            .child(div().id("gear").flex().items_center().gap(px(6.)).h(px(22.)).px(px(8.)).rounded(px(6.)).cursor_pointer()
                .when(settings_open, |d| d.bg(c(SURFACE_2)).text_color(c(TEXT)))
                .hover(|h| h.bg(c(0x161D2D)).text_color(c(TEXT)))
                .child(icon("gear", 13., if settings_open { TEXT } else { MUTED })).child(t(es, "Configuración", "Settings"))
                .on_click(cx.listener(|this, _, _, cx| this.settings(cx))))
            .child(div().w(px(1.)).h(px(14.)).bg(c(BORDER_2)))
            .children(quotas)
            .child(div().flex_1())
            .children(toast.map(|m| div().text_color(c(TEXT_2)).child(m)))
            .children(open.map(|n| div().flex().items_center().gap(px(6.)).child(live_dot("sb-dot", GREEN)).child(format!("{n} {}", t(es, "abiertos", "open")))))
            .children(running.map(|n| div().child(format!("{n} {}", t(es, "procesos", "processes")))))
    }

    /// The CLI welcome animation (particles, spinning hexagon, shock wave, chromatic wordmark), then the app shows up.
    /// A click skips to the fade-out.
    /// Also says whether it still covers the whole window (before the fade-out): then nothing else is laid out or painted.
    fn splash(&mut self, window: &mut Window, cx: &mut Context<Self>) -> Option<(AnyElement, bool)> {
        // ORQEN_SPLASH_T=<seconds> freezes the splash at that moment (to review a frame).
        let fixed = std::env::var("ORQEN_SPLASH_T").ok().and_then(|v| v.parse::<f32>().ok());
        let started = *self.splash_at.get_or_insert_with(Instant::now);
        let e = fixed.unwrap_or_else(|| started.elapsed().as_secs_f32());
        if e > splash::DURATION { return None; }
        window.request_animation_frame();
        let fade = { let x = ((e - splash::FADE_AT) / (splash::DURATION - splash::FADE_AT)).clamp(0.0, 1.0); x * x * (3.0 - 2.0 * x) };
        Some((div().id("splash").absolute().inset_0().occlude().bg(c(0x070A12)).opacity(1.0 - fade)
            .on_mouse_down(gpui::MouseButton::Left, cx.listener(|this, _, _, cx| {
                let e = this.splash_at.map(|t| t.elapsed().as_secs_f32()).unwrap_or(0.0);
                if e < splash::FADE_AT { this.splash_at = Some(Instant::now() - Duration::from_secs_f32(splash::FADE_AT)); cx.notify(); }
            }))
            .child(splash::splash(e))
            // the app underneath is still rendered in the first frames (dark screen) to warm up text and icon caches,
            // so the first frame of the fade-out doesn't stall
            .into_any_element(), e > 0.12 && e < splash::FADE_AT))
    }
}

/// Minimize / maximize / close, drawn by the app because the system title bar is hidden (Windows, Linux).
fn window_controls(window: &Window) -> impl IntoElement {
    let max = window.is_maximized();
    let btn = |id: &'static str, area: WindowControlArea, name: &'static str, close: bool| {
        div().id(id).w(px(46.)).h_full().flex().items_center().justify_center().window_control_area(area)
            .when(close, |d| d.hover(|h| h.bg(c(0xE81123))))
            .when(!close, |d| d.hover(|h| h.bg(c(0x161D2D))))
            .child(icon(name, 12., TEXT_2))
    };
    div().h_full().flex()
        .child(btn("win-min", WindowControlArea::Min, "win-min", false).on_click(|_, w, _| w.minimize_window()))
        .child(btn("win-max", WindowControlArea::Max, if max { "win-restore" } else { "win-max" }, false).on_click(|_, w, _| w.zoom_window()))
        .child(btn("win-close", WindowControlArea::Close, "x", true).on_click(|_, w, _| w.remove_window()))
}

/// One agent in the bottom bar: name and a small bar per quota window.
fn quota(i: usize, ag: &Value) -> AnyElement {
    let limits = ag["limits"].as_array().cloned().unwrap_or_default();
    let short = match s(ag, "id").as_str() { "claude" => "claude", "codex" => "codex", "gemini" => "gemini", "copilot" => "copilot", "cursor" => "cursor", x => return div().child(x.to_string()).into_any_element() };
    let mut el = div().id(("quota", i)).flex().items_center().gap(px(7.)).child(div().text_color(c(TEXT_2)).child(short));
    if limits.is_empty() {
        el = el.child(div().text_color(c(DIM)).child(ag["version"].as_str().unwrap_or("").to_string()));
    }
    for (j, l) in limits.iter().take(2).enumerate() {
        let used = l["used"].as_f64().unwrap_or(0.0).clamp(0.0, 100.0) as f32;
        let col = if used >= 90.0 { 0xFF8C8C } else if used >= 70.0 { AMBER } else { 0x94A3B8 };
        let eta = l["resetsInMin"].as_u64().map(|m| if m >= 1440 { format!("{}d {}h", m / 1440, (m % 1440) / 60) } else if m >= 60 { format!("{}h {}m", m / 60, m % 60) } else { format!("{m}m") });
        el = el.child(div().flex().items_center().gap(px(5.))
            .when(j > 0, |d| d.ml(px(2.)))
            .child(div().text_color(c(DIM)).child(l["label"].as_str().unwrap_or("").to_string()))
            .child(div().w(px(36.)).h(px(4.)).rounded_full().bg(c(BORDER)).child(div().h_full().rounded_full().w(gpui::relative(used / 100.0)).bg(c(col))))
            .child(mono(format!("{}%", used.round() as i64)).text_color(c(TEXT_2)))
            .children(eta.map(|e| mono(e).text_color(c(DIM)))));
    }
    el.into_any_element()
}

impl Render for Shell {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if std::mem::take(&mut self.activate) { window.activate_window(); }
        // While the splash covers the window, only the splash is rendered: laying out and painting the whole app
        // underneath on every animation frame is what made it stutter.
        let splash = self.splash(window, cx);
        if let Some((el, true)) = splash { return div().size_full().relative().bg(c(0x070A12)).child(el).into_any_element(); }
        let splash = splash.map(|(el, _)| el);
        let es = self.es;
        let body: AnyElement = match self.projects.get(self.active) {
            Some(p) => p.clone().into_any_element(),
            None => div().size_full().flex().flex_col().items_center().justify_center().gap(px(16.)).bg(c(PANEL))
                .child(logo(56., 3.0, 1.0, 1.0))
                .child(div().text_size(px(16.)).font_weight(FontWeight::SEMIBOLD).text_color(c(TEXT)).child(t(es, "Abrí un proyecto", "Open a project")))
                .child(div().max_w(px(420.)).text_size(px(12.5)).text_color(c(MUTED)).text_center()
                    .child(t(es, "Cada proyecto queda en su pestaña. También se abre solo cuando corrés `orqen` en la carpeta del proyecto.", "Each project gets its own tab. It also opens when you run `orqen` in the project folder.")))
                .child(button("open-first", t(es, "Abrir carpeta…", "Open folder…"), Kind::Primary, cx.listener(|this, _, _, cx| this.pick_folder(cx))))
                .into_any_element(),
        };
        div().size_full().relative().flex().flex_col().bg(c(BG)).text_color(c(TEXT)).font_family(UI_FONT).text_size(px(13.))
            .child(self.title_bar(window, cx))
            .child(self.tabs(cx))
            .child(div().flex_1().min_h(px(0.)).child(body))
            .child(self.bottom_bar(cx))
            .children(self.new_project.clone())
            .children(splash)
            .into_any_element()
    }
}

