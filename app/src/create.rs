//! The `+` of the tab bar: import a project (open a folder) or create a new one with `orqen bootstrap`.
//! Creating: name, folder, a stack of the catalog and its parameters, then the CLI runs and its progress is shown live.
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use gpui::{
    AnyElement, Context, Entity, EventEmitter, FontWeight, IntoElement, PathPromptOptions, Render, SharedString, Window, div, prelude::*, px, relative,
};
use serde_json::{Map, Value};

use crate::cli::Cli;
use crate::input::TextInput;
use crate::theme::*;
use crate::ui::{self, Kind, appear, button, icon, live_dot, mono, skeleton, skeleton_text};

/// "Import": the shell asks for a folder.
pub struct Import;
/// The project was created in this folder (the shell opens it in a tab).
pub struct Created(pub PathBuf);
pub struct Closed;

#[derive(PartialEq, Clone, Copy)]
enum Phase { Choose, Form, Running, Failed }

enum Catalog { Loading, Ready(Vec<Value>), NeedsRepo(String), Failed(String) }

pub struct NewProject {
    base: Cli,
    es: bool,
    phase: Phase,
    opened: Instant,
    catalog: Catalog,
    repo: Entity<TextInput>,
    name: Entity<TextInput>,
    /// Where the project folder is created (chosen with the system folder picker); the folder itself is `slug(name)`.
    parent: PathBuf,
    stack: Option<String>,
    /// `orqen bootstrap --describe <stack> --json`
    describe: Option<Result<Value, String>>,
    describing: bool,
    params: Vec<(String, Entity<TextInput>)>,
    error: Option<String>,
    log: Arc<Mutex<Vec<String>>>,
    target: Option<PathBuf>,
}

impl EventEmitter<Import> for NewProject {}
impl EventEmitter<Created> for NewProject {}
impl EventEmitter<Closed> for NewProject {}

fn t(es: bool, a: &'static str, b: &'static str) -> &'static str { if es { a } else { b } }
fn s(v: &Value, k: &str) -> String { v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string() }

/// Folder name from the project name, like the CLI (variablesBase): "Facturación Web" → facturacion-web.
pub fn slug(name: &str) -> String {
    let mut out = String::new();
    for ch in name.to_lowercase().chars() {
        let c = match ch { 'á' | 'à' | 'ä' | 'â' | 'ã' => 'a', 'é' | 'è' | 'ë' | 'ê' => 'e', 'í' | 'ì' | 'ï' | 'î' => 'i', 'ó' | 'ò' | 'ö' | 'ô' | 'õ' => 'o', 'ú' | 'ù' | 'ü' | 'û' => 'u', 'ñ' => 'n', 'ç' => 'c', c => c };
        if c.is_ascii_alphanumeric() { out.push(c) } else if !out.ends_with('-') { out.push('-') }
    }
    let s = out.trim_matches('-').to_string();
    if s.is_empty() { "proyecto".into() } else { s }
}

/// Progress steps in the CLI output (clack prints ◇ ◆ ● or, without a terminal, o * !).
fn steps(lines: &[String]) -> Vec<String> {
    lines.iter().filter_map(|l| {
        let mut chars = l.chars();
        let sym = chars.next()?;
        if !matches!(sym, '◇' | '◆' | '●' | '▲' | '■' | 'o' | '*' | '!' | 'x') { return None; }
        let rest: String = chars.collect();
        if !rest.starts_with("  ") { return None; }
        let text = rest.trim().trim_end_matches(['─', '╮', '+', '-', ' ']).trim().to_string();
        (!text.is_empty()).then_some(text)
    }).collect()
}

/// Lines worth showing in the console: no box borders, no blank lines, no logo.
fn console_line(l: &str) -> bool {
    let x = l.trim();
    !x.is_empty() && !x.starts_with(['│', '|', '+', '╰', '╭', '└'])
        && !x.contains(['█', '▀', '▄', '╔', '╗', '╚', '╝', '═', '║']) && !x.contains("AI Software Factory KIT") && !x.contains("From request to production")
}

