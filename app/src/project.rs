//! One open project (a tab): its sidebar, screens and the settings panel (connectors, tutorial). The window chrome is in shell.rs.
use std::path::PathBuf;
use std::time::{Duration, Instant};

use gpui::{relative, 
    Animation, AnimationExt as _, AnyElement, ClipboardItem, Context, Entity, FontWeight, IntoElement, Render, SharedString, Window,
    div, ease_out_quint, linear_color_stop, linear_gradient, prelude::*, px,
};
use serde_json::Value;

use crate::cli::{self, Cli};
use crate::theme::*;
use crate::ui::{self, Kind, appear, button, card, chip, dot, icon, icon_button, live_dot, mono, progress_slice, skeleton, skeleton_text};

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Screen { Pending, Env }

/// Tabs of the settings panel opened from the gear in the bottom bar.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Settings { General, Connectors, Tutorial }

impl Screen {
    const NAV: [Screen; 2] = [Screen::Pending, Screen::Env];
    fn icon(self) -> &'static str {
        match self { Screen::Pending => "pending", Screen::Env => "env" }
    }
    fn name(self, es: bool) -> &'static str {
        match (self, es) {
            (Screen::Pending, true) => "Pendientes", (Screen::Pending, false) => "Pending",
            (Screen::Env, true) => "Entornos", (Screen::Env, false) => "Environments",
        }
    }
}

