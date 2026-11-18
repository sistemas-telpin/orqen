//! Visual `orqen init` for a folder without orqen: options, where the tickets live, and live progress.
//! It runs `orqen init --yes` and then `orqen connectors set -` (the CLI does the work; this only asks and shows).
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use gpui::{
    AnyElement, Context, Entity, EventEmitter, FontWeight, IntoElement, Render, SharedString, Window, div, linear_color_stop,
    linear_gradient, prelude::*, px,
};
use serde_json::{Map, Value, json};

use crate::cli::{self, Cli};
use crate::input::TextInput;
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
    ext: &'static str,
    int: &'static str,
    inputs: Vec<(&'static str, Entity<TextInput>)>,
    log: Arc<Mutex<Vec<String>>>,
    phase: Phase,
    opened: Instant,
}

impl EventEmitter<Initialized> for InitWizard {}

fn t(es: bool, a: &'static str, b: &'static str) -> &'static str { if es { a } else { b } }

/// (id, label es, label en, placeholder, masked)
const FIELDS: &[(&str, &str, &str, &str, bool)] = &[
    ("jira.url", "URL de Jira", "Jira URL", "https://tu-empresa.atlassian.net", false),
    ("jira.user", "Cuenta que comenta y crea tickets (email)", "Account that comments and creates tickets (email)", "bot@tu-empresa.com", false),
    ("jira.token", "API token de esa cuenta", "API token of that account", "", true),
    ("ext.jira.key", "Proyecto de Jira donde entran los pedidos", "Jira project where requests arrive", "SOP", false),
    ("ext.github.repo", "Repositorio donde entran los pedidos (dueño/nombre)", "Repository where requests arrive (owner/name)", "mi-org/soporte", false),
    ("ext.asana.project", "Id del proyecto de Asana", "Asana project id", "1204567890123456", false),
    ("int.jira.key", "Proyecto de Jira del equipo", "Team Jira project", "DEV", false),
    ("int.github.repo", "Repositorio del equipo (dueño/nombre)", "Team repository (owner/name)", "mi-org/mi-repo", false),
    ("int.github.project", "Número del GitHub Project (opcional)", "GitHub Project number (optional)", "7", false),
    ("int.asana.project", "Id del proyecto de Asana del equipo", "Team Asana project id", "1209876543210987", false),
    ("github.token", "Token de GitHub (vacío: usa la sesión de `gh`)", "GitHub token (empty: uses your `gh` session)", "", true),
    ("asana.token", "Token personal de Asana", "Asana personal access token", "", true),
];