impl NewProject {
    pub fn new(base: Cli, es: bool, parent: PathBuf, cx: &mut Context<Self>) -> Self {
        let repo = cx.new(|cx| TextInput::new(cx, "@mi-empresa/stacks", String::new(), false));
        let name = cx.new(|cx| TextInput::new(cx, if es { "Plataforma de Pagos" } else { "Payments Platform" }, String::new(), false));
        // the destination path shown under the name follows what is typed
        cx.observe(&name, |_, _, cx| cx.notify()).detach();
        Self { base, es, phase: Phase::Choose, opened: Instant::now(), catalog: Catalog::Loading, repo, name, parent, stack: None, describe: None, describing: false, params: vec![], error: None, log: Arc::new(Mutex::new(vec![])), target: None }
    }

    fn cli(&self) -> Cli { Cli { repo: if self.parent.is_dir() { self.parent.clone() } else { crate::state::home() }, ..self.base.clone() } }

    fn load_catalog(&mut self, cx: &mut Context<Self>) {
        self.catalog = Catalog::Loading;
        let repo = self.repo.read(cx).text().trim().to_string();
        let cli = self.cli();
        cx.spawn(async move |this, cx| {
            let r = cx.background_executor().spawn(async move {
                let mut args = vec!["bootstrap", "--list", "--json"];
                if !repo.is_empty() { args.extend(["--tools-repo", repo.as_str()]); }
                cli.json(&args)
            }).await;
            this.update(cx, |this, cx| {
                this.catalog = match r {
                    Ok(v) if v.get("error").is_some() => if v["needsRepo"].as_bool() == Some(true) { Catalog::NeedsRepo(s(&v, "error")) } else { Catalog::Failed(s(&v, "error")) },
                    Ok(v) => {
                        let list = v["stacks"].as_array().cloned().unwrap_or_default();
                        if this.stack.is_none() { if let Some(first) = list.first() { let id = s(first, "id"); this.select(id, cx); } }
                        Catalog::Ready(list)
                    }
                    Err(e) => Catalog::Failed(e.to_string()),
                };
                cx.notify();
            }).ok();
        }).detach();
        cx.notify();
    }

    fn select(&mut self, id: String, cx: &mut Context<Self>) {
        self.stack = Some(id.clone());
        self.describe = None;
        self.describing = true;
        self.params.clear();
        self.error = None;
        let name = self.name.read(cx).text().trim().to_string();
        let cli = self.cli();
        cx.spawn(async move |this, cx| {
            let r = cx.background_executor().spawn(async move {
                let mut args = vec!["bootstrap", "--describe", id.as_str(), "--json"];
                if !name.is_empty() { args.push(name.as_str()); }
                cli.json(&args)
            }).await;
            this.update(cx, |this, cx| {
                this.describing = false;
                match r {
                    Ok(v) if v.get("error").is_some() => this.describe = Some(Err(s(&v, "error"))),
                    Ok(v) => {
                        this.params = v["parametros"].as_array().cloned().unwrap_or_default().iter().map(|p| {
                            let (id, def) = (s(p, "id"), s(p, "defecto"));
                            (id, cx.new(|cx| TextInput::new(cx, def.clone(), def, false)))
                        }).collect();
                        this.describe = Some(Ok(v));
                    }
                    Err(e) => this.describe = Some(Err(e.to_string())),
                }
                cx.notify();
            }).ok();
        }).detach();
        cx.notify();
    }

    fn choose_parent(&mut self, cx: &mut Context<Self>) {
        let rx = cx.prompt_for_paths(PathPromptOptions { files: false, directories: true, multiple: false, prompt: Some(t(self.es, "Crear adentro de esta carpeta", "Create inside this folder").into()) });
        cx.spawn(async move |this, cx| {
            if let Ok(Ok(Some(paths))) = rx.await {
                if let Some(p) = paths.into_iter().next() { this.update(cx, |this, cx| { this.parent = p; cx.notify(); }).ok(); }
            }
        }).detach();
    }