/// A value loaded from the CLI.
#[derive(Default)]
pub enum Load<T> { #[default] Idle, Loading, Ready(T), Failed(String) }
impl<T> Load<T> {
    pub fn ready(&self) -> Option<&T> { if let Load::Ready(v) = self { Some(v) } else { None } }
    fn loading(&self) -> bool { matches!(self, Load::Loading) }
}

pub struct ProjectView {
    /// Settings → Connectors → Configure (None: the cards).
    conn_editor: Option<Entity<crate::connectors::ConnectorsEditor>>,
    general: Option<Entity<crate::general::GeneralSettings>>,
    /// `orqen connectors` is running (the cards stay while it checks again).
    connectors_checking: bool,
    pub cli: Cli,
    pub es: bool,
    screen: Screen,
    pub settings: Option<Settings>,
    settings_at: Instant,
    pub active: bool,
    pub items: Load<Vec<Value>>,      // orqen status --json
    pub pending: Load<Vec<Value>>,    // orqen pending --json (who has to act)
    selected: Option<String>,
    detail: Load<Value>,          // orqen status <KEY> --json
    pub env: Load<Value>,             // orqen env status --json
    env_busy: Option<String>,
    env_output: Option<String>,
    log_of: Option<String>,
    log_lines: Vec<String>,
    pub connectors: Load<Value>,      // orqen connectors --json
    topics: Load<Vec<Value>>,     // orqen tutorial --list --json
    step: Load<Value>,            // orqen tutorial --step N --json
    step_n: usize,
    demo: Load<String>,
    /// Tutorial: show how to do each step in the app (true) or in the terminal (false).
    tut_app: bool,
    swarm: Option<Value>,
    pub toast: Option<(String, Instant)>,
    branch: Option<String>,
    init: Option<Entity<crate::init::InitWizard>>,
}

fn t(es: bool, a: &'static str, b: &'static str) -> &'static str { if es { a } else { b } }
fn s(v: &Value, k: &str) -> String { v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string() }

impl ProjectView {
    pub fn new(cli: Cli, cx: &mut Context<Self>) -> Self {
        let es = std::env::var("ORQEN_LANG").map(|l| l.starts_with("es")).unwrap_or(true);
        let this = Self {
            cli, es, screen: Screen::Pending, settings: None, settings_at: Instant::now(), active: true,
            items: Load::Idle, pending: Load::Idle, selected: None, detail: Load::Idle,
            env: Load::Idle, env_busy: None, env_output: None, log_of: None, log_lines: vec![],
            connectors: Load::Idle, topics: Load::Idle, step: Load::Idle, step_n: 1, demo: Load::Idle, tut_app: true,
            swarm: None, toast: None, branch: None, init: None, connectors_checking: false, conn_editor: None, general: None,
        };
        // The visible tab loads right away; the others wait until the opening animation is over, so a window with
        // several tabs doesn't start a dozen CLI processes at once while the splash is playing.
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(Duration::from_millis(16)).await;
            let active = this.update(cx, |this, _| this.active).unwrap_or(false);
            if !active { cx.background_executor().timer(Duration::from_secs_f32(crate::splash::DURATION + 0.5)).await; }
            this.update(cx, |this, cx| { this.load_lang(cx); this.refresh(cx); this.load_pending(cx); }).ok();
        }).detach();
        // local state every 4 s (cheap); `pending` also talks to the connectors, so only every 60 s
        cx.spawn(async move |this, cx| {
            let mut n = 0u32;
            loop {
                cx.background_executor().timer(Duration::from_secs(4)).await;
                n += 1;
                let alive = this.update(cx, |this, cx| {
                    // tabs in the background refresh every 30 s (for the badges); the visible one every 4 s
                    if this.active || n % 8 == 0 { this.refresh(cx); }
                    if n % 15 == 0 { this.load_pending(cx); }
                    if this.active && this.screen == Screen::Env { this.load_log(cx); }
                }).is_ok();
                if !alive { break; }
            }
        }).detach();
        this
    }

    /// Runs `job` with the CLI in the background and applies the result to the view.
    fn bg<R: Send + 'static>(&mut self, cx: &mut Context<Self>, job: impl FnOnce(Cli) -> R + Send + 'static, apply: impl FnOnce(&mut Self, R, &mut Context<Self>) + 'static) {
        let cli = self.cli.clone();
        cx.spawn(async move |this, cx| {
            let r = cx.background_executor().spawn(async move { job(cli) }).await;
            this.update(cx, |this, cx| { apply(this, r, cx); cx.notify(); }).ok();
        }).detach();
    }

    fn load_lang(&mut self, cx: &mut Context<Self>) {
        if std::env::var("ORQEN_LANG").is_ok() { return; }
        self.bg(cx, |cli| cli.json(&["lang", "--json"]), |this, r, _cx| { if let Ok(v) = r { this.es = s(&v, "lang") != "en"; } });
    }

    pub fn refresh(&mut self, cx: &mut Context<Self>) {
        if !self.cli.has_orqen() { return; }
        if matches!(self.items, Load::Idle) { self.items = Load::Loading; }
        self.bg(cx, |cli| cli.json(&["status", "--json"]), |this, r, _cx| {
            this.items = match r { Ok(Value::Array(a)) => Load::Ready(a), Ok(_) => Load::Ready(vec![]), Err(e) => Load::Failed(e.to_string()) };
            if this.selected.is_none() {
                this.selected = this.items.ready().and_then(|a| a.iter().find(|i| s(i, "state") != "CLOSED")).map(|i| s(i, "key"));
                if let Some(k) = this.selected.clone() { this.load_detail(k, false, _cx); }
            }
        });
        if matches!(self.env, Load::Idle) { self.env = Load::Loading; }
        self.bg(cx, |cli| cli.json(&["env", "status", "--json"]), |this, r, _cx| {
            this.env = match r { Ok(v) => Load::Ready(v), Err(e) => Load::Failed(e.to_string()) };
            if this.log_of.is_none() {
                this.log_of = this.env.ready().and_then(|v| v["processes"].as_array()).and_then(|a| a.first()).map(|p| s(p, "nombre"));
            }
        });
        let repo = self.cli.repo.clone();
        self.bg(cx, move |_| cli::latest_swarm(&repo), |this, r, _cx| this.swarm = r);
        let repo = self.cli.repo.clone();
        self.bg(cx, move |_| cli::branch(&repo), |this, r, _cx| this.branch = r);
        if let Some(key) = self.selected.clone() { self.load_detail(key, false, cx); }
    }

    pub fn load_pending(&mut self, cx: &mut Context<Self>) {
        if !self.cli.has_orqen() { return; }
        if !matches!(self.pending, Load::Ready(_)) { self.pending = Load::Loading; }
        self.bg(cx, |cli| cli.json(&["pending", "--json"]), |this, r, _cx| {
            this.pending = match r { Ok(Value::Array(a)) => Load::Ready(a), Ok(_) => Load::Ready(vec![]), Err(e) => Load::Failed(e.to_string()) };
        });
    }

    fn load_detail(&mut self, key: String, show_loading: bool, cx: &mut Context<Self>) {
        if show_loading { self.detail = Load::Loading; }
        self.bg(cx, move |cli| cli.json(&["status", &key, "--json"]), |this, r, _cx| {
            this.detail = match r { Ok(v) if !v.is_null() => Load::Ready(v), Ok(_) => Load::Failed("unknown".into()), Err(e) => Load::Failed(e.to_string()) };
        });
    }

    pub fn load_connectors(&mut self, cx: &mut Context<Self>) {
        if !matches!(self.connectors, Load::Ready(_)) { self.connectors = Load::Loading; }
        self.connectors_checking = true;
        self.bg(cx, |cli| cli.json(&["connectors", "--json"]), |this, r, _cx| {
            this.connectors_checking = false;
            this.connectors = match r { Ok(v) => Load::Ready(v), Err(e) => Load::Failed(e.to_string()) };
        });
    }

    fn load_tutorial(&mut self, n: usize, cx: &mut Context<Self>) {
        self.step_n = n;
        self.demo = Load::Idle;
        if matches!(self.topics, Load::Idle) {
            self.topics = Load::Loading;
            self.bg(cx, |cli| cli.json(&["tutorial", "--list", "--json"]), |this, r, _cx| {
                this.topics = match r { Ok(v) => Load::Ready(v["topics"].as_array().cloned().unwrap_or_default()), Err(e) => Load::Failed(e.to_string()) };
            });
        }
        self.step = Load::Loading;
        self.bg(cx, move |cli| cli.json(&["tutorial", "--step", &n.to_string(), "--json"]), |this, r, _cx| {
            this.step = match r { Ok(v) => Load::Ready(v), Err(e) => Load::Failed(e.to_string()) };
        });
    }

    fn load_log(&mut self, cx: &mut Context<Self>) {
        let Some(name) = self.log_of.clone() else { return };
        let path = self.env.ready().and_then(|v| v["processes"].as_array())
            .and_then(|a| a.iter().find(|p| s(p, "nombre") == name)).map(|p| s(p, "log")).filter(|l| !l.is_empty());
        let Some(path) = path else { self.log_lines.clear(); return };
        let full = if PathBuf::from(&path).is_absolute() { PathBuf::from(&path) } else { self.cli.repo.join(&path) };
        self.bg(cx, move |_| cli::tail(&full, 400), |this, lines, _cx| this.log_lines = lines);
    }

    /// Refreshes the processes without going back to the loading state (no jump).
    fn reload_env(&mut self, cx: &mut Context<Self>) {
        self.bg(cx, |cli| cli.json(&["env", "status", "--json"]), |this, r, _cx| {
            match r { Ok(v) => this.env = Load::Ready(v), Err(e) => if !matches!(this.env, Load::Ready(_)) { this.env = Load::Failed(e.to_string()) } }
        });
    }

    fn env_action(&mut self, args: &'static [&'static str], label: String, cx: &mut Context<Self>) {
        if self.env_busy.is_some() { return; }
        self.env_busy = Some(label);
        self.env_output = None;
        cx.notify();
        self.bg(cx, move |cli| cli.run(args), |this, r, _cx| {
            this.env_busy = None;
            this.env_output = Some(match r {
                Ok(o) => cli::strip_ansi(&format!("{}{}", o.stdout, o.stderr)).trim().to_string(),
                Err(e) => e.to_string(),
            });
            this.reload_env(_cx);
        });
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(Duration::from_millis(300)).await;
            this.update(cx, |this, cx| this.refresh(cx)).ok();
        }).detach();
    }

    fn go(&mut self, screen: Screen, cx: &mut Context<Self>) {
        if self.screen == screen { return; }
        self.screen = screen;
        self.settings = None;
        if screen == Screen::Env { self.load_log(cx); }
        cx.notify();
    }

    /// Opens (or switches) the settings panel; `None` closes it.
    pub fn open_settings(&mut self, tab: Option<Settings>, cx: &mut Context<Self>) {
        if tab.is_some() && self.settings.is_none() { self.settings_at = Instant::now(); }
        if tab != Some(Settings::Connectors) { self.conn_editor = None; }
        self.settings = tab;
        if tab == Some(Settings::General) && self.general.is_none() {
            let general = cx.new(|cx| crate::general::GeneralSettings::new(self.cli.clone(), self.es, cx));
            cx.subscribe(&general, |this, _, _: &crate::connectors::Saved, cx| { this.load_connectors(cx); this.load_pending(cx); cx.notify(); }).detach();
            self.general = Some(general);
        }
        match tab {
            Some(Settings::Connectors) if !matches!(self.connectors, Load::Ready(_)) => self.load_connectors(cx),
            Some(Settings::Tutorial) if matches!(self.step, Load::Idle) => self.load_tutorial(1, cx),
            _ => {}
        }
        cx.notify();
    }

    /// Opens the connectors editor (Configure, Edit, Add internal ticket).
    fn open_conn_editor(&mut self, focus_internal: bool, cx: &mut Context<Self>) {
        let editor = cx.new(|cx| crate::connectors::ConnectorsEditor::new(self.cli.clone(), self.es, focus_internal, cx));
        cx.subscribe(&editor, |this, _, _: &crate::connectors::Saved, cx| {
            this.conn_editor = None;
            this.general = None;
            this.load_connectors(cx);
            this.load_pending(cx);
            this.toast = Some((t(this.es, "Conectores guardados", "Connectors saved").into(), Instant::now()));
            cx.notify();
        }).detach();
        cx.subscribe(&editor, |this, _, _: &crate::connectors::Closed, cx| { this.conn_editor = None; cx.notify(); }).detach();
        self.conn_editor = Some(editor);
        cx.notify();
    }

    fn copy(&mut self, text: String, cx: &mut Context<Self>) {
        cx.write_to_clipboard(ClipboardItem::new_string(text.clone()));
        self.toast = Some((format!("{} {text}", t(self.es, "Copiado:", "Copied:")), Instant::now()));
        cx.notify();
        cx.spawn(async move |this, cx| {
            cx.background_executor().timer(Duration::from_millis(2200)).await;
            this.update(cx, |this, cx| { this.toast = None; cx.notify(); }).ok();
        }).detach();
    }

    pub fn repo_name(&self) -> String {
        self.cli.repo.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| self.cli.repo.display().to_string())
    }

    // ================================================================ chrome

    fn sidebar(&self, cx: &mut Context<Self>) -> impl IntoElement {
        let es = self.es;
        let items = self.items.ready().cloned().unwrap_or_default();
        let waiting = self.pending.ready().map(|p| p.iter().filter(|x| s(x, "for") != "agent").count()).unwrap_or(0);
        let running = self.env.ready().and_then(|v| v["processes"].as_array()).map(|a| a.iter().filter(|p| p["corriendo"].as_bool() == Some(true)).count()).unwrap_or(0);
        let total = self.env.ready().and_then(|v| v["processes"].as_array()).map(|a| a.len()).unwrap_or(0);
        let nav = Screen::NAV.iter().enumerate().map(|(i, &sc)| {
            let on = self.screen == sc;
            let badge: Option<String> = match sc {
                Screen::Pending if waiting > 0 => Some(waiting.to_string()),
                Screen::Env if total > 0 => Some(format!("{running}/{total}")),
                _ => None,
            };
            div().id(("nav", i)).flex().items_center().gap(px(10.)).h(px(32.)).px(px(10.)).rounded(px(8.)).cursor_pointer()
                .text_size(px(13.))
                .when(on, |d| d.bg(c(SURFACE_2)).text_color(c(TEXT)).font_weight(FontWeight::MEDIUM))
                .when(!on, |d| d.text_color(c(TEXT_2)).hover(|h| h.bg(c(HOVER)).text_color(c(TEXT))))
                .child(icon(sc.icon(), 15., if on { TEXT } else { MUTED }))
                .child(div().flex_1().child(sc.name(es)))
                .children(badge.map(|b| {
                    let hot = sc == Screen::Pending;
                    div().px(px(7.)).rounded_full().text_size(px(10.5)).min_w(px(20.)).flex().justify_center()
                        .bg(c(if hot { MAGENTA } else { 0x141B2B })).text_color(c(if hot { 0xFFFFFF } else { MUTED }))
                        .when(hot, |d| d.font_weight(FontWeight::SEMIBOLD)).child(b)
                }))
                .on_click(cx.listener(move |this, _, _, cx| this.go(sc, cx)))
        });
        let active: Vec<_> = items.iter().filter(|i| i.get("lock").map(|l| !l.is_null()).unwrap_or(false) || s(i, "state") == "BLOCKED").take(6).cloned().collect();
        div().w(px(224.)).flex_none().h_full().flex().flex_col().bg(c(SIDEBAR)).border_r_1().border_color(c(BORDER))
            .child(div().px(px(16.)).pt(px(14.)).pb(px(6.)).flex().flex_col().gap(px(3.))
                .child(div().text_size(px(14.)).font_weight(FontWeight::SEMIBOLD).text_color(c(TEXT)).truncate().child(self.repo_name()))
                .children(self.branch.clone().map(|b| div().flex().items_center().gap(px(5.)).child(icon("branch", 11., DIM)).child(mono(b).text_size(px(11.)).text_color(c(MUTED))))))
            .child(div().p(px(10.)).pt(px(6.)).flex().flex_col().gap(px(2.)).children(nav))
            .child(div().px(px(18.)).pt(px(12.)).pb(px(6.)).text_size(px(11.)).text_color(c(DIM)).child(t(es, "Con alguien trabajando", "Being worked on")))
            .child(div().px(px(10.)).flex().flex_col().gap(px(1.)).children(active.iter().enumerate().map(|(i, it)| {
                let key = s(it, "key");
                let blocked = s(it, "state") == "BLOCKED";
                let who = it["lock"]["agent"].as_str().unwrap_or("").to_string();
                let k2 = key.clone();
                div().id(("active", i)).flex().items_center().gap(px(8.)).h(px(28.)).px(px(8.)).rounded(px(7.)).cursor_pointer()
                    .hover(|h| h.bg(c(HOVER)))
                    .child(if blocked { dot(AMBER).into_any_element() } else { live_dot(("spin-a", i), BLUE_TEXT).into_any_element() })
                    .child(div().flex_1().min_w(px(0.)).text_size(px(12.)).text_color(c(TEXT_2)).truncate().child(key))
                    .child(div().text_size(px(10.)).text_color(c(DIM)).font_family(MONO_FONT).child(if blocked { "BLOCKED".into() } else { who }))
                    .on_click(cx.listener(move |this, _, _, cx| { this.selected = Some(k2.clone()); this.load_detail(k2.clone(), true, cx); this.go(Screen::Pending, cx); cx.notify(); }))
            })).when(active.is_empty(), |d| d.child(div().px(px(8.)).py(px(4.)).text_size(px(11.5)).text_color(c(DIM)).child(t(es, "Nadie por ahora.", "Nobody right now.")))))
            .child(div().flex_1())
    }

    // ================================================================ screens

    fn pending_screen(&self, cx: &mut Context<Self>) -> AnyElement {
        let es = self.es;
        let items = match &self.items {
            Load::Ready(a) => a.clone(),
            Load::Failed(e) => return ui::empty(t(es, "No se pudo leer el estado", "Could not read the state"), e.clone()).into_any_element(),
            _ => return self.pending_skeleton(),
        };
        let who: std::collections::HashMap<String, String> = self.pending.ready().map(|p| p.iter().map(|x| (s(x, "key"), s(x, "for"))).collect()).unwrap_or_default();
        let order = ["BLOCKED", "NEW", "SUPPORT", "ANALYSIS", "WAITING_CLIENT", "DEVELOPMENT", "TESTING", "CODE_REVIEW", "EXECUTION", "EXECUTION_APPROVAL", "APPLICATION", "VERIFICATION", "DELIVERY", "ACCEPTANCE", "CLOSED"];
        // tickets the connector returns that orqen has not seen yet are NEW
        let mut all = items.clone();
        for (k, f) in &who { if !all.iter().any(|i| &s(i, "key") == k) { all.push(serde_json::json!({ "key": k, "state": "NEW", "for": f })); } }
        let mut row = 0usize;
        let groups = order.iter().filter_map(|st| {
            let list: Vec<&Value> = all.iter().filter(|i| s(i, "state") == *st).collect();
            if list.is_empty() || *st == "CLOSED" { return None; }
            let header = div().flex().items_center().gap(px(8.)).h(px(26.)).px(px(8.)).mt(px(8.)).text_size(px(11.)).text_color(c(MUTED))
                .child(dot(stage_color(st))).child(div().text_color(c(TEXT_2)).child(stage_name(st, es)))
                .child(mono(st.to_string()).text_color(c(DIM)).text_size(px(10.))).child(div().flex_1()).child(list.len().to_string());
            let rows = list.into_iter().map(|it| {
                row += 1;
                let key = s(it, "key");
                let on = self.selected.as_deref() == Some(key.as_str());
                let f = who.get(&key).cloned().unwrap_or_default();
                let lock = it["lock"]["agent"].as_str().map(str::to_string);
                let state = s(it, "state");
                let sub = if state == "BLOCKED" { t(es, "Bloqueado: espera a una persona", "Blocked: waiting for a person").to_string() }
                    else if let Some(a) = &lock { format!("{} {a}", t(es, "Trabajando:", "Working:")) }
                    else { match f.as_str() { "support" => t(es, "Espera a soporte", "Waiting for support"), "analyst" => t(es, "Espera al analista", "Waiting for the analyst"), "agent" => t(es, "Listo para un agente", "Ready for an agent"), _ => t(es, "Espera en el ticket", "Waiting on the ticket") }.to_string() };
                let k2 = key.clone();
                appear(("row", row), (row as u64).min(12) * 35, div().id(SharedString::from(format!("item-{key}"))).flex().flex_col().gap(px(5.)).p(px(10.)).mb(px(2.)).rounded(px(9.)).cursor_pointer().border_1()
                    .when(on, |d| d.bg(c(SURFACE_2)).border_color(c(0x23345F)))
                    .when(!on, |d| d.border_color(gpui::transparent_black()).hover(|h| h.bg(c(HOVER))))
                    .child(div().flex().items_center().gap(px(8.))
                        .child(mono(key.clone()).text_size(px(11.5)).text_color(c(BLUE_TEXT)))
                        .children(it["internal"].as_str().map(|k| chip(k.to_string(), 0x4A1E3D, 0xFFB3D9)))
                        .children(it["lane"].as_str().map(|l| chip(l.to_string(), BORDER_2, MUTED)))
                        .child(div().flex_1())
                        .children(lock.as_ref().map(|_| live_dot(SharedString::from(format!("rs-{key}")), BLUE_TEXT))))
                    .child(div().flex().items_center().gap(px(6.)).text_size(px(12.)).text_color(c(if state == "BLOCKED" { AMBER } else { MUTED }))
                        .child(sub))
                    .on_click(cx.listener(move |this, _, _, cx| { this.selected = Some(k2.clone()); this.load_detail(k2.clone(), true, cx); cx.notify(); })))
            }).collect::<Vec<_>>();
            Some(div().child(header).children(rows))
        }).collect::<Vec<_>>();
        let closed = all.iter().filter(|i| s(i, "state") == "CLOSED").count();
        let list = div().w(px(360.)).flex_none().h_full().flex().flex_col().border_r_1().border_color(c(BORDER))
            .child(div().p(px(16.)).pb(px(8.)).flex().items_baseline().gap(px(8.)).child(ui::h1(t(es, "Pendientes", "Pending"))).child(mono("orqen pending").text_size(px(11.)).text_color(c(DIM)))
                .child(div().flex_1()).children(self.pending.loading().then(|| progress_slice("pend-load", 48.))))
            .children(match &self.pending { Load::Failed(e) => Some(div().mx(px(16.)).mb(px(6.)).p(px(8.)).rounded(px(8.)).bg(c(0x1D1810)).text_size(px(11.5)).text_color(c(AMBER)).child(format!("{} {}", t(es, "No se pudieron consultar los requerimientos:", "Could not query requirements:"), e))), _ => None })
            .child(div().id("list").flex_1().overflow_y_scroll().px(px(8.)).pb(px(14.)).children(groups)
                .when(all.iter().all(|i| s(i, "state") == "CLOSED"), |d| d.child(div().p(px(16.)).text_size(px(12.5)).text_color(c(MUTED)).child(t(es, "No hay requerimientos abiertos. Los nuevos aparecen acá.", "No open requirements. New ones show up here."))))
                .when(closed > 0, |d| d.child(div().px(px(8.)).pt(px(12.)).text_size(px(11.)).text_color(c(DIM)).child(format!("{closed} {}", t(es, "cerrados", "closed"))))));
        div().size_full().flex().child(list).child(self.detail_pane(cx)).into_any_element()
    }

    fn detail_pane(&self, cx: &mut Context<Self>) -> AnyElement {
        let es = self.es;
        let Some(key) = self.selected.clone() else {
            return div().flex_1().child(ui::empty(t(es, "Elegí un pedido", "Pick a request"), t(es, "Vas a ver en qué etapa está, quién tiene que actuar y qué pasó.", "You will see its stage, who has to act and what happened."))).into_any_element();
        };
        let d = match &self.detail {
            Load::Ready(v) if s(v, "key") == key => v.clone(),
            Load::Failed(_) => serde_json::json!({ "key": key, "state": "NEW" }),
            _ => return detail_skeleton(),
        };
        let state = s(&d, "state");
        let internal = d["internal"].as_str().map(str::to_string);
        let ik = internal.clone().unwrap_or_else(|| key.clone());
        let flow = ["ANALYSIS", "DEVELOPMENT", "TESTING", "CODE_REVIEW", "DELIVERY", "ACCEPTANCE", "CLOSED"];
        let idx = flow.iter().position(|x| *x == state);
        let pipeline = flow.iter().enumerate().map(|(i, st)| {
            let (done, cur) = match idx { Some(n) => (i < n, i == n), None => (false, false) };
            div().flex().items_center().gap(px(5.)).h(px(24.)).px(px(9.)).rounded_full().text_size(px(11.))
                .when(cur, |d| d.bg(c(SURFACE_2)).border_1().border_color(c(BLUE)).text_color(c(TEXT)).font_weight(FontWeight::SEMIBOLD))
                .when(done, |d| d.border_1().border_color(c(0x1E2638)).bg(c(SURFACE)).text_color(c(TEXT_2)))
                .when(!cur && !done, |d| d.border_1().border_dashed().border_color(c(BORDER_2)).text_color(c(DIM)))
                .children(done.then(|| icon("check", 10., GREEN)))
                .children(cur.then(|| live_dot(("pipe", i), BLUE_TEXT)))
                .child(stage_name(st, es))
        }).collect::<Vec<_>>();
        // what to run next, by stage
        let next: Vec<(&str, String)> = match state.as_str() {
            "NEW" => vec![(t(es, "Analizar (analista, en Claude Code)", "Analyze (analyst, in Claude Code)"), format!("/orqen:analyze {key}")), (t(es, "O pasarlo por soporte", "Or send it to support"), format!("/orqen:support {key}"))],
            "SUPPORT" => vec![(t(es, "Seguir con soporte", "Continue support"), format!("/orqen:support {key}"))],
            "ANALYSIS" => vec![(t(es, "Seguir el análisis", "Continue the analysis"), format!("/orqen:analyze {key}"))],
            "DEVELOPMENT" => vec![(t(es, "Implementar", "Implement"), format!("/orqen:implement {ik}"))],
            "TESTING" => vec![(t(es, "Correr testing", "Run testing"), format!("orqen take {ik}"))],
            "QA_REVIEW" => vec![(t(es, "Revisión de QA (solo carril completo)", "QA review (full lane only)"), format!("/orqen:review {ik}"))],
            "CODE_REVIEW" => vec![(t(es, "Abrir el PR", "Open the PR"), format!("/orqen:pr {ik}")), (t(es, "Code review (senior)", "Code review (senior)"), format!("/orqen:code-review {ik}"))],
            "BLOCKED" => vec![(t(es, "Destrabar: comentar en el ticket", "Unblock: comment on the ticket"), "/approve <qué hacer>".into())],
            "WAITING_CLIENT" | "ACCEPTANCE" => vec![(t(es, "Espera al cliente en el requerimiento", "Waiting for the client on the requirement"), format!("orqen status {key}"))],
            _ => vec![(t(es, "Ver el detalle", "See the detail"), format!("orqen status {key}"))],
        };
        let actions = next.into_iter().enumerate().map(|(i, (what, cmd))| {
            let c2 = cmd.clone();
            div().id(("next", i)).flex().items_center().gap(px(10.)).p(px(10.)).rounded(px(10.)).border_1().border_color(c(0x1E2638)).bg(c(SURFACE)).cursor_pointer()
                .hover(|h| h.border_color(c(0x2E3A55)).bg(c(0x111A2E)))
                .child(div().flex_1().flex().flex_col().gap(px(3.)).child(div().text_size(px(12.)).text_color(c(MUTED)).child(what))
                    .child(mono(cmd).text_size(px(12.5)).text_color(c(TEXT))))
                .child(icon("copy", 14., MUTED))
                .on_click(cx.listener(move |this, _, _, cx| this.copy(c2.clone(), cx)))
        }).collect::<Vec<_>>();
        let events = d["events"].as_array().cloned().unwrap_or_default();
        let feed = events.iter().rev().take(40).enumerate().map(|(i, ev)| {
            let ts = s(ev, "ts");
            let when = ts.get(5..16).unwrap_or(&ts).replace('T', " ");
            appear(("ev", i), (i as u64).min(10) * 30, div().flex().gap(px(10.)).py(px(6.))
                .child(div().w(px(84.)).flex_none().child(mono(when).text_size(px(11.)).text_color(c(DIM))))
                .child(div().flex_1().flex().flex_col().gap(px(2.))
                    .child(div().flex().items_center().gap(px(6.)).text_size(px(12.5))
                        .child(div().text_color(c(stage_color(&s(ev, "from")))).child(stage_name(&s(ev, "from"), es)))
                        .child(icon("arrow", 11., DIM))
                        .child(div().text_color(c(stage_color(&s(ev, "to")))).child(stage_name(&s(ev, "to"), es)))
                        .children(ev["agent"].as_str().map(|a| mono(format!("({a})")).text_size(px(11.)).text_color(c(DIM)))))
                    .child(div().text_size(px(12.)).text_color(c(TEXT_2)).child(s(ev, "detail")))))
        }).collect::<Vec<_>>();
        let k_ext = key.clone();
        div().flex_1().min_w(px(0.)).h_full().flex().flex_col()
            .child(div().p(px(18.)).pb(px(14.)).border_b_1().border_color(c(BORDER)).flex().flex_col().gap(px(12.))
                .child(div().flex().items_center().gap(px(10.))
                    .child(mono(key.clone()).text_size(px(15.)).font_weight(FontWeight::SEMIBOLD).text_color(c(BLUE_TEXT)))
                    .children(internal.map(|k| chip(format!("{} {k}", t(es, "interno", "internal")), 0x4A1E3D, 0xFFB3D9)))
                    .children(d["lane"].as_str().map(|l| chip(format!("{} {l}", t(es, "carril", "lane")), BORDER_2, TEXT_2)))
                    .children(d["branch"].as_str().filter(|b| !b.is_empty()).map(|b| div().flex().items_center().gap(px(5.)).child(icon("branch", 12., DIM)).child(mono(b.to_string()).text_size(px(11.)).text_color(c(MUTED)))))
                    .child(div().flex_1())
                    .child(button("copy-key", t(es, "Copiar clave", "Copy key"), Kind::Ghost, cx.listener(move |this, _, _, cx| this.copy(k_ext.clone(), cx)))))
                .child(div().flex().flex_wrap().gap(px(4.)).children(pipeline)))
            .child(div().id("detail-scroll").flex_1().overflow_y_scroll().p(px(18.)).flex().flex_col().gap(px(18.))
                .child(div().flex().flex_col().gap(px(8.)).child(ui::label(t(es, "QUÉ SIGUE", "WHAT'S NEXT"))).children(actions))
                .children(self.implementation(&key, d["internal"].as_str()))
                .child(div().flex().flex_col().child(ui::label(t(es, "RECORRIDO", "HISTORY"))).child(div().mt(px(6.)).children(feed))
                    .when(events.is_empty(), |d| d.child(div().mt(px(6.)).text_size(px(12.)).text_color(c(MUTED)).child(t(es, "Todavía nadie lo tomó.", "Nobody has taken it yet."))))))
            .into_any_element()
    }

    fn env_screen(&self, cx: &mut Context<Self>) -> AnyElement {
        let es = self.es;
        let v = match &self.env {
            Load::Ready(v) => v.clone(),
            Load::Failed(e) => return ui::empty(t(es, "No se pudo leer el entorno", "Could not read the environment"), e.clone()).into_any_element(),
            _ => Value::Null,
        };
        let loading = !matches!(self.env, Load::Ready(_));
        let procs = v["processes"].as_array().cloned().unwrap_or_default();
        let busy = self.env_busy.clone();
        let header = div().px(px(22.)).py(px(16.)).flex().items_center().gap(px(10.)).border_b_1().border_color(c(BORDER))
            .child(ui::h1(t(es, "Entornos", "Environments"))).child(mono("orqen/config.yaml · entornos.procesos").text_size(px(11.)).text_color(c(DIM)))
            .child(div().flex_1())
            .children(busy.as_ref().map(|b| ui::busy("env-busy", b.clone())))
            .child(button("env-down", t(es, "Apagar", "Stop"), Kind::Ghost, cx.listener(|this, _, _, cx| { let l = t(this.es, "Apagando…", "Stopping…").to_string(); this.env_action(&["env", "down"], l, cx) })))
            .child(button("env-all", t(es, "Levantar todo (con e2e)", "Start all (with e2e)"), Kind::Accent, cx.listener(|this, _, _, cx| { let l = t(this.es, "Levantando todo…", "Starting everything…").to_string(); this.env_action(&["env", "up", "--all"], l, cx) })))
            .child(button("env-up", t(es, "Levantar", "Start"), Kind::Primary, cx.listener(|this, _, _, cx| { let l = t(this.es, "Levantando…", "Starting…").to_string(); this.env_action(&["env", "up"], l, cx) })));
        let cols = |d: gpui::Div| d.flex().items_center().gap(px(12.));
        let head = cols(div()).px(px(22.)).py(px(9.)).text_size(px(11.)).text_color(c(DIM)).border_b_1().border_color(c(0x1A2133))
            .child(div().w(px(150.)).child(t(es, "Proceso", "Process"))).child(div().flex_1().child(t(es, "Comando", "Command")))
            .child(div().w(px(70.)).child(t(es, "Puerto", "Port"))).child(div().w(px(70.)).child(t(es, "Cuándo", "When"))).child(div().w(px(90.)).child("Log"));
        let rows = procs.iter().enumerate().map(|(i, p)| {
            let on = p["corriendo"].as_bool() == Some(true);
            let name = s(p, "nombre");
            let n2 = name.clone();
            let sel = self.log_of.as_deref() == Some(name.as_str());
            appear(("proc", i), i as u64 * 50, div().id(("proc-row", i)).flex().items_center().gap(px(12.)).px(px(22.)).h(px(48.)).border_b_1().border_color(c(0x141A28)).cursor_pointer()
                .when(sel, |d| d.bg(c(0x0E1424))).hover(|h| h.bg(c(HOVER)))
                .child(div().w(px(150.)).flex().items_center().gap(px(9.))
                    .child(if on { live_dot(("pd", i), GREEN).into_any_element() } else { dot(0x475569).into_any_element() })
                    .child(div().text_size(px(13.)).font_weight(FontWeight::SEMIBOLD).text_color(c(TEXT)).child(name.clone())))
                .child(div().flex_1().min_w(px(0.)).child(mono(s(p, "comando")).text_size(px(12.)).text_color(c(TEXT_2)).truncate()))
                .child(div().w(px(70.)).child(mono(p["puerto"].as_u64().map(|x| format!(":{x}")).unwrap_or("—".into())).text_size(px(12.)).text_color(c(TEXT))))
                .child(div().w(px(70.)).text_size(px(12.)).text_color(c(MUTED)).child(s(p, "cuando")))
                .child(div().w(px(90.)).text_size(px(12.)).text_color(c(if sel { BLUE_TEXT } else { MUTED })).child(if sel { t(es, "viendo", "viewing") } else { t(es, "ver log", "view log") }))
                .on_click(cx.listener(move |this, _, _, cx| { this.log_of = Some(n2.clone()); this.load_log(cx); cx.notify(); })))
        }).collect::<Vec<_>>();
        let out = self.env_output.clone();
        let lines = self.log_lines.clone();
        let log_name = self.log_of.clone().unwrap_or_default();
        div().size_full().flex().flex_col()
            .child(header)
            .child(div().child(head).children(rows).when(loading, |d| d.children((0..3).map(env_row_skeleton))).when(procs.is_empty() && !loading, |d| d.child(div().px(px(22.)).py(px(16.)).text_size(px(12.5)).text_color(c(MUTED)).child(t(es, "No hay procesos en orqen/config.yaml (entornos.procesos).", "No processes in orqen/config.yaml (entornos.procesos).")))))
            .children(out.map(|o| div().mx(px(22.)).mt(px(12.)).p(px(10.)).rounded(px(9.)).bg(c(0x070A12)).border_1().border_color(c(BORDER)).child(mono(o).text_size(px(11.5)).text_color(c(TEXT_2)))))
            .child(div().flex_1().min_h(px(0.)).m(px(22.)).mt(px(14.)).rounded(px(12.)).border_1().border_color(c(BORDER)).bg(c(0x070A12)).flex().flex_col().overflow_hidden()
                .child(div().h(px(34.)).flex_none().flex().items_center().gap(px(8.)).px(px(12.)).border_b_1().border_color(c(0x161D2D))
                    .child(icon("terminal", 12., MUTED)).child(if loading { skeleton("log-name", px(64.), 8.).into_any_element() } else { mono(format!("{log_name}.log")).text_size(px(11.5)).text_color(c(TEXT_2)).into_any_element() })
                    .child(div().flex_1()).child(live_dot("log-live", GREEN)).child(div().text_size(px(11.)).text_color(c(MUTED)).child(t(es, "en vivo", "live"))))
                .child(div().id("log").flex_1().overflow_y_scroll().p(px(12.)).font_family(MONO_FONT).text_size(px(11.5)).text_color(c(TEXT_2))
                    .children(lines.iter().map(|l| div().child(l.clone())))
                    .when(loading, |d| d.flex().flex_col().gap(px(7.)).children([62., 48., 71., 39., 55.].into_iter().enumerate().map(|(i, w)| skeleton(("log-sk", i), relative(w / 100.), 8.))))
                    .when(lines.is_empty() && !loading, |d| d.child(div().text_color(c(DIM)).child(t(es, "Sin log todavía: el proceso no fue levantado por orqen.", "No log yet: the process was not started by orqen."))))))
            .into_any_element()
    }

    fn connectors_screen(&self, cx: &mut Context<Self>) -> AnyElement {
        let es = self.es;
        if let Some(editor) = &self.conn_editor { return div().size_full().child(editor.clone()).into_any_element(); }
        let header = div().pl(px(22.)).pr(px(56.)).py(px(16.)).flex().items_center().gap(px(10.)).border_b_1().border_color(c(BORDER))
            .child(ui::h1(t(es, "Conectores", "Connectors"))).child(mono("orqen/config.yaml · conectores").text_size(px(11.)).text_color(c(DIM)))
            .child(div().flex_1())
            .children(self.connectors_checking.then(|| ui::busy("conn-load", t(es, "Probando credenciales…", "Checking credentials…"))))
            .child(button("conn-setup", t(es, "Configurar", "Set up"), Kind::Ghost, cx.listener(|this, _, _, cx| this.open_conn_editor(false, cx))))
            .child(button("conn-test", t(es, "Probar conexión", "Test connection"), Kind::Primary, cx.listener(|this, _, _, cx| this.load_connectors(cx))));
        let body: AnyElement = match &self.connectors {
            Load::Failed(e) => ui::empty(t(es, "No se pudieron leer los conectores", "Could not read the connectors"), e.clone()).into_any_element(),
            Load::Ready(v) => {
                let list = v["connectors"].as_array().cloned().unwrap_or_default();
                let legacy = v["legacy"].as_array().map(|a| a.iter().filter_map(|x| x.as_str()).collect::<Vec<_>>().join(", ")).unwrap_or_default();
                let cards = list.iter().enumerate().map(|(i, cn)| {
                    let ext = s(cn, "role") == "external";
                    let configured = cn["configured"].as_bool() == Some(true);
                    let ok = cn["ok"].as_bool() == Some(true);
                    let trans = cn["transitions"].as_object().cloned().unwrap_or_default();
                    let kind = s(cn, "kind");
                    let badge = match kind.as_str() { "jira" => "J", "github" => "GH", "asana" => "A", _ => "—" };
                    appear(("conn", i), i as u64 * 80, card().w(px(470.)).flex().flex_col().overflow_hidden()
                        .child(div().p(px(16.)).flex().flex_col().gap(px(4.)).border_b_1().border_color(c(0x161D2D))
                            .child(div().flex().items_center().gap(px(8.)).child(dot(if ext { BLUE } else { MAGENTA }))
                                .child(div().text_size(px(14.)).font_weight(FontWeight::SEMIBOLD).text_color(c(TEXT)).child(if ext { t(es, "Requerimientos", "Requirements") } else { t(es, "Tickets", "Tickets") }))
                                .child(div().flex_1())
                                .children(configured.then(|| if ok { chip(t(es, "conectado", "connected"), 0x1F4D3A, GREEN) } else { chip(t(es, "con error", "failing"), 0x5A1E2A, RED) }))
                                .when(configured, |d| d.child(div().id(("conn-edit", i)).px(px(8.)).h(px(22.)).flex().items_center().rounded(px(6.)).cursor_pointer().text_size(px(11.5)).text_color(c(BLUE_TEXT))
                                    .hover(|h| h.bg(c(0x111A2E))).child(if ok { t(es, "Editar", "Edit") } else { t(es, "Corregir", "Fix") })
                                    .on_click(cx.listener(|this, _, _, cx| this.open_conn_editor(false, cx))))))
                            .child(div().text_size(px(12.)).text_color(c(MUTED)).child(if ext { t(es, "Lo que ve el cliente: ahí entra el pedido, se le responde y aprueba.", "What the client sees: the request arrives there, gets answered and approved.") } else { t(es, "Opcional. Trabajo de desarrollo: se crea al cerrar el análisis.", "Optional. Development work: created when analysis closes.") })))
                        .child(div().p(px(16.)).flex().flex_col().gap(px(12.))
                            .when(!configured, |d| d.child(div().flex().items_center().gap(px(12.)).p(px(12.)).rounded(px(10.)).border_1().border_dashed().border_color(c(BORDER_2))
                                .child(div().flex_1().min_w(px(0.)).text_size(px(12.5)).text_color(c(MUTED)).child(t(es, "Sin tickets separados: el desarrollo se sigue en el requerimiento.", "Without separate tickets, development is tracked in the requirement.")))
                                .child(button(("conn-add", i), t(es, "Agregar", "Add"), Kind::Accent, cx.listener(|this, _, _, cx| this.open_conn_editor(true, cx))))))
                            .when(configured, |d| d
                                .child(div().flex().items_center().gap(px(10.))
                                    .child(div().px(px(6.)).h(px(24.)).min_w(px(24.)).rounded(px(6.)).flex().items_center().justify_center().bg(c(0x1A2340)).text_size(px(10.5)).font_weight(FontWeight::BOLD).text_color(c(0xA9C1FF)).child(badge))
                                    .child(div().text_size(px(13.)).text_color(c(TEXT)).child(s(cn, "label"))))
                                .child(div().flex().items_start().gap(px(8.)).p(px(10.)).rounded(px(9.)).bg(c(if ok { 0x0C1F18 } else { 0x1F0F14 }))
                                    .child(icon(if ok { "check" } else { "alert" }, 13., if ok { GREEN } else { RED }))
                                    .child(div().flex_1().min_w(px(0.)).text_size(px(12.)).text_color(c(if ok { 0xA7F3D0 } else { 0xFECACA })).child(s(cn, "detail"))))
                                .child(div().w_full().rounded(px(9.)).border_1().border_color(c(0x1A2133)).overflow_hidden()
                                    .child(div().w_full().flex().px(px(12.)).py(px(7.)).bg(c(SIDEBAR)).text_size(px(11.)).text_color(c(DIM))
                                        .child(div().flex_1().child(t(es, "Estado de orqen", "orqen state"))).child(div().flex_1().child(t(es, "En la herramienta", "In the tool"))))
                                    .children(trans.iter().map(|(k, v)| div().w_full().flex().items_center().px(px(12.)).py(px(6.)).border_t_1().border_color(c(0x141A28)).text_size(px(12.))
                                        .child(div().flex_1().child(mono(k.clone()).text_color(c(TEXT_2)))).child(div().flex_1().text_color(c(TEXT)).child(v.as_str().unwrap_or("").to_string()))))
                                    .when(trans.is_empty(), |d| d.child(div().px(px(12.)).py(px(8.)).text_size(px(12.)).text_color(c(MUTED)).child(t(es, "Sin transiciones: orqen solo comenta y etiqueta.", "No transitions: orqen only comments and labels."))))))))
                }).collect::<Vec<_>>();
                div().id("conn-scroll").size_full().overflow_y_scroll().p(px(22.)).flex().flex_col().gap(px(16.))
                    .child(div().max_w(px(760.)).text_size(px(13.)).text_color(c(TEXT_2)).child(t(es,
                        "Los requerimientos son lo que ve el cliente. Los tickets son el trabajo de desarrollo. Cada uno puede estar en Jira, GitHub o Asana.",
                        "Requirements are what the customer sees. Tickets track development work. Each can live in Jira, GitHub or Asana.")))
                    .when(!legacy.is_empty(), |d| d.child(div().p(px(12.)).rounded(px(10.)).bg(c(0x1D1810)).border_1().border_color(c(0x4A3A1C)).text_size(px(12.)).text_color(c(0xF5C77A))
                        .child(format!("{} {legacy}. {}", t(es, "orqen/.env usa variables de una versión anterior:", "orqen/.env uses variables from an earlier version:"), t(es, "Corré `orqen update` para pasarlas a conectores.", "Run `orqen update` to move them to connectors.")))))
                    .child(div().flex().flex_wrap().gap(px(16.)).children(cards))
                    .into_any_element()
            }
            _ => connectors_skeleton(),
        };
        div().size_full().flex().flex_col().child(header).child(div().flex_1().min_h(px(0.)).child(body)).into_any_element()
    }

    fn tutorial_screen(&self, cx: &mut Context<Self>) -> AnyElement {
        let es = self.es;
        let topics = self.topics.ready().cloned().unwrap_or_default();
        let n = self.step_n;
        let list = div().w(px(250.)).flex_none().h_full().border_r_1().border_color(c(BORDER)).p(px(10.)).flex().flex_col().gap(px(1.))
            .child(div().px(px(10.)).pb(px(8.)).pt(px(4.)).text_size(px(11.)).text_color(c(DIM)).child(format!("orqen tutorial · {} {}", topics.len(), t(es, "pasos", "steps"))))
            .when(!matches!(self.topics, Load::Ready(_)), |d| d.children([118., 92., 104., 130., 86., 112.].into_iter().enumerate().map(|(i, w)|
                div().flex().items_center().gap(px(10.)).min_h(px(32.)).px(px(10.)).py(px(4.)).child(skeleton(("tp-n", i), px(20.), 20.)).child(skeleton_text(("tp-t", i), px(w), 12.5)))))
            .children(topics.iter().map(|tp| {
                let i = tp["n"].as_u64().unwrap_or(0) as usize;
                let on = i == n;
                let done = i < n;
                div().id(("topic", i)).flex().items_center().gap(px(10.)).min_h(px(32.)).px(px(10.)).py(px(4.)).rounded(px(8.)).cursor_pointer().text_size(px(12.5))
                    .when(on, |d| d.bg(c(SURFACE_2)).text_color(c(TEXT)).font_weight(FontWeight::MEDIUM))
                    .when(!on, |d| d.text_color(c(MUTED)).hover(|h| h.bg(c(HOVER)).text_color(c(TEXT_2))))
                    .child(div().size(px(20.)).flex_none().rounded(px(6.)).flex().items_center().justify_center().text_size(px(10.5)).font_weight(FontWeight::SEMIBOLD)
                        .bg(c(if on { BLUE } else if done { 0x0F2A22 } else { 0x141B2B })).text_color(c(if on { 0xFFFFFF } else if done { GREEN } else { MUTED }))
                        .child(if done { "✓".to_string() } else { i.to_string() }))
                    .child(div().flex_1().child(s(tp, "title")))
                    .on_click(cx.listener(move |this, _, _, cx| this.load_tutorial(i, cx)))
            }));
        let body: AnyElement = match &self.step {
            Load::Ready(v) => {
                let total = v["total"].as_u64().unwrap_or(12) as usize;
                let demo: Vec<String> = v["demo"].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect()).unwrap_or_default();
                // the CLI sends the step twice: done in the app (`app`) and in the terminal (`markdown`)
                let app_md = v["app"].as_str().filter(|x| !x.trim().is_empty()).map(str::to_string);
                let show_app = self.tut_app && app_md.is_some();
                let md = if show_app { app_md.clone().unwrap_or_default() } else { s(v, "markdown") };
                let target = v["screen"].as_str().and_then(|x| match x { "pending" => Some(Screen::Pending), "env" => Some(Screen::Env), _ => None });
                let has_demo = !demo.is_empty() && !show_app;
                // in the app view: an illustration of the screen right under the title
                let fig = show_app.then(|| {
                    let sm = &v["sample"];
                    let sample = crate::figures::Sample {
                        ext: sm["external"].as_str().unwrap_or("SOP-123").to_string(),
                        int: sm["internal"].as_str().map(str::to_string),
                        tool: sm["tool"].as_str().unwrap_or("Jira").to_string(),
                        procs: sm["processes"].as_array().map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect()).unwrap_or_default(),
                    };
                    crate::figures::figure(&s(v, "id"), es, &sample)
                }).flatten();
                let (md_head, md_body) = match md.split_once('\n') { Some((h, b)) if fig.is_some() && h.starts_with('#') => (Some(h.to_string()), b.to_string()), _ => (None, md.clone()) };
                let tut_app = self.tut_app;
                let mode = |id: &'static str, app: bool, label: &'static str| {
                    let on = tut_app == app;
                    div().id(id).h(px(26.)).px(px(12.)).flex().items_center().rounded(px(7.)).text_size(px(12.)).cursor_pointer()
                        .when(on, |d| d.bg(c(SURFACE_2)).text_color(c(TEXT)).font_weight(FontWeight::SEMIBOLD))
                        .when(!on, |d| d.text_color(c(MUTED)).hover(|h| h.text_color(c(TEXT_2))))
                        .child(label)
                        .on_click(cx.listener(move |this, _, _, cx| { if this.tut_app != app { this.tut_app = app; this.demo = Load::Idle; cx.notify(); } }))
                };
                let toggle = app_md.is_some().then(|| div().flex().items_center().gap(px(12.))
                    .child(div().flex().p(px(3.)).gap(px(2.)).rounded(px(9.)).bg(c(0x070A12)).border_1().border_color(c(BORDER))
                        .child(mode("tut-mode-app", true, t(es, "En la app", "In the app")))
                        .child(mode("tut-mode-cli", false, t(es, "En la terminal", "In the terminal"))))
                    .child(div().text_size(px(12.)).text_color(c(DIM)).child(t(es, "Las dos formas hacen lo mismo: usá la que te quede cómoda.", "Both ways do the same: use whichever suits you."))));
                let demo_out = match &self.demo { Load::Ready(o) => Some(o.clone()), _ => None };
                let demo_loading = self.demo.loading();
                div().id("tut-scroll").flex_1().min_w(px(0.)).h_full().overflow_y_scroll().px(px(40.)).py(px(28.)).child(div().w_full().max_w(px(900.)).flex().flex_col().gap(px(16.))
                    .child(div().h(px(4.)).rounded_full().bg(c(BORDER)).child(div().h_full().rounded_full().w(gpui::relative(n as f32 / total.max(1) as f32))
                        .bg(linear_gradient(90., linear_color_stop(h(BLUE), 0.), linear_color_stop(h(MAGENTA), 1.)))))
                    .children(toggle)
                    .child(appear(("step", n * 2 + show_app as usize), 0, div().w_full().flex().flex_col().gap(px(16.))
                        .children(md_head.map(|h| markdown(&h)))
                        .children(fig)
                        .child(markdown(&md_body))))
                    .children(demo_out.map(|o| div().p(px(12.)).rounded(px(10.)).bg(c(0x070A12)).border_1().border_color(c(0x23345F)).child(mono(o).text_size(px(11.5)).text_color(c(TEXT_2)))))
                    .child(div().flex().items_center().gap(px(8.)).mt(px(6.))
                        .child(button("prev", t(es, "Anterior", "Previous"), Kind::Ghost, cx.listener(move |this, _, _, cx| if n > 1 { this.load_tutorial(n - 1, cx) })))
                        .when(has_demo, |d| d.child(button("try", t(es, "Probalo", "Try it"), Kind::Accent, cx.listener(move |this, _, _, cx| {
                            let cmds = demo.clone();
                            this.demo = Load::Loading;
                            cx.notify();
                            this.bg(cx, move |cli| {
                                let mut out = String::new();
                                for c in cmds {
                                    let parts: Vec<&str> = c.split_whitespace().collect();
                                    out.push_str(&format!("$ {c}\n"));
                                    if parts.first() == Some(&"orqen") {
                                        match cli.run(&parts[1..]) { Ok(o) => out.push_str(&cli::strip_ansi(&format!("{}{}", o.stdout, o.stderr))), Err(e) => out.push_str(&e.to_string()) }
                                    } else {
                                        out.push_str("(se corre en la terminal)\n");
                                    }
                                    out.push('\n');
                                }
                                out.trim().to_string()
                            }, |this, o, _cx| this.demo = Load::Ready(o));
                        }))))
                        .when(demo_loading, |d| d.child(progress_slice("demo-run", 64.)))
                        // takes you to the screen the step talks about (the tutorial closes)
                        .children(target.filter(|_| show_app).map(|sc| button("tut-go", format!("{} {}", t(es, "Ir a", "Go to"), sc.name(es)), Kind::Accent,
                            cx.listener(move |this, _, _, cx| { this.open_settings(None, cx); this.go(sc, cx); }))))
                        .child(div().flex_1())
                        .child(button("next", if n >= total { t(es, "Terminar", "Finish") } else { t(es, "Siguiente", "Next") }, Kind::Primary, cx.listener(move |this, _, _, cx| {
                            if n < total { this.load_tutorial(n + 1, cx) } else { this.open_settings(None, cx) }
                        })))))
                    .into_any_element()
            }
            Load::Failed(e) => ui::empty(t(es, "No se pudo abrir el tutorial", "Could not open the tutorial"), e.clone()).into_any_element(),
            _ => tutorial_skeleton(n),
        };
        div().size_full().flex().child(list).child(body).into_any_element()
    }

}