impl InitWizard {
    pub fn new(cli: Cli, es: bool, cx: &mut Context<Self>) -> Self {
        let inputs: Vec<(&'static str, Entity<TextInput>)> = FIELDS.iter().map(|(id, es_l, en_l, ph, masked)| {
            let _ = (es_l, en_l);
            (*id, cx.new(|cx| TextInput::new(cx, *ph, String::new(), *masked)))
        }).collect();
        // the GitHub repo is proposed from the `origin` remote; git runs in the background so it never holds up the window
        if let Some((_, field)) = inputs.iter().find(|(id, _)| *id == "int.github.repo") {
            let (field, repo) = (field.clone(), cli.repo.clone());
            cx.spawn(async move |_, cx| {
                let origin = cx.background_executor().spawn(async move { cli::github_origin(&repo) }).await;
                if let Some(o) = origin { field.update(cx, |f, cx| f.suggest(o, cx)).ok(); }
            }).detach();
        }
        Self { cli, es, ai: true, openspec: true, ext: "jira", int: "none", inputs, log: Arc::new(Mutex::new(vec![])), phase: Phase::Intro, opened: Instant::now() }
    }

    fn val(&self, id: &str, cx: &Context<Self>) -> String {
        self.inputs.iter().find(|(i, _)| *i == id).map(|(_, e)| e.read(cx).text().trim().to_string()).unwrap_or_default()
    }

    /// The `conectores` block and the secrets for orqen/.env, from what was typed.
    fn connectors(&self, cx: &Context<Self>) -> Option<Value> {
        if self.ext == "later" { return None; }
        let v = |id: &str| self.val(id, cx);
        let mut env = Map::new();
        let mut put = |k: &str, x: String| { if !x.is_empty() { env.insert(k.into(), Value::String(x)); } };
        let uses = |k: &str| self.ext == k || self.int == k;
        if uses("jira") {
            let url = v("jira.url").trim_end_matches('/').to_string();
            put("JIRA_DEPLOYMENT", if url.contains("atlassian.net") || url.is_empty() { "cloud".into() } else { "server".into() });
            put("JIRA_URL", url); put("JIRA_USER", v("jira.user")); put("JIRA_TOKEN", v("jira.token"));
        }
        if uses("github") { put("GITHUB_TOKEN", v("github.token")); }
        if uses("asana") { put("ASANA_TOKEN", v("asana.token")); }
        let requests = match self.ext {
            "jira" => { let k = v("ext.jira.key").to_uppercase(); json!({ "tipo": "jira", "filtro": if k.is_empty() { "labels = orqen AND statusCategory != Done".to_string() } else { format!("project = {k} AND labels = orqen AND statusCategory != Done") } }) }
            "github" => json!({ "tipo": "github", "repo": v("ext.github.repo"), "filtro": "is:open label:orqen" }),
            _ => json!({ "tipo": "asana", "proyecto": v("ext.asana.project"), "filtro": "orqen" }),
        };
        let issues = match self.int {
            "jira" => json!({ "tipo": "jira", "proyecto": v("int.jira.key").to_uppercase(), "tipo_ticket": "Task", "vinculo": "Relates" }),
            "github" => { let mut o = json!({ "tipo": "github", "repo": v("int.github.repo"), "etiquetas": ["orqen"] }); if let Ok(n) = v("int.github.project").parse::<u64>() { o["proyecto"] = json!(n); } o }
            "asana" => json!({ "tipo": "asana", "proyecto": v("int.asana.project") }),
            _ => Value::Null,
        };
        Some(json!({ "conectores": { "requests": requests, "issues": issues }, "env": env }))
    }

    fn start(&mut self, cx: &mut Context<Self>) {
        if self.phase == Phase::Running { return; }
        self.phase = Phase::Running;
        self.log.lock().unwrap().clear();
        let mut args = vec!["init", "--yes", "--no-animation"];
        if !self.ai { args.push("--no-ai"); }
        if !self.openspec { args.push("--no-openspec"); }
        let args: Vec<String> = args.into_iter().map(String::from).collect();
        let conn = self.connectors(cx).map(|v| v.to_string());
        let (cli, log) = (self.cli.clone(), self.log.clone());
        let done: Arc<Mutex<Option<bool>>> = Arc::new(Mutex::new(None));
        let flag = done.clone();
        std::thread::spawn(move || {
            let a: Vec<&str> = args.iter().map(String::as_str).collect();
            let mut ok = cli.stream(&a, None, log.clone()).unwrap_or(false) && cli.has_orqen();
            if ok { if let Some(json) = conn {
                log.lock().unwrap().push("◇  Connectors".into());
                ok = cli.stream(&["connectors", "set", "-"], Some(json), log.clone()).unwrap_or(false);
            } }
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

    fn choice(&self, id: &'static str, options: &[(&'static str, &'static str)], current: &'static str, ext: bool, cx: &mut Context<Self>) -> impl IntoElement {
        div().flex().gap(px(6.)).children(options.iter().enumerate().map(|(i, (key, label))| {
            let on = *key == current;
            let key = *key;
            div().id((id, i)).flex_1().h(px(36.)).flex().items_center().justify_center().gap(px(8.)).rounded(px(9.)).cursor_pointer().text_size(px(12.5))
                .when(on, |d| d.border_1().border_color(c(if ext { BLUE } else { MAGENTA })).bg(c(SURFACE_2)).text_color(c(TEXT)).font_weight(FontWeight::SEMIBOLD))
                .when(!on, |d| d.border_1().border_color(c(0x1E2638)).text_color(c(TEXT_2)).hover(|h| h.bg(c(HOVER))))
                .child(label.to_string())
                .on_click(cx.listener(move |this, _, _, cx| { if ext { this.ext = key } else { this.int = key }; cx.notify(); }))
        }))
    }

    fn fields(&self, ids: &[&str]) -> impl IntoElement {
        let es = self.es;
        div().flex().flex_col().gap(px(10.)).children(ids.iter().filter_map(|id| {
            let (_, l_es, l_en, _, _) = FIELDS.iter().find(|f| f.0 == *id)?;
            let input = self.inputs.iter().find(|(i, _)| i == id)?.1.clone();
            Some(div().flex().flex_col().gap(px(5.)).child(div().text_size(px(11.5)).text_color(c(MUTED)).child(if es { *l_es } else { *l_en })).child(input))
        }))
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
        let ext_fields: Vec<&str> = match self.ext {
            "jira" => vec!["jira.url", "jira.user", "jira.token", "ext.jira.key"],
            "github" => vec!["ext.github.repo", "github.token"],
            "asana" => vec!["ext.asana.project", "asana.token"],
            _ => vec![],
        };
        let int_fields: Vec<&str> = match self.int {
            "jira" if self.ext == "jira" => vec!["int.jira.key"],
            "jira" => vec!["jira.url", "jira.user", "jira.token", "int.jira.key"],
            "github" if self.ext == "github" => vec!["int.github.repo", "int.github.project"],
            "github" => vec!["int.github.repo", "int.github.project", "github.token"],
            "asana" if self.ext == "asana" => vec!["int.asana.project"],
            "asana" => vec!["int.asana.project", "asana.token"],
            _ => vec![],
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
                .child(section(t(es, "¿DÓNDE ENTRAN LOS PEDIDOS DEL CLIENTE? (TICKET EXTERNO)", "WHERE DO CLIENT REQUESTS ARRIVE? (EXTERNAL TICKET)")))
                .child(self.choice("ext", &[("jira", "Jira"), ("github", "GitHub"), ("asana", "Asana"), ("later", if es { "Más tarde" } else { "Later" })], self.ext, true, cx))
                .child(self.fields(&ext_fields))
                .when(self.ext != "later", |d| d
                    .child(section(t(es, "¿DÓNDE SIGUE EL TRABAJO EL EQUIPO? (TICKET INTERNO, OPCIONAL)", "WHERE DOES THE TEAM TRACK THE WORK? (INTERNAL TICKET, OPTIONAL)")))
                    .child(self.choice("int", &[("none", if es { "Ninguno" } else { "None" }), ("jira", "Jira"), ("github", "GitHub"), ("asana", "Asana")], self.int, false, cx))
                    .child(self.fields(&int_fields)))
                .child(div().mt(px(10.)).flex().items_center().gap(px(12.))
                    .child(div().flex_1().text_size(px(11.5)).text_color(c(DIM)).child(t(es, "Los tokens quedan en orqen/.env, que Git ignora.", "Tokens go to orqen/.env, which Git ignores.")))
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
            t(es, "Conecta dónde viven los tickets (podés hacerlo después)", "Connects where the tickets live (you can do it later)"),
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