    fn folder_name(&self, cx: &Context<Self>) -> String { slug(&self.name.read(cx).text()) }

    fn blocked(&self) -> Vec<String> {
        match &self.describe {
            Some(Ok(v)) => v["requisitos"].as_array().map(|a| a.iter().filter(|r| r["bloquea"].as_bool() == Some(true)).map(|r| s(r, "comando")).collect()).unwrap_or_default(),
            _ => vec![],
        }
    }

    fn create(&mut self, cx: &mut Context<Self>) {
        let es = self.es;
        let name = self.name.read(cx).text().trim().to_string();
        if name.is_empty() { self.error = Some(t(es, "Poné un nombre al proyecto.", "Give the project a name.").into()); cx.notify(); return; }
        let Some(stack) = self.stack.clone() else { self.error = Some(t(es, "Elegí un stack.", "Pick a stack.").into()); cx.notify(); return; };
        if !self.blocked().is_empty() { self.error = Some(format!("{} {}", t(es, "Faltan en esta máquina:", "Missing on this machine:"), self.blocked().join(", "))); cx.notify(); return; }
        let target = self.parent.join(self.folder_name(cx));
        if target.exists() && std::fs::read_dir(&target).map(|mut d| d.next().is_some()).unwrap_or(false) {
            self.error = Some(format!("{} {}", target.display(), t(es, "ya existe y no está vacía. Elegí otra carpeta.", "already exists and is not empty. Choose another folder.")));
            cx.notify();
            return;
        }
        let mut params = Map::new();
        for (id, input) in &self.params { let v = input.read(cx).text().trim().to_string(); if !v.is_empty() { params.insert(id.clone(), Value::String(v)); } }
        let repo = self.repo.read(cx).text().trim().to_string();
        let mut args: Vec<String> = vec!["bootstrap".into(), name, "--stack".into(), stack, "--dir".into(), target.display().to_string(), "--yes".into(), "--no-animation".into()];
        if !params.is_empty() { args.extend(["--params".into(), Value::Object(params).to_string()]); }
        if !repo.is_empty() { args.extend(["--tools-repo".into(), repo]); }
        self.error = None;
        self.phase = Phase::Running;
        self.opened = Instant::now();
        self.target = Some(target.clone());
        self.log.lock().unwrap().clear();
        let (cli, log) = (self.cli(), self.log.clone());
        let done: Arc<Mutex<Option<bool>>> = Arc::new(Mutex::new(None));
        let flag = done.clone();
        std::thread::spawn(move || {
            let a: Vec<&str> = args.iter().map(String::as_str).collect();
            let ok = cli.stream(&a, None, log).unwrap_or(false) && target.join("orqen").join("config.yaml").exists();
            *flag.lock().unwrap() = Some(ok);
        });
        cx.spawn(async move |this, cx| loop {
            cx.background_executor().timer(Duration::from_millis(200)).await;
            let r = *done.lock().unwrap();
            let alive = this.update(cx, |this, cx| {
                if let Some(ok) = r { if ok { if let Some(p) = this.target.clone() { cx.emit(Created(p)); } } else { this.phase = Phase::Failed; } }
                cx.notify();
            }).is_ok();
            if !alive || r.is_some() { break; }
        }).detach();
        cx.notify();
    }

    // ================================================================ views