impl Render for ProjectView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if self.init.is_none() && !self.cli.has_orqen() {
            let (cli, es) = (self.cli.clone(), self.es);
            let wizard = cx.new(|cx| crate::init::InitWizard::new(cli, es, cx));
            cx.subscribe(&wizard, |this, _, _: &crate::init::Initialized, cx| {
                this.init = None;
                this.items = Load::Idle;
                this.refresh(cx);
                this.load_pending(cx);
                this.toast = Some((t(this.es, "Proyecto inicializado", "Project set up").into(), Instant::now()));
                cx.notify();
            }).detach();
            self.init = Some(wizard);
        }
        if let Some(w) = &self.init {
            return div().size_full().child(w.clone()).into_any_element();
        }
        let content: AnyElement = match self.screen {
            Screen::Pending => self.pending_screen(cx),
            Screen::Env => self.env_screen(cx),
        };
        let idx = Screen::NAV.iter().position(|x| *x == self.screen).unwrap_or(0);
        let main = div().flex_1().min_w(px(0.)).h_full().relative().bg(c(PANEL))
            .child(div().size_full().child(content).with_animation(("screen", idx), Animation::new(Duration::from_millis(260)).with_easing(ease_out_quint()),
                |d, t| d.opacity(t).mt(px((1.0 - t) * 8.0))));
        div().size_full().relative().flex().child(self.sidebar(cx)).child(main)
            .children(self.settings.map(|tab| self.settings_panel(tab, cx)))
            .into_any_element()
    }
}

impl ProjectView {
    /// How the task is being implemented: the swarm run of this request (subtasks, model of each, attempts). Internal to the flow.
    fn implementation(&self, key: &str, internal: Option<&str>) -> Option<AnyElement> {
        let es = self.es;
        let r = self.swarm.as_ref()?;
        let task = s(r, "task");
        if !(task.contains(key) || internal.map(|k| task.contains(k)).unwrap_or(false)) { return None; }
        let tasks = r["tasks"].as_array().cloned().unwrap_or_default();
        let plan: std::collections::HashMap<String, Value> = r["plan"]["subtasks"].as_array().cloned().unwrap_or_default().into_iter().map(|x| (s(&x, "id"), x)).collect();
        let merged = tasks.iter().filter(|x| s(x, "status") == "merged").count();
        let pct = if tasks.is_empty() { 0.0 } else { merged as f32 / tasks.len() as f32 };
        let rows = tasks.iter().enumerate().map(|(i, tk)| {
            let st = s(tk, "status");
            let (col, txt) = match st.as_str() {
                "merged" => (GREEN, t(es, "integrada", "merged")), "running" => (BLUE_TEXT, t(es, "trabajando", "working")),
                "failed" => (RED, t(es, "falló", "failed")), "skipped" => (DIM, t(es, "salteada", "skipped")), _ => (DIM, t(es, "en cola", "queued")),
            };
            let id = s(tk, "id");
            let files = plan.get(&id).and_then(|p| p["files"].as_array()).map(|f| f.iter().filter_map(|x| x.as_str()).collect::<Vec<_>>().join(", ")).unwrap_or_default();
            let tiers: Vec<String> = tk["attempts"].as_array().map(|a| a.iter().map(|x| s(x, "tier")).filter(|x| !x.is_empty()).collect()).unwrap_or_default();
            let mut models: Vec<String> = vec![];
            for t in &tiers { if models.last() != Some(t) { models.push(t.clone()); } }
            appear(("impl", i), i as u64 * 50, div().flex().items_center().gap(px(10.)).py(px(8.)).px(px(10.)).rounded(px(9.)).border_1().border_color(c(0x1A2133)).bg(c(SURFACE))
                .child(if st == "merged" { icon("check", 13., GREEN).into_any_element() } else if st == "running" { live_dot(("impl-s", i), BLUE_TEXT).into_any_element() } else { dot(col).into_any_element() })
                .child(div().flex_1().min_w(px(0.)).flex().flex_col().gap(px(2.))
                    .child(div().text_size(px(12.5)).text_color(c(TEXT)).truncate().child(s(tk, "title")))
                    .children((!files.is_empty()).then(|| mono(files.clone()).text_size(px(10.5)).text_color(c(DIM)).truncate())))
                .child(div().flex().items_center().gap(px(4.)).children(models.iter().enumerate().map(|(j, m)| {
                    div().flex().items_center().gap(px(4.)).when(j > 0, |d| d.child(icon("arrow", 9., DIM))).child(chip(m.clone(), BORDER_2, TEXT_2))
                })))
                .child(div().w(px(76.)).flex_none().text_size(px(11.5)).text_color(c(col)).child(txt)))
        }).collect::<Vec<_>>();
        Some(div().flex().flex_col().gap(px(8.))
            .child(div().flex().items_center().gap(px(10.)).child(ui::label(t(es, "IMPLEMENTACIÓN", "IMPLEMENTATION")))
                .child(div().flex_1().h(px(4.)).rounded_full().bg(c(BORDER)).child(div().h_full().rounded_full().w(gpui::relative(pct))
                    .bg(linear_gradient(90., linear_color_stop(h(BLUE), 0.), linear_color_stop(h(MAGENTA), 1.)))))
                .child(mono(format!("{merged}/{} {}", tasks.len(), t(es, "partes", "parts"))).text_size(px(11.)).text_color(c(MUTED))))
            .child(div().text_size(px(12.)).text_color(c(MUTED)).child(t(es, "El agente partió el trabajo en partes; cada una la resuelve un modelo y se integra cuando sus tests pasan.", "The agent split the work into parts; each one is solved by a model and merged when its tests pass.")))
            .children(rows)
            .into_any_element())
    }