    fn choose(&self, cx: &mut Context<Self>) -> AnyElement {
        let es = self.es;
        let option = |id: &'static str, ic: &'static str, color: u32, title: &'static str, body: &'static str, cmd: &'static str| {
            div().id(id).flex_1().min_w(px(0.)).flex().flex_col().gap(px(10.)).p(px(18.)).rounded(px(12.)).border_1().border_color(c(0x1E2638)).bg(c(SURFACE)).cursor_pointer()
                .hover(|h| h.border_color(c(0x2E3A55)).bg(c(0x111A2E)))
                .child(div().size(px(36.)).rounded(px(9.)).flex().items_center().justify_center().bg(c(0x141B2B)).child(icon(ic, 17., color)))
                .child(div().text_size(px(14.)).font_weight(FontWeight::SEMIBOLD).text_color(c(TEXT)).child(title))
                .child(div().text_size(px(12.)).text_color(c(MUTED)).child(body))
                .child(div().flex_1())
                .child(mono(cmd).text_size(px(11.)).text_color(c(DIM)))
        };
        div().flex().flex_col().gap(px(16.)).p(px(24.))
            .child(div().flex().flex_col().gap(px(4.)).child(ui::h1(t(es, "Agregar un proyecto", "Add a project")))
                .child(div().text_size(px(12.5)).text_color(c(MUTED)).child(t(es, "Cada proyecto queda en su pestaña.", "Each project gets its own tab."))))
            .child(div().flex().gap(px(14.)).h(px(190.))
                .child(option("np-import-card", "folder", BLUE_TEXT, t(es, "Importar proyecto", "Import a project"),
                    t(es, "Abrí una carpeta con código que ya existe. Si todavía no usa ORQEN, te ofrecemos inicializarla.", "Open a folder with existing code. If it doesn't use ORQEN yet, you can set it up."), "orqen init")
                    .on_click(cx.listener(|_, _, _, cx| cx.emit(Import))))
                .child(option("np-create-card", "play", MAGENTA_TEXT, t(es, "Crear proyecto nuevo", "Create a new project"),
                    t(es, "Elegí un stack del catálogo: genera el código, las herramientas para levantarlo y deja ORQEN listo.", "Pick a stack from the catalog: it generates the code, the tools to run it and leaves ORQEN ready."), "orqen bootstrap")
                    .on_click(cx.listener(|this, _, _, cx| { this.phase = Phase::Form; if matches!(this.catalog, Catalog::Loading) { this.load_catalog(cx); } cx.notify(); }))))
            .into_any_element()
    }

    fn label(text: &'static str) -> gpui::Div { div().text_size(px(11.5)).text_color(c(MUTED)).child(text) }

    fn stacks(&self, cx: &mut Context<Self>) -> AnyElement {
        let es = self.es;
        match &self.catalog {
            Catalog::Loading => div().flex().flex_col().gap(px(8.)).children((0..3usize).map(|i| div().flex().items_center().gap(px(12.)).p(px(12.)).rounded(px(10.)).border_1().border_color(c(0x1E2638))
                .child(div().flex_1().flex().flex_col().gap(px(3.)).child(skeleton_text(("st-n", i), px(140.), 13.)).child(skeleton_text(("st-d", i), relative(0.7), 12.)))))
                .into_any_element(),
            Catalog::NeedsRepo(e) | Catalog::Failed(e) => {
                let needs = matches!(self.catalog, Catalog::NeedsRepo(_));
                div().flex().flex_col().gap(px(10.)).p(px(14.)).rounded(px(10.)).border_1().border_dashed().border_color(c(BORDER_2))
                    .child(div().text_size(px(12.5)).text_color(c(TEXT_2)).child(if needs {
                        t(es, "Los stacks vienen de un repositorio de GitHub de tu empresa (se clona una vez con tus credenciales de Git).", "Stacks come from a GitHub repository of your company (cloned once with your Git credentials).").to_string()
                    } else { e.clone() }))
                    .when(!needs, |d| d.child(div().text_size(px(11.5)).text_color(c(DIM)).child(t(es, "Si es un problema de acceso, revisá tus credenciales de Git.", "If it is an access problem, check your Git credentials."))))
                    .child(div().flex().items_end().gap(px(10.))
                        .child(div().flex_1().flex().flex_col().gap(px(5.)).child(Self::label(t(es, "Repositorio de stacks", "Stack repository"))).child(self.repo.clone()))
                        .child(button("np-repo", t(es, "Conectar catálogo", "Connect catalog"), Kind::Accent, cx.listener(|this, _, _, cx| this.load_catalog(cx)))))
                    .into_any_element()
            }
            Catalog::Ready(list) if list.is_empty() => div().text_size(px(12.5)).text_color(c(MUTED)).child(t(es, "El catálogo no tiene stacks.", "The catalog has no stacks.")).into_any_element(),
            Catalog::Ready(list) => div().flex().flex_col().gap(px(8.)).children(list.iter().enumerate().map(|(i, st)| {
                let id = s(st, "id");
                let on = self.stack.as_deref() == Some(id.as_str());
                let id2 = id.clone();
                div().id(("stack", i)).flex().items_center().gap(px(12.)).p(px(12.)).rounded(px(10.)).cursor_pointer().border_1()
                    .when(on, |d| d.border_color(c(MAGENTA)).bg(c(SURFACE_2)))
                    .when(!on, |d| d.border_color(c(0x1E2638)).hover(|h| h.bg(c(HOVER))))
                    .child(div().size(px(16.)).flex_none().rounded_full().border_1().border_color(c(if on { MAGENTA } else { BORDER_2 })).flex().items_center().justify_center()
                        .when(on, |d| d.child(div().size(px(8.)).rounded_full().bg(c(MAGENTA)))))
                    .child(div().flex_1().min_w(px(0.)).flex().flex_col().gap(px(3.))
                        .child(div().flex().items_center().gap(px(8.)).child(div().text_size(px(13.)).font_weight(FontWeight::SEMIBOLD).text_color(c(TEXT)).child(s(st, "nombre"))).child(mono(id.clone()).text_size(px(10.5)).text_color(c(DIM))))
                        .child(div().text_size(px(12.)).text_color(c(MUTED)).child(s(st, "descripcion"))))
                    .on_click(cx.listener(move |this, _, _, cx| if this.stack.as_deref() != Some(id2.as_str()) { this.select(id2.clone(), cx) }))
            })).into_any_element(),
        }
    }

    fn details(&self) -> Option<AnyElement> {
        let es = self.es;
        if self.describing {
            return Some(div().flex().flex_col().gap(px(10.)).child(skeleton_text("ds-1", px(90.), 11.5)).child(div().flex().gap(px(12.)).child(skeleton("ds-2", relative(0.5), 34.)).child(skeleton("ds-3", relative(0.5), 34.)))
                .child(skeleton_text("ds-4", px(120.), 11.5)).child(skeleton("ds-5", relative(1.), 64.)).into_any_element());
        }
        let v = match self.describe.as_ref()? { Ok(v) => v, Err(e) => return Some(div().p(px(10.)).rounded(px(9.)).bg(c(0x1F0F14)).text_size(px(12.)).text_color(c(0xFECACA)).child(e.clone()).into_any_element()) };
        let pmeta = v["parametros"].as_array().cloned().unwrap_or_default();
        let req = v["requisitos"].as_array().cloned().unwrap_or_default();
        let procs = v["procesos"].as_array().cloned().unwrap_or_default();
        Some(div().flex().flex_col().gap(px(14.))
            .when(!self.params.is_empty(), |d| d.child(div().flex().flex_col().gap(px(8.)).child(ui::label(t(es, "PARÁMETROS", "PARAMETERS")))
                .child(div().flex().flex_wrap().gap(px(12.)).children(self.params.iter().map(|(id, input)| {
                    let meta = pmeta.iter().find(|p| s(p, "id") == *id).cloned().unwrap_or(Value::Null);
                    let busy = meta["enUso"].as_str().map(|p| format!("{} {p} {}", t(es, "El", "Port"), t(es, "está en uso: se propone otro.", "is in use: another one is proposed.")));
                    div().w(px(250.)).flex().flex_col().gap(px(5.)).child(div().text_size(px(11.5)).text_color(c(MUTED)).child(s(&meta, "pregunta"))).child(input.clone())
                        .children(busy.map(|b| div().text_size(px(11.)).text_color(c(AMBER)).child(b)))
                })))))
            .when(!req.is_empty(), |d| d.child(div().flex().flex_col().gap(px(6.)).child(ui::label(t(es, "REQUISITOS EN ESTA MÁQUINA", "REQUIREMENTS ON THIS MACHINE")))
                .children(req.iter().map(|r| {
                    let ok = r["ok"].as_bool() == Some(true);
                    let block = r["bloquea"].as_bool() == Some(true);
                    let col = if ok { GREEN } else if block { RED } else { AMBER };
                    div().flex().items_center().gap(px(10.)).text_size(px(12.))
                        .child(icon(if ok { "check" } else { "alert" }, 12., col))
                        .child(mono(s(r, "comando")).w(px(80.)).text_color(c(TEXT)))
                        .child(div().flex_1().min_w(px(0.)).truncate().text_color(c(if ok { MUTED } else { col })).child(if ok { s(r, "detalle") } else {
                            let ayuda = s(r, "ayuda");
                            format!("{}{}", if block { t(es, "Falta y se necesita para crearlo", "Missing, needed to create it") } else { t(es, "Falta; se necesita para levantarlo", "Missing; needed to run it") }, if ayuda.is_empty() { String::new() } else { format!(" · {ayuda}") })
                        }))
                }))))
            .when(!procs.is_empty(), |d| d.child(div().flex().flex_col().gap(px(6.)).child(ui::label(t(es, "CÓMO SE VA A LEVANTAR", "HOW IT WILL START")))
                .child(div().p(px(10.)).rounded(px(9.)).bg(c(0x070A12)).border_1().border_color(c(BORDER)).flex().flex_col().gap(px(4.))
                    .children(procs.iter().map(|p| div().flex().gap(px(10.)).text_size(px(11.5))
                        .child(mono(s(p, "nombre")).w(px(90.)).text_color(c(TEXT)))
                        .child(mono(s(p, "comando")).flex_1().min_w(px(0.)).truncate().text_color(c(TEXT_2)))
                        .when(s(p, "cuando") == "e2e", |d| d.child(div().text_color(c(DIM)).child("e2e"))))))))
            .into_any_element())
    }

    fn form(&self, cx: &mut Context<Self>) -> AnyElement {
        let es = self.es;
        let target = self.parent.join(self.folder_name(cx));
        div().flex().flex_col().gap(px(16.)).p(px(24.))
            .child(div().flex().items_center().gap(px(10.))
                .child(div().id("np-back").size(px(26.)).rounded(px(7.)).flex().items_center().justify_center().cursor_pointer().hover(|h| h.bg(c(0x161D2D)))
                    .child(div().text_size(px(15.)).text_color(c(MUTED)).child("‹")).on_click(cx.listener(|this, _, _, cx| { this.phase = Phase::Choose; this.error = None; cx.notify(); })))
                .child(ui::h1(t(es, "Crear proyecto nuevo", "Create a new project"))).child(mono("orqen bootstrap").text_size(px(11.)).text_color(c(DIM))))
            .child(div().flex().flex_col().gap(px(5.)).child(Self::label(t(es, "Nombre del proyecto", "Project name"))).child(self.name.clone()))
            .child(div().flex().flex_col().gap(px(5.)).child(Self::label(t(es, "Ubicación", "Location")))
                .child(div().flex().items_center().gap(px(10.))
                    // read-only: the folder is picked with the system dialog, the last part is the project name
                    .child(div().id("np-path").flex_1().min_w(px(0.)).h(px(34.)).px(px(10.)).flex().items_center().gap(px(8.)).rounded(px(8.))
                        .border_1().border_color(c(0x1E2638)).bg(c(0x070A12)).cursor_pointer().hover(|h| h.border_color(c(0x2E3A55)))
                        .child(icon("folder", 13., DIM))
                        .child(div().flex_1().min_w(px(0.)).truncate().child(mono(target.display().to_string()).text_size(px(12.)).text_color(c(TEXT_2))))
                        .on_click(cx.listener(|this, _, _, cx| this.choose_parent(cx))))
                    .child(button("np-parent", t(es, "Elegir carpeta…", "Choose folder…"), Kind::Ghost, cx.listener(|this, _, _, cx| this.choose_parent(cx)))))
                .child(div().text_size(px(11.)).text_color(c(DIM)).child(t(es, "El proyecto se crea en una carpeta nueva con el nombre del proyecto, dentro de la ubicación elegida.", "The project is created in a new folder named after the project, inside the chosen location."))))
            .child(div().flex().flex_col().gap(px(8.)).child(ui::label("STACK")).child(self.stacks(cx)))
            .children(self.details())
            .into_any_element()
    }

    fn progress(&self, cx: &mut Context<Self>) -> AnyElement {
        let es = self.es;
        let lines = self.log.lock().unwrap().clone();
        let running = self.phase == Phase::Running;
        let st = steps(&lines);
        let n = st.len();
        let shown: Vec<String> = lines.iter().filter(|l| console_line(l)).cloned().collect();
        let tail: Vec<String> = shown[shown.len().saturating_sub(10)..].to_vec();
        let name = self.name.read(cx).text();
        div().flex().flex_col().gap(px(16.)).p(px(24.))
            .child(div().flex().flex_col().gap(px(4.))
                .child(ui::h1(if running { t(es, "Creando el proyecto…", "Creating the project…") } else { t(es, "No se pudo crear el proyecto", "The project could not be created") }))
                .child(div().text_size(px(12.)).text_color(c(MUTED)).child(if running { format!("{name} · {}", t(es, "genera el código, instala las herramientas y prepara ORQEN. Puede tardar unos minutos.", "generating the code, installing the tools and preparing ORQEN. It can take a few minutes.")) } else {
                    if self.target.as_ref().map(|p| p.exists()).unwrap_or(false) { t(es, "La carpeta quedó como estaba para que veas qué pasó. Borrala si querés empezar de nuevo.", "The folder was left as it was so you can see what happened. Delete it to start over.") }
                    else { t(es, "No se creó nada. Revisá el motivo abajo y volvé al formulario.", "Nothing was created. Check the reason below and go back to the form.") }.to_string() })))
            .when(running, |d| d.child(ui::progress_slice("np-prog", 260.)))
            .child(div().flex().flex_col().gap(px(6.)).children(st.iter().enumerate().map(|(i, s)| {
                let last = i + 1 == n && running;
                let failed = i + 1 == n && !running;
                appear(("np-st", i), 0, div().flex().items_center().gap(px(10.)).text_size(px(13.)).text_color(c(if last { TEXT } else { TEXT_2 }))
                    .child(if last { div().size(px(12.)).flex().items_center().justify_center().child(live_dot(("np-sd", i), BLUE_TEXT)).into_any_element() } else if failed { icon("x", 12., RED).into_any_element() } else { icon("check", 12., GREEN).into_any_element() })
                    .child(SharedString::from(s.clone())))
            })))
            .child(div().p(px(12.)).rounded(px(10.)).bg(c(0x070A12)).border_1().border_color(c(BORDER)).font_family(MONO_FONT).text_size(px(11.)).text_color(c(MUTED))
                .children(tail.into_iter().map(|l| div().truncate().child(l))))
            .into_any_element()
    }
}

impl Render for NewProject {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let es = self.es;
        if self.phase == Phase::Running { window.request_animation_frame(); }
        let k = { let x = (self.opened.elapsed().as_secs_f32() / 0.22).clamp(0.0, 1.0); 1.0 - (1.0 - x).powi(3) };
        if k < 1.0 { window.request_animation_frame(); }
        let body = match self.phase { Phase::Choose => self.choose(cx), Phase::Form => self.form(cx), _ => self.progress(cx) };
        let footer = match self.phase {
            Phase::Form => Some(div().flex().items_center().gap(px(10.)).px(px(24.)).py(px(14.)).border_t_1().border_color(c(BORDER))
                .child(div().flex_1().min_w(px(0.)).children(self.error.clone().map(|e| div().flex().items_center().gap(px(8.)).text_size(px(12.)).text_color(c(0xFECACA)).child(icon("alert", 13., RED)).child(div().truncate().child(SharedString::from(e))))))
                .child(button("np-cancel", t(es, "Cancelar", "Cancel"), Kind::Ghost, cx.listener(|_, _, _, cx| cx.emit(Closed))))
                .child(button("np-go", t(es, "Crear proyecto", "Create project"), Kind::Primary, cx.listener(|this, _, _, cx| this.create(cx)))
                    .when(self.stack.is_none() || !self.blocked().is_empty() || self.describing, |b| b.opacity(0.5)))),
            Phase::Failed => Some(div().flex().items_center().gap(px(10.)).px(px(24.)).py(px(14.)).border_t_1().border_color(c(BORDER)).child(div().flex_1())
                .child(button("np-close", t(es, "Cerrar", "Close"), Kind::Ghost, cx.listener(|_, _, _, cx| cx.emit(Closed))))
                .child(button("np-retry", t(es, "Volver al formulario", "Back to the form"), Kind::Primary, cx.listener(|this, _, _, cx| { this.phase = Phase::Form; cx.notify(); })))),
            _ => None,
        };
        let wide = self.phase != Phase::Choose;
        div().absolute().inset_0().flex().items_center().justify_center().bg(gpui::rgba(0x05070Cb0)).opacity(k)
            .child(div().id("np-scrim").absolute().inset_0().when(self.phase != Phase::Running, |d| d.on_click(cx.listener(|_, _, _, cx| cx.emit(Closed)))))
            .child(div().id("np-panel").relative().w(px(if wide { 760. } else { 640. })).max_h(relative(0.88)).mt(px((1.0 - k) * 14.0))
                .rounded(px(14.)).border_1().border_color(c(BORDER_2)).bg(c(PANEL)).shadow_lg().overflow_hidden().flex().flex_col()
                .on_click(|_, _, cx| cx.stop_propagation())
                .child(div().id("np-scroll").flex_1().min_h(px(0.)).overflow_y_scroll().child(body))
                .children(footer)
                .when(self.phase != Phase::Running, |d| d.child(div().absolute().top(px(12.)).right(px(12.)).child(ui::icon_button("np-x", "x", cx.listener(|_, _, _, cx| cx.emit(Closed)))))))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slug_like_the_cli() {
        assert_eq!(slug("Facturación Ñandú"), "facturacion-nandu");
        assert_eq!(slug("  Plataforma de Pagos!! "), "plataforma-de-pagos");
        assert_eq!(slug("¿?"), "proyecto");
    }

    #[test]
    fn progress_steps_with_and_without_unicode() {
        let lines: Vec<String> = ["T  orqen bootstrap v0.1.0", "|", "o  Requirements -+", "*  Project skeleton (2 files)", "◇  Environment ─────╮", "│  ✔ git", "◆  Initial commit created on main", "oops"].iter().map(|s| s.to_string()).collect();
        assert_eq!(steps(&lines), vec!["Requirements", "Project skeleton (2 files)", "Environment", "Initial commit created on main"]);
    }

    #[test]
    fn console_hides_the_logo_and_borders() {
        assert!(!console_line("   ▄▄████▄▄     ██████╗"));
        assert!(!console_line("  // From request to production.  Orchestrate autonomous development."));
        assert!(!console_line("|  "));
        assert!(console_line("—  Port: A port is a number between 1 and 65535"));
    }
}