    /// Settings panel over the project: connectors and tutorial (opened from the gear in the bottom bar).
    fn settings_panel(&self, tab: Settings, cx: &mut Context<Self>) -> AnyElement {
        let es = self.es;
        let e = self.settings_at.elapsed().as_secs_f32();
        let k = (e / 0.22).clamp(0.0, 1.0);
        let k = 1.0 - (1.0 - k).powi(3);
        let tabs = [(Settings::General, "gear", "General"), (Settings::Connectors, "plug", t(es, "Conectores", "Connectors")), (Settings::Tutorial, "tutorial", "Tutorial")];
        let body = match tab { Settings::General => div().size_full().children(self.general.clone()).into_any_element(), Settings::Connectors => self.connectors_screen(cx), Settings::Tutorial => self.tutorial_screen(cx) };
        div().absolute().inset_0().flex().items_center().justify_center().bg(gpui::rgba(0x05070Cb0)).opacity(k)
            .child(div().id("settings-scrim").absolute().inset_0().on_click(cx.listener(|this, _, _, cx| this.open_settings(None, cx))))
            .child(div().id("settings").relative().w(gpui::relative(0.86)).h(gpui::relative(0.86)).mt(px((1.0 - k) * 14.0))
                .rounded(px(14.)).border_1().border_color(c(BORDER_2)).bg(c(PANEL)).shadow_lg().overflow_hidden().flex()
                .on_click(|_, _, cx| cx.stop_propagation())
                .child(div().w(px(200.)).flex_none().h_full().bg(c(SIDEBAR)).border_r_1().border_color(c(BORDER)).p(px(10.)).flex().flex_col().gap(px(2.))
                    .child(div().px(px(10.)).py(px(8.)).text_size(px(11.)).text_color(c(DIM)).child(t(es, "Configuración", "Settings")))
                    .children(tabs.into_iter().enumerate().map(|(i, (st, ic, name))| {
                        let on = st == tab;
                        div().id(("set-tab", i)).flex().items_center().gap(px(10.)).h(px(32.)).px(px(10.)).rounded(px(8.)).cursor_pointer().text_size(px(13.))
                            .when(on, |d| d.bg(c(SURFACE_2)).text_color(c(TEXT)))
                            .when(!on, |d| d.text_color(c(TEXT_2)).hover(|h| h.bg(c(HOVER))))
                            .child(icon(ic, 15., if on { TEXT } else { MUTED })).child(name)
                            .on_click(cx.listener(move |this, _, _, cx| this.open_settings(Some(st), cx)))
                    }))
                    .child(div().flex_1())
                    .child(div().px(px(10.)).pb(px(6.)).text_size(px(9.)).text_color(c(DIM)).child("AI SOFTWARE FACTORY KIT")))
                .child(div().flex_1().min_w(px(0.)).h_full().relative().child(body)
                    .child(div().absolute().top(px(10.)).right(px(10.)).child(icon_button("close-settings", "x", cx.listener(|this, _, _, cx| this.open_settings(None, cx)))))))
            .into_any_element()
    }
}

// ================================================================ skeletons
// Same structure and sizes as the real screens, without data; the data replaces them in place.

impl ProjectView {
    fn pending_skeleton(&self) -> AnyElement {
        let es = self.es;
        let row = |g: usize, i: usize, chip: bool, w2: f32| div().flex().flex_col().gap(px(5.)).p(px(10.)).mb(px(2.)).rounded(px(9.)).border_1().border_color(gpui::transparent_black())
            .child(div().h(px(if chip { 21. } else { 18.6 })).flex().items_center().gap(px(8.))
                .child(skeleton(("pk-k", g * 10 + i), px(64.), 8.))
                .when(chip, |d| d.child(skeleton(("pk-c", g * 10 + i), px(44.), 15.))))
            .child(skeleton_text(("pk-s", g * 10 + i), relative(w2), 12.));
        let group = |g: usize, rows: &[(bool, f32)]| div()
            .child(div().flex().items_center().gap(px(8.)).h(px(26.)).px(px(8.)).mt(px(8.))
                .child(skeleton(("pg-d", g), px(7.), 7.)).child(skeleton(("pg-n", g), px(78.), 7.)).child(div().flex_1()).child(skeleton(("pg-c", g), px(10.), 7.)))
            .children(rows.iter().enumerate().map(|(i, (c, w))| row(g, i, *c, *w)));
        let list = div().w(px(360.)).flex_none().h_full().flex().flex_col().border_r_1().border_color(c(BORDER))
            .child(div().p(px(16.)).pb(px(8.)).flex().items_baseline().gap(px(8.)).child(ui::h1(t(es, "Pendientes", "Pending"))).child(mono("orqen pending").text_size(px(11.)).text_color(c(DIM))))
            .child(div().flex_1().overflow_hidden().px(px(8.)).pb(px(14.))
                .child(group(0, &[(true, 0.62), (false, 0.48)]))
                .child(group(1, &[(true, 0.55), (true, 0.7), (false, 0.4)])));
        div().size_full().flex().child(list).child(detail_skeleton()).into_any_element()
    }
}

fn detail_skeleton() -> AnyElement {
    let pills = [78., 96., 66., 100., 70., 92., 62.];
    let card = |i: usize, w1: f32, w2: f32| div().flex().items_center().gap(px(10.)).p(px(10.)).rounded(px(10.)).border_1().border_color(c(0x1E2638)).bg(c(SURFACE))
        .child(div().flex_1().flex().flex_col().gap(px(3.)).child(skeleton_text(("dc-a", i), relative(w1), 12.)).child(skeleton_text(("dc-b", i), relative(w2), 12.5)))
        .child(skeleton(("dc-i", i), px(14.), 14.));
    let event = |i: usize, w1: f32, w2: f32| div().flex().gap(px(10.)).py(px(6.))
        .child(div().w(px(84.)).flex_none().child(skeleton_text(("de-t", i), px(66.), 11.)))
        .child(div().flex_1().flex().flex_col().gap(px(2.)).child(skeleton_text(("de-a", i), relative(w1), 12.5)).child(skeleton_text(("de-b", i), relative(w2), 12.)));
    div().flex_1().min_w(px(0.)).h_full().flex().flex_col()
        .child(div().p(px(18.)).pb(px(14.)).border_b_1().border_color(c(BORDER)).flex().flex_col().gap(px(12.))
            .child(div().h(px(28.)).flex().items_center().gap(px(10.))
                .child(skeleton("dh-k", px(92.), 13.)).child(skeleton("dh-c", px(86.), 19.)).child(skeleton("dh-l", px(70.), 19.))
                .child(div().flex_1()).child(skeleton("dh-b", px(98.), 28.)))
            .child(div().flex().flex_wrap().gap(px(4.)).children(pills.iter().enumerate().map(|(i, w)| skeleton(("dp", i), px(*w), 24.).rounded_full()))))
        .child(div().flex_1().overflow_hidden().p(px(18.)).flex().flex_col().gap(px(18.))
            .child(div().flex().flex_col().gap(px(8.)).child(skeleton_text("dl-1", px(62.), 11.)).child(card(0, 0.38, 0.5)).child(card(1, 0.3, 0.42)))
            .child(div().flex().flex_col().child(skeleton_text("dl-2", px(70.), 11.))
                .child(div().mt(px(6.)).child(event(0, 0.34, 0.52)).child(event(1, 0.4, 0.6)).child(event(2, 0.3, 0.45)))))
        .into_any_element()
}

fn env_row_skeleton(i: usize) -> impl IntoElement {
    div().flex().items_center().gap(px(12.)).px(px(22.)).h(px(48.)).border_b_1().border_color(c(0x141A28))
        .child(div().w(px(150.)).flex().items_center().gap(px(9.)).child(skeleton(("er-d", i), px(7.), 7.)).child(skeleton(("er-n", i), px([54., 44., 36.][i % 3]), 9.)))
        .child(div().flex_1().min_w(px(0.)).child(skeleton(("er-c", i), relative([0.55, 0.48, 0.4][i % 3]), 8.)))
        .child(div().w(px(70.)).child(skeleton(("er-p", i), px(38.), 8.)))
        .child(div().w(px(70.)).child(skeleton(("er-w", i), px(46.), 8.)))
        .child(div().w(px(90.)).child(skeleton(("er-l", i), px(44.), 8.)))
}

fn connectors_skeleton() -> AnyElement {
    let card_sk = |i: usize, rows: usize| card().w(px(470.)).flex().flex_col().overflow_hidden()
        .child(div().p(px(16.)).flex().flex_col().gap(px(4.)).border_b_1().border_color(c(0x161D2D))
            .child(div().h(px(22.6)).flex().items_center().gap(px(8.)).child(skeleton(("cs-d", i), px(7.), 7.)).child(skeleton(("cs-t", i), px(112.), 10.)).child(div().flex_1()).child(skeleton(("cs-b", i), px(70.), 18.)))
            .child(skeleton_text(("cs-s", i), relative(0.82), 12.)))
        .child(div().p(px(16.)).flex().flex_col().gap(px(12.))
            .child(div().flex().items_center().gap(px(10.)).child(skeleton(("cs-g", i), px(24.), 24.)).child(skeleton(("cs-l", i), px(180.), 9.)))
            .child(skeleton(("cs-ok", i), relative(1.), 38.))
            .child(div().flex().flex_col().gap(px(10.)).children((0..rows).map(|r| div().flex().gap(px(12.))
                .child(div().flex_1().child(skeleton(("cs-r1", i * 10 + r), relative(0.6), 8.)))
                .child(div().flex_1().child(skeleton(("cs-r2", i * 10 + r), relative(0.5), 8.)))))));
    div().size_full().overflow_hidden().p(px(22.)).flex().flex_col().gap(px(16.))
        .child(div().max_w(px(760.)).flex().flex_col().child(skeleton_text("cs-p1", relative(0.9), 13.)).child(skeleton_text("cs-p2", relative(0.55), 13.)))
        .child(div().flex().flex_wrap().gap(px(16.)).child(card_sk(0, 3)).child(card_sk(1, 2)))
        .into_any_element()
}

fn tutorial_skeleton(n: usize) -> AnyElement {
    div().flex_1().min_w(px(0.)).h_full().overflow_hidden().px(px(40.)).py(px(28.)).child(div().w_full().max_w(px(900.)).flex().flex_col().gap(px(16.))
        .child(div().h(px(4.)).rounded_full().bg(c(BORDER)))
        .child(div().w_full().flex().flex_col().gap(px(10.))
            .child(div().mt(px(4.)).child(skeleton_text(("ts-h", n), relative(0.36), 26.)))
            .children([0.92, 0.85, 0.6].into_iter().enumerate().map(|(i, w)| div().h(px(23.)).flex().items_center().child(skeleton(("ts-p", i), relative(w), 9.))))
            .child(skeleton("ts-code", relative(1.), 74.)))
        .child(div().flex().items_center().gap(px(8.)).mt(px(6.)).child(skeleton("ts-b1", px(84.), 28.)).child(div().flex_1()).child(skeleton("ts-b2", px(90.), 28.))))
        .into_any_element()
}

/// Minimal Markdown for the tutorial steps written by the CLI (headings, lists, code blocks, quotes, tables).
fn markdown(md: &str) -> impl IntoElement {
    let mut out: Vec<AnyElement> = vec![];
    let mut code: Option<Vec<String>> = None;
    let clean = |l: &str| l.replace("**", "").replace('`', "");
    for line in md.lines() {
        if line.trim_start().starts_with("```") {
            if let Some(lines) = code.take() {
                out.push(div().p(px(14.)).rounded(px(10.)).bg(c(0x070A12)).border_1().border_color(c(0x1E2638)).font_family(MONO_FONT).text_size(px(12.5)).text_color(c(TEXT))
                    .children(lines.into_iter().map(|l| div().child(if l.is_empty() { " ".to_string() } else { l }))).into_any_element());
            } else { code = Some(vec![]); }
            continue;
        }
        if let Some(lines) = code.as_mut() { lines.push(line.to_string()); continue; }
        let l = line.trim_end();
        if l.trim().is_empty() { continue; }
        if let Some(h) = l.strip_prefix("### ").or(l.strip_prefix("## ")).or(l.strip_prefix("# ")) {
            out.push(div().mt(px(4.)).text_size(px(26.)).font_weight(FontWeight::BOLD).text_color(c(TEXT)).child(clean(h)).into_any_element());
        } else if let Some(b) = l.trim_start().strip_prefix("- ").or(l.trim_start().strip_prefix("* ")) {
            out.push(div().flex().gap(px(10.)).pl(px(4.)).child(div().mt(px(7.)).size(px(5.)).rounded_full().bg(c(BLUE_TEXT)).flex_none())
                .child(div().flex_1().min_w(px(0.)).text_size(px(14.)).text_color(c(TEXT_2)).child(clean(b))).into_any_element());
        } else if let Some(q) = l.strip_prefix("> ") {
            out.push(div().p(px(12.)).rounded(px(10.)).bg(c(SURFACE)).border_1().border_color(c(0x1E2638)).text_size(px(13.)).text_color(c(TEXT_2)).child(clean(q)).into_any_element());
        } else if l.starts_with('|') {
            if l.contains("---") { continue; }
            let cells: Vec<String> = l.trim_matches('|').split('|').map(|x| clean(x.trim())).collect();
            out.push(div().flex().gap(px(12.)).py(px(5.)).border_b_1().border_color(c(0x141A28)).text_size(px(12.5))
                .children(cells.into_iter().map(|x| div().flex_1().text_color(c(TEXT_2)).child(x))).into_any_element());
        } else {
            out.push(div().text_size(px(14.5)).line_height(px(23.)).text_color(c(TEXT_2)).child(clean(l)).into_any_element());
        }
    }
    div().w_full().flex().flex_col().gap(px(10.)).children(out)
}
