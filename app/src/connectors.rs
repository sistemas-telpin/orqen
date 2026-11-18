//! Settings → Connectors → Configure: edit where the tickets live and the credentials in orqen/.env, visually.
//! The CLI does the work: `orqen connectors get --json` (current values, tokens masked),
//! `orqen connectors check -` (tests the draft without saving) and `orqen connectors set -` (saves it).
use gpui::{AnyElement, Context, Entity, EventEmitter, FontWeight, IntoElement, Render, ScrollHandle, SharedString, Window, div, prelude::*, px, relative};
use serde_json::{Map, Value, json};

use crate::cli::Cli;
use crate::input::TextInput;
use crate::theme::*;
use crate::ui::{self, Kind, button, chip, dot, icon, skeleton, skeleton_text};

/// The connectors were saved (the project reloads them).
pub struct Saved;
/// The person left the editor without saving.
pub struct Closed;

#[derive(Clone, Copy, PartialEq)]
enum Role { Ext, Int }

enum Load<T> { Loading, Ready(T), Failed(String) }

#[derive(Default)]
struct ConnectorChoices {
    key: String,
    state: Option<Load<Vec<Value>>>,
}

pub struct ConnectorsEditor {
    cli: Cli,
    es: bool,
    /// `orqen connectors get --json`: { conectores, env, secrets }
    current: Load<Value>,
    ext: &'static str,
    int: &'static str,
    /// Internal ticket in Jira with its own account (JIRA_INTERNAL_*) instead of the external one's.
    int_own_account: bool,
    deploy: [&'static str; 2],
    inputs: Vec<(&'static str, Entity<TextInput>)>,
    checking: bool,
    /// Result of the last test, per role.
    results: Option<Vec<Value>>,
    saving: bool,
    error: Option<String>,
    scroll: ScrollHandle,
    /// Opened from "Add" on the internal ticket: show that section.
    focus_internal: bool,
    choices: [ConnectorChoices; 4],
}

impl EventEmitter<Saved> for ConnectorsEditor {}
impl EventEmitter<Closed> for ConnectorsEditor {}

fn t(es: bool, a: &'static str, b: &'static str) -> &'static str { if es { a } else { b } }
fn s(v: &Value, k: &str) -> String {
    match v.get(k) { Some(Value::String(x)) => x.clone(), Some(Value::Number(n)) => n.to_string(), Some(Value::Array(a)) => a.iter().filter_map(|x| x.as_str()).collect::<Vec<_>>().join(", "), _ => String::new() }
}

/// (id, label es, label en, placeholder, hint es, hint en, secret)
const FIELDS: &[(&str, &str, &str, &str, &str, &str, bool)] = &[
    ("jira.url", "URL de Jira", "Jira URL", "https://tu-empresa.atlassian.net", "", "", false),
    ("jira.user", "Cuenta que comenta y crea tickets", "Account that comments and creates tickets", "bot@tu-empresa.com", "Conviene una cuenta de servicio (bot).", "A service (bot) account is best.", false),
    ("jira.token", "API token", "API token", "", "", "", true),
    ("jirai.url", "URL de Jira del equipo", "Team Jira URL", "https://tu-empresa.atlassian.net", "", "", false),
    ("jirai.user", "Cuenta del equipo", "Team account", "bot@tu-empresa.com", "", "", false),
    ("jirai.token", "API token del equipo", "Team API token", "", "", "", true),
    ("ext.jira.project", "Proyecto donde entran los pedidos", "Project where requests arrive", "SOP", "La clave del proyecto (SOP, SUP…).", "The project key (SOP, SUP…).", false),
    ("ext.jira.filter", "Qué pedidos toma orqen (JQL)", "Which requests orqen takes (JQL)", "project = SOP AND labels = orqen AND statusCategory != Done", "Vacío: los del proyecto con la etiqueta orqen.", "Empty: the project's issues labeled orqen.", false),
    ("int.jira.project", "Proyecto del equipo", "Team project", "DEV", "Ahí se crea el ticket de desarrollo al cerrar el análisis.", "The development ticket is created there when analysis closes.", false),
    ("int.jira.type", "Tipo de ticket", "Issue type", "Task", "", "", false),
    ("ext.github.repo", "Repositorio (dueño/nombre)", "Repository (owner/name)", "mi-org/soporte", "", "", false),
    ("ext.github.project", "Número de GitHub Project (opcional)", "GitHub Project number (optional)", "7", "Para mover la tarjeta de columna según la etapa.", "To move the card between columns by stage.", false),
    ("ext.github.filter", "Qué issues toma orqen", "Which issues orqen takes", "is:open label:orqen", "Calificadores de búsqueda de GitHub.", "GitHub search qualifiers.", false),
    ("ext.github.token", "Token de GitHub", "GitHub token", "", "Vacío: usa tu sesión de `gh`.", "Empty: uses your `gh` session.", true),
    ("int.github.repo", "Repositorio del equipo (dueño/nombre)", "Team repository (owner/name)", "mi-org/mi-repo", "", "", false),
    ("int.github.project", "Número de GitHub Project (opcional)", "GitHub Project number (optional)", "7", "", "", false),
    ("int.github.labels", "Etiquetas de los issues que crea", "Labels of the issues it creates", "orqen", "Separadas por coma.", "Comma separated.", false),
    ("int.github.token", "Token de GitHub", "GitHub token", "", "Vacío: usa tu sesión de `gh`.", "Empty: uses your `gh` session.", true),
    ("ext.asana.project", "Id del proyecto de Asana", "Asana project id", "1204567890123456", "El número de la URL del proyecto.", "The number in the project URL.", false),
    ("ext.asana.tag", "Etiqueta de las tareas que toma orqen", "Tag of the tasks orqen takes", "orqen", "", "", false),
    ("ext.asana.token", "Token personal de Asana", "Asana personal access token", "", "", "", true),
    ("int.asana.project", "Id del proyecto de Asana del equipo", "Team Asana project id", "1204567890123456", "", "", false),
    ("int.asana.token", "Token personal de Asana", "Asana personal access token", "", "", "", true),
];

const KINDS: [(&str, &str); 3] = [("jira", "Jira"), ("github", "GitHub"), ("asana", "Asana")];

impl ConnectorsEditor {
    pub fn new(cli: Cli, es: bool, focus_internal: bool, cx: &mut Context<Self>) -> Self {
        let inputs = FIELDS.iter().map(|f| (f.0, cx.new(|cx| TextInput::new(cx, f.3, String::new(), f.6)))).collect();
        let mut this = Self { cli, es, current: Load::Loading, ext: "jira", int: "none", int_own_account: false, deploy: ["cloud", "cloud"], inputs, checking: false, results: None, saving: false, error: None, scroll: ScrollHandle::new(), focus_internal, choices: Default::default() };
        for id in ["ext.github.token", "int.github.token", "ext.github.repo", "int.github.repo"] {
            if let Some(input) = this.input(id) {
                cx.observe(&input, |this, _, cx| { this.results = None; this.refresh_choices(cx); cx.notify(); }).detach();
            }
        }
        this.load(cx);
        // the team's GitHub repository is usually this one: propose the `origin` remote
        let (repo, field) = (this.cli.repo.clone(), this.input("int.github.repo"));
        if let Some(field) = field {
            cx.spawn(async move |_, cx| {
                if let Some(o) = cx.background_executor().spawn(async move { crate::cli::github_origin(&repo) }).await {
                    field.update(cx, |f, cx| f.suggest(o, cx)).ok();
                }
            }).detach();
        }
        this
    }

    fn load(&mut self, cx: &mut Context<Self>) {
        let cli = self.cli.clone();
        cx.spawn(async move |this, cx| {
            let r = cx.background_executor().spawn(async move { cli.json(&["connectors", "get", "--json"]) }).await;
            this.update(cx, |this, cx| {
                match r { Ok(v) => { this.fill(&v, cx); this.current = Load::Ready(v); this.refresh_choices(cx); if this.focus_internal { this.scroll.scroll_to_bottom(); } } Err(e) => this.current = Load::Failed(e.to_string()) }
                cx.notify();
            }).ok();
        }).detach();
    }

    fn input(&self, id: &str) -> Option<Entity<TextInput>> { self.inputs.iter().find(|(i, _)| *i == id).map(|(_, e)| e.clone()) }
    fn val(&self, id: &str, cx: &Context<Self>) -> String { self.input(id).map(|e| e.read(cx).text().trim().to_string()).unwrap_or_default() }

    /// Debounce resource discovery, and ignore responses for a different account or parent selection.
    fn refresh_choices(&mut self, cx: &mut Context<Self>) {
        if !matches!(self.current, Load::Ready(_)) { return; }
        let draft = self.draft(cx);
        for (i, kind, role, yaml_role, editor_role) in [(0, self.ext, "external", "externo", Role::Ext), (2, self.int, "internal", "interno", Role::Int)] {
            let visible = kind == "github";
            let parent = "repositories";
            let connector = &draft["conectores"][yaml_role];
            for (offset, resource) in [(0, parent), (1, "projects")] {
                let index = i + offset;
                let ready = s(connector, "repo").contains('/');
                if kind == "none" || !visible || offset == 1 && !ready {
                    self.choices[index] = ConnectorChoices::default(); continue;
                }
                let key = json!([kind, draft["env"], self.prefix(editor_role, kind),
                    if offset == 1 { json!([connector["repo"], connector["duenio_proyecto"]]) } else { Value::Null }]).to_string();
                if self.choices[index].key == key { continue; }
                self.choices[index].key = key.clone();
                self.choices[index].state = Some(Load::Loading);
                let (cli, body) = (self.cli.clone(), draft.to_string());
                cx.spawn(async move |this, cx| {
                    cx.background_executor().timer(std::time::Duration::from_millis(500)).await;
                    if !this.update(cx, |this, _| this.choices[index].key == key).unwrap_or(false) { return; }
                    let result = cx.background_executor().spawn(async move { cli.json_stdin(&["connectors", "github-choices", "-", role, resource], &body) }).await;
                    this.update(cx, |this, cx| {
                        if this.choices[index].key != key { return; }
                        this.choices[index].state = Some(match result {
                            Ok(v) if v["ok"] == true => Load::Ready(v["items"].as_array().cloned().unwrap_or_default().into_iter().map(|item| if resource == "repositories" { json!({"value": item["repo"], "label": item["repo"]}) } else { json!({"value": s(&item, "number"), "label": format!("#{} {}", s(&item, "number"), s(&item, "title"))}) }).collect()),
                            Ok(v) => Load::Failed(s(&v, "detail")),
                            Err(e) => Load::Failed(e.to_string()),
                        });
                        cx.notify();
                    }).ok();
                }).detach();
            }
        }
    }

    fn set_input(&self, id: &str, value: String, cx: &mut Context<Self>) {
        if let Some(input) = self.input(id) { input.update(cx, |input, cx| input.set_text(value, cx)); }
    }

    fn choose_github(&mut self, role: Role, project: bool, option: Value, cx: &mut Context<Self>) {
        let kind = if role == Role::Ext { self.ext } else { self.int };
        let r = if role == Role::Ext { "ext" } else { "int" };
        let value = s(&option, "value");
        let draft = self.draft(cx);
        let y = &draft["conectores"][if role == Role::Ext { "externo" } else { "interno" }];
        let selected = if project { s(y, "proyecto") } else { s(y, "repo") };
        if value == selected { return; }
        if project { self.set_input(&format!("{r}.{kind}.project"), value, cx); }
        else {
            self.set_input(&format!("{r}.github.repo"), value.clone(), cx);
            self.set_input(&format!("{r}.{kind}.project"), String::new(), cx);
            if let Load::Ready(v) = &mut self.current {
                let y = &mut v["conectores"][if role == Role::Ext { "externo" } else { "interno" }];
                if y["tipo"].as_str() != Some(kind) { *y = json!({ "tipo": kind }); }
                if let Some(c) = y.as_object_mut() {
                    if kind == "github" { c.remove("duenio_proyecto"); }
                }
            }
        }
        self.results = None;
        self.refresh_choices(cx);
        cx.notify();
    }

    fn yaml(&self, role: Role) -> Value {
        let k = if role == Role::Ext { "externo" } else { "interno" };
        match &self.current { Load::Ready(v) => v["conectores"][k].clone(), _ => Value::Null }
    }

    /// orqen/.env prefix of each connector (JIRA, GITHUB, ASANA or its `credenciales`).
    fn prefix(&self, role: Role, kind: &str) -> String {
        let y = self.yaml(role);
        let saved = (s(&y, "tipo") == kind).then(|| s(&y, "credenciales")).filter(|c| !c.is_empty());
        if role == Role::Int && kind == "jira" && self.ext == "jira" {
            let ext = self.prefix(Role::Ext, "jira");
            return if self.int_own_account { saved.filter(|c| *c != ext).unwrap_or_else(|| "JIRA_INTERNAL".into()) } else { ext };
        }
        saved.unwrap_or_else(|| match kind { "jira" => "JIRA", "github" => "GITHUB", _ => "ASANA" }.into())
    }

    /// Puts the saved values in the fields; secrets only say they are saved.
    fn fill(&mut self, v: &Value, cx: &mut Context<Self>) {
        let ext = &v["conectores"]["externo"];
        let int = &v["conectores"]["interno"];
        let kind = |x: &Value| match x["tipo"].as_str() { Some("jira") => "jira", Some("github") => "github", Some("asana") => "asana", _ => "none" };
        if kind(ext) != "none" { self.ext = kind(ext); }
        self.int = kind(int);
        let ep = { let c = s(ext, "credenciales"); if c.is_empty() { "JIRA".to_string() } else { c } };
        self.int_own_account = self.ext == "jira" && self.int == "jira" && { let c = s(int, "credenciales"); !c.is_empty() && c != ep };
        let env = |k: String| v["env"][&k].as_str().unwrap_or("").to_string();
        let secret = |k: String| v["secrets"][&k].as_str().map(str::to_string);
        let mut set: Vec<(&str, String)> = vec![];
        let mut hints: Vec<(&str, String)> = vec![];
        let es = self.es;
        let saved_hint = |m: String| format!("{} {m} · {}", t(es, "Guardado", "Saved"), t(es, "vacío = mantener", "empty = keep"));
        // Jira credentials (external, and the internal one when it has its own account)
        for (role, url, user, token) in [(Role::Ext, "jira.url", "jira.user", "jira.token"), (Role::Int, "jirai.url", "jirai.user", "jirai.token")] {
            let y = if role == Role::Ext { ext } else { int };
            if kind(y) != "jira" && !(role == Role::Ext) { continue; }
            let p = if role == Role::Ext { ep.clone() } else { let c = s(int, "credenciales"); if c.is_empty() { "JIRA_INTERNAL".into() } else { c } };
            let u = { let x = s(y, "url"); if x.is_empty() { env(format!("{p}_URL")) } else { x } };
            set.push((url, u.clone()));
            set.push((user, env(format!("{p}_USER"))));
            if let Some(m) = secret(format!("{p}_TOKEN")) { hints.push((token, saved_hint(m))); }
            let d = env(format!("{p}_DEPLOYMENT"));
            self.deploy[if role == Role::Ext { 0 } else { 1 }] = if d == "server" || (d.is_empty() && !u.is_empty() && !u.contains("atlassian.net")) { "server" } else { "cloud" };
        }
        for (role, y) in [(Role::Ext, ext), (Role::Int, int)] {
            let r = if role == Role::Ext { "ext" } else { "int" };
            let p = { let c = s(y, "credenciales"); if !c.is_empty() { c } else { match kind(y) { "github" => "GITHUB".into(), _ => "ASANA".into() } } };
            match kind(y) {
                "jira" => {
                    set.push((if role == Role::Ext { "ext.jira.project" } else { "int.jira.project" }, { let x = s(y, "proyecto"); if x.is_empty() && role == Role::Ext { s(y, "filtro").split("project = ").nth(1).map(|x| x.split_whitespace().next().unwrap_or("").to_string()).unwrap_or_default() } else { x } }));
                    if role == Role::Ext { set.push(("ext.jira.filter", s(y, "filtro"))); } else { set.push(("int.jira.type", s(y, "tipo_ticket"))); }
                }
                "github" => {
                    let id = |f: &str| -> &'static str { FIELDS.iter().find(|x| x.0 == format!("{r}.github.{f}")).map(|x| x.0).unwrap_or("") };
                    set.push((id("repo"), s(y, "repo")));
                    set.push((id("project"), s(y, "proyecto")));
                    if role == Role::Ext { set.push(("ext.github.filter", s(y, "filtro"))); } else { set.push(("int.github.labels", s(y, "etiquetas"))); }
                    if let Some(m) = secret(format!("{p}_TOKEN")).or_else(|| secret("GH_TOKEN".into())) { hints.push((id("token"), saved_hint(m))); }
                }
                "asana" => {
                    let id = |f: &str| -> &'static str { FIELDS.iter().find(|x| x.0 == format!("{r}.asana.{f}")).map(|x| x.0).unwrap_or("") };
                    set.push((id("project"), s(y, "proyecto")));
                    if role == Role::Ext { set.push(("ext.asana.tag", s(y, "filtro"))); }
                    if let Some(m) = secret(format!("{p}_TOKEN")) { hints.push((id("token"), saved_hint(m))); }
                }
                _ => {}
            }
        }
        for (id, value) in set { if let Some(e) = self.input(id) { if !value.is_empty() { e.update(cx, |e, cx| e.set_text(value, cx)); } } }
        for (id, h) in hints { if let Some(e) = self.input(id) { e.update(cx, |e, cx| e.set_placeholder(h, cx)); } }
    }

    /// The draft for the CLI: {"conectores": {...}, "env": {...}}. Fields the editor does not show (transitions, prefixes…) are kept.
    fn draft(&self, cx: &Context<Self>) -> Value {
        let v = |id: &str| self.val(id, cx);
        let mut env = Map::new();
        let mut put = |k: String, x: String| { if !x.is_empty() { env.insert(k, Value::String(x)); } };
        let base = |role: Role, kind: &str| -> Map<String, Value> {
            let y = self.yaml(role);
            let mut m = if s(&y, "tipo") == kind { y.as_object().cloned().unwrap_or_default() } else { Map::new() };
            m.insert("tipo".into(), json!(kind));
            m
        };
        let opt = |m: &mut Map<String, Value>, k: &str, x: String| { if x.is_empty() { m.remove(k); } else { m.insert(k.into(), json!(x)); } };
        let num = |m: &mut Map<String, Value>, k: &str, x: String| { match x.parse::<u64>() { Ok(n) => { m.insert(k.into(), json!(n)); } Err(_) => { m.remove(k); } } };
        let jira_creds = |m: &mut Map<String, Value>, put: &mut dyn FnMut(String, String), p: &str, url: &str, user: &str, token: &str, deploy: &str| {
            let u = v(url).trim_end_matches('/').to_string();
            if m.get("url").and_then(|x| x.as_str()).map(|x| !x.is_empty()).unwrap_or(false) { m.insert("url".into(), json!(u)); } else { put(format!("{p}_URL"), u); }
            put(format!("{p}_USER"), v(user));
            put(format!("{p}_TOKEN"), v(token));
            put(format!("{p}_DEPLOYMENT"), deploy.to_string());
        };
        let mut ext = base(Role::Ext, self.ext);
        let ep = self.prefix(Role::Ext, self.ext);
        match self.ext {
            "jira" => {
                jira_creds(&mut ext, &mut put, &ep, "jira.url", "jira.user", "jira.token", self.deploy[0]);
                let key = v("ext.jira.project").to_uppercase();
                opt(&mut ext, "proyecto", key.clone());
                let f = v("ext.jira.filter");
                ext.insert("filtro".into(), json!(if !f.is_empty() { f } else if key.is_empty() { "labels = orqen AND statusCategory != Done".into() } else { format!("project = {key} AND labels = orqen AND statusCategory != Done") }));
            }
            "github" => {
                ext.insert("repo".into(), json!(v("ext.github.repo")));
                num(&mut ext, "proyecto", v("ext.github.project"));
                let f = v("ext.github.filter");
                ext.insert("filtro".into(), json!(if f.is_empty() { "is:open label:orqen".to_string() } else { f }));
                put(format!("{ep}_TOKEN"), v("ext.github.token"));
            }
            _ => {
                ext.insert("proyecto".into(), json!(v("ext.asana.project")));
                let f = v("ext.asana.tag");
                ext.insert("filtro".into(), json!(if f.is_empty() { "orqen".to_string() } else { f }));
                put(format!("{ep}_TOKEN"), v("ext.asana.token"));
            }
        }
        let int = if self.int == "none" { Value::Null } else {
            let mut m = base(Role::Int, self.int);
            let ip = self.prefix(Role::Int, self.int);
            match self.int {
                "jira" => {
                    if self.ext == "jira" && !self.int_own_account {
                        if ip == "JIRA" { m.remove("credenciales"); } else { m.insert("credenciales".into(), json!(ip)); }
                    } else {
                        if ip == "JIRA" { m.remove("credenciales"); } else { m.insert("credenciales".into(), json!(ip)); }
                        jira_creds(&mut m, &mut put, &ip, "jirai.url", "jirai.user", "jirai.token", self.deploy[1]);
                    }
                    m.insert("proyecto".into(), json!(v("int.jira.project").to_uppercase()));
                    let ty = v("int.jira.type");
                    m.insert("tipo_ticket".into(), json!(if ty.is_empty() { "Task".to_string() } else { ty }));
                    if !m.contains_key("vinculo") { m.insert("vinculo".into(), json!("Relates")); }
                }
                "github" => {
                    m.insert("repo".into(), json!(v("int.github.repo")));
                    num(&mut m, "proyecto", v("int.github.project"));
                    let labels: Vec<String> = v("int.github.labels").split(',').map(|x| x.trim().to_string()).filter(|x| !x.is_empty()).collect();
                    m.insert("etiquetas".into(), json!(if labels.is_empty() { vec!["orqen".to_string()] } else { labels }));
                    if !(self.ext == "github" && ip == ep) { put(format!("{ip}_TOKEN"), v("int.github.token")); }
                }
                _ => {
                    m.insert("proyecto".into(), json!(v("int.asana.project")));
                    if !(self.ext == "asana" && ip == ep) { put(format!("{ip}_TOKEN"), v("int.asana.token")); }
                }
            }
            Value::Object(m)
        };
        json!({ "conectores": { "externo": Value::Object(ext), "interno": int }, "env": env })
    }

    /// What is clearly missing, before asking the tool.
    fn missing(&self, cx: &Context<Self>) -> Option<String> {
        let es = self.es;
        let v = |id: &str| self.val(id, cx);
        let repo_ok = |x: &str| { let p: Vec<&str> = x.split('/').collect(); p.len() == 2 && p.iter().all(|y| !y.is_empty()) };
        let no_url = |id: &str| { let u = v(id); !(u.starts_with("http://") || u.starts_with("https://")) };
        match self.ext {
            "jira" if no_url("jira.url") => return Some(t(es, "Elegí el sitio de Jira donde están los pedidos.", "Choose the Jira site for requests.").into()),
            "github" if !repo_ok(&v("ext.github.repo")) => return Some(t(es, "Elegí el repositorio donde están los pedidos.", "Choose the repository for requests.").into()),
            "asana" if v("ext.asana.project").parse::<u64>().is_err() => return Some(t(es, "Elegí el proyecto de Asana.", "Choose an Asana project.").into()),
            _ => {}
        }
        match self.int {
            "jira" if v("int.jira.project").is_empty() => Some(t(es, "Falta el proyecto de Jira del equipo.", "The team's Jira project is missing.").into()),
            "jira" if self.ext != "jira" || self.int_own_account && no_url("jirai.url") => Some(t(es, "Falta la URL del Jira del equipo.", "The team's Jira URL is missing.").into()),
            "github" if !repo_ok(&v("int.github.repo")) => Some(t(es, "El repositorio del equipo va como dueño/nombre.", "The team repository goes as owner/name.").into()),
            "asana" if v("int.asana.project").parse::<u64>().is_err() => Some(t(es, "El id del proyecto de Asana del equipo es un número.", "The team's Asana project id is a number.").into()),
            _ => None,
        }
    }

    fn test(&mut self, cx: &mut Context<Self>) {
        if self.checking || self.saving { return; }
        if let Some(m) = self.missing(cx) { self.error = Some(m); cx.notify(); return; }
        self.error = None;
        self.checking = true;
        self.results = None;
        let (cli, body) = (self.cli.clone(), self.draft(cx).to_string());
        cx.spawn(async move |this, cx| {
            let r = cx.background_executor().spawn(async move { cli.json_stdin(&["connectors", "check", "-"], &body) }).await;
            this.update(cx, |this, cx| {
                this.checking = false;
                match r { Ok(v) => this.results = v["connectors"].as_array().cloned(), Err(e) => this.error = Some(e.to_string()) }
                cx.notify();
            }).ok();
        }).detach();
        cx.notify();
    }

    fn save(&mut self, cx: &mut Context<Self>) {
        if self.checking || self.saving { return; }
        if let Some(m) = self.missing(cx) { self.error = Some(m); cx.notify(); return; }
        self.error = None;
        self.saving = true;
        let (cli, body) = (self.cli.clone(), self.draft(cx).to_string());
        cx.spawn(async move |this, cx| {
            let r = cx.background_executor().spawn(async move { cli.run_stdin(&["connectors", "set", "-"], &body) }).await;
            this.update(cx, |this, cx| {
                this.saving = false;
                match r {
                    Ok(o) if o.ok => cx.emit(Saved),
                    Ok(o) => this.error = Some(crate::cli::first_line(&crate::cli::strip_ansi(if o.stderr.trim().is_empty() { &o.stdout } else { &o.stderr }))),
                    Err(e) => this.error = Some(e.to_string()),
                }
                cx.notify();
            }).ok();
        }).detach();
        cx.notify();
    }

    // ================================================================ view

    fn field(&self, id: &str) -> Option<AnyElement> {
        let es = self.es;
        let f = FIELDS.iter().find(|f| f.0 == id)?;
        let hint = if es { f.4 } else { f.5 };
        Some(div().flex().flex_col().gap(px(5.))
            .child(div().flex().items_center().gap(px(6.)).text_size(px(11.5)).text_color(c(MUTED)).child(if es { f.1 } else { f.2 })
                .when(f.6, |d| d.child(icon("lock", 10., DIM))))
            .child(self.input(id)?)
            .when(!hint.is_empty(), |d| d.child(div().text_size(px(11.)).text_color(c(DIM)).child(hint)))
            .into_any_element())
    }

    fn row(&self, ids: &[&str]) -> AnyElement {
        div().flex().gap(px(12.)).children(ids.iter().filter_map(|id| self.field(id).map(|f| div().flex_1().min_w(px(0.)).child(f)))).into_any_element()
    }

    fn github_fields(&self, role: Role, cx: &mut Context<Self>) -> AnyElement {
        let external = role == Role::Ext;
        let index = if external { 0 } else { 2 };
        let y = &self.draft(cx)["conectores"][if external { "externo" } else { "interno" }];
        let parent = s(y, "repo");
        let selected_project = s(y, "proyecto");
        div().flex().flex_wrap().gap(px(12.)).children([false, true].into_iter().map(|project| {
            let offset = if project { 1 } else { 0 };
            let search_id = match (external, project) { (true, false) => "ext.github.repo", (false, false) => "int.github.repo", (true, true) => "ext.github.project", _ => "int.github.project" };
            let filter = self.val(search_id, cx).to_lowercase();
            let selected = if project { &selected_project } else { &parent };
            let title = if project { t(self.es, "GitHub Project (opcional)", "GitHub Project (optional)") } else { t(self.es, "Repositorios accesibles", "Accessible repositories") };
            let mut body: Vec<AnyElement> = vec![];
            match &self.choices[index + offset].state {
                Some(Load::Loading) => body.push(ui::busy(("choices-loading", index + offset), t(self.es, "Buscando opciones...", "Finding choices...")).into_any_element()),
                Some(Load::Failed(e)) => {
                    body.push(div().text_color(c(RED)).child(e.clone()).into_any_element());
                    body.push(button(("choices-retry", index + offset), t(self.es, "Reintentar", "Retry"), Kind::Ghost, cx.listener(move |this, _, _, cx| { this.choices[index + offset].key.clear(); this.refresh_choices(cx); cx.notify(); })).into_any_element());
                }
                Some(Load::Ready(items)) => {
                    let label = items.iter().find(|item| s(item, "value") == *selected).map(|item| s(item, "label"));
                    if label.is_none() && !selected.is_empty() { body.push(div().text_color(c(MUTED)).child(t(self.es, "La selección guardada no aparece en esta cuenta. Elegí una opción de la lista.", "The saved selection is not visible to this account. Choose an option from the list.")).into_any_element()); }
                    let mut options: Vec<Value> = items.iter().filter(|item| project || s(item, "value") == *selected || s(item, "label").to_lowercase().contains(&filter)).cloned().collect();
                    if options.is_empty() { body.push(div().text_color(c(MUTED)).child(t(self.es, "No hay opciones disponibles para esta cuenta o búsqueda.", "No choices available for this account or search.")).into_any_element()); }
                    if project { options.insert(0, json!({ "value": "", "label": t(self.es, "Sin tablero", "No board") })); }
                    body.push(div().id(("resource-list", index + offset)).max_h(px(160.)).overflow_y_scroll().flex().flex_col().gap(px(2.))
                        .children(options.into_iter().enumerate().map(|(n, option)| {
                            let on = s(&option, "value") == *selected;
                            div().id(("resource-choice", (index + offset) * 100000 + n)).px(px(8.)).py(px(7.)).rounded(px(6.)).cursor_pointer().text_color(c(if on { TEXT } else { MUTED }))
                                .when(on, |d| d.bg(c(SURFACE_2))).hover(|d| d.bg(c(HOVER))).child(s(&option, "label"))
                                .on_click(cx.listener(move |this, _, _, cx| this.choose_github(role, project, option.clone(), cx)))
                        })).into_any_element());
                }
                None => {
                    body.push(div().text_color(c(MUTED)).child(t(self.es, "Elegí primero un repositorio.", "Choose a repository first.")).into_any_element());
                }
            }
            div().flex_1().min_w(px(180.)).flex().flex_col().gap(px(8.)).text_size(px(12.))
                .child(div().text_color(c(TEXT_2)).font_weight(FontWeight::SEMIBOLD).child(title)).children(self.input(search_id)).children(body)
        })).into_any_element()
    }

    fn kinds(&self, role: Role, cx: &mut Context<Self>) -> impl IntoElement {
        let es = self.es;
        let current = if role == Role::Ext { self.ext } else { self.int };
        let mut opts: Vec<(&'static str, &'static str)> = vec![];
        if role == Role::Int { opts.push(("none", t(es, "Ninguno", "None"))); }
        opts.extend(KINDS);
        let accent = if role == Role::Ext { BLUE } else { MAGENTA };
        div().flex().gap(px(6.)).children(opts.into_iter().enumerate().map(|(i, (key, label))| {
            let on = key == current;
            div().id((if role == Role::Ext { "ek" } else { "ik" }, i)).flex_1().h(px(34.)).flex().items_center().justify_center().rounded(px(9.)).cursor_pointer().text_size(px(12.5))
                .when(on, |d| d.border_1().border_color(c(accent)).bg(c(SURFACE_2)).text_color(c(TEXT)).font_weight(FontWeight::SEMIBOLD))
                .when(!on, |d| d.border_1().border_color(c(0x1E2638)).text_color(c(TEXT_2)).hover(|h| h.bg(c(HOVER))))
                .child(label)
                .on_click(cx.listener(move |this, _, _, cx| { if role == Role::Ext { this.ext = key } else { this.int = key }; this.results = None; this.error = None; this.refresh_choices(cx); cx.notify(); }))
        }))
    }

    fn deploy_choice(&self, i: usize, cx: &mut Context<Self>) -> impl IntoElement {
        let es = self.es;
        div().flex().flex_col().gap(px(5.)).child(div().text_size(px(11.5)).text_color(c(MUTED)).child(t(es, "Tipo de instalación", "Deployment")))
            .child(div().flex().gap(px(6.)).children([("cloud", "Cloud"), ("server", "Server / Data Center")].into_iter().enumerate().map(|(j, (key, label))| {
                let on = self.deploy[i] == key;
                div().id(("dep", i * 10 + j)).h(px(34.)).px(px(12.)).flex().items_center().rounded(px(8.)).cursor_pointer().text_size(px(12.))
                    .when(on, |d| d.border_1().border_color(c(0x2E4A9A)).bg(c(SURFACE_2)).text_color(c(TEXT)))
                    .when(!on, |d| d.border_1().border_color(c(0x1E2638)).text_color(c(TEXT_2)).hover(|h| h.bg(c(HOVER))))
                    .child(label)
                    .on_click(cx.listener(move |this, _, _, cx| { this.deploy[i] = key; cx.notify(); }))
            })))
    }

    fn toggle(&self, on: bool, title: &'static str, body: &'static str, cx: &mut Context<Self>) -> impl IntoElement {
        div().id("own-account").flex().items_start().gap(px(12.)).p(px(12.)).rounded(px(10.)).border_1().border_color(c(if on { 0x23345F } else { 0x1E2638 })).cursor_pointer()
            .hover(|h| h.bg(c(HOVER)))
            .child(div().mt(px(1.)).size(px(18.)).flex_none().rounded(px(5.)).flex().items_center().justify_center()
                .when(on, |d| d.bg(c(BLUE))).when(!on, |d| d.border_1().border_color(c(BORDER_2)))
                .children(on.then(|| icon("check", 12., 0xFFFFFF))))
            .child(div().flex_1().flex().flex_col().gap(px(2.)).child(div().text_size(px(13.)).text_color(c(TEXT)).child(title)).child(div().text_size(px(12.)).text_color(c(MUTED)).child(body)))
            .on_click(cx.listener(|this, _, _, cx| { this.int_own_account = !this.int_own_account; this.results = None; cx.notify(); }))
    }

    /// Result of the last test for this role.
    fn result(&self, role: Role) -> Option<AnyElement> {
        let es = self.es;
        let key = if role == Role::Ext { "external" } else { "internal" };
        if self.checking { return Some(div().pt(px(2.)).child(ui::progress_slice(if role == Role::Ext { "chk-e" } else { "chk-i" }, 140.)).into_any_element()); }
        let r = self.results.as_ref()?.iter().find(|x| x["role"].as_str() == Some(key))?;
        if r["configured"].as_bool() != Some(true) { return None; }
        let ok = r["ok"].as_bool() == Some(true);
        Some(div().flex().items_start().gap(px(8.)).p(px(10.)).rounded(px(9.)).bg(c(if ok { 0x0C1F18 } else { 0x1F0F14 }))
            .child(icon(if ok { "check" } else { "alert" }, 13., if ok { GREEN } else { RED }))
            .child(div().flex_1().min_w(px(0.)).flex().flex_col().gap(px(2.))
                .child(div().text_size(px(12.)).font_weight(FontWeight::SEMIBOLD).text_color(c(if ok { 0xA7F3D0 } else { 0xFECACA })).child(if ok { t(es, "Accesible", "Reachable") } else { t(es, "No se pudo conectar", "Could not connect") }))
                .child(div().text_size(px(12.)).text_color(c(if ok { 0xA7F3D0 } else { 0xFECACA })).child(s(r, "detail"))))
            .into_any_element())
    }

    fn section(&self, role: Role, cx: &mut Context<Self>) -> AnyElement {
        let es = self.es;
        let ext = role == Role::Ext;
        let kind = if ext { self.ext } else { self.int };
        let mut body: Vec<AnyElement> = vec![];
        match (role, kind) {
            (Role::Ext, "jira") => {
                body.push(self.row(&["jira.url"]));
                body.push(self.deploy_choice(0, cx).into_any_element());
                body.push(self.row(&["jira.user", "jira.token"]));
                body.push(self.row(&["ext.jira.project"]));
                body.push(self.row(&["ext.jira.filter"]));
            }
            (Role::Ext, "github") => { body.push(self.row(&["ext.github.token"])); body.push(self.github_fields(role, cx)); body.push(self.row(&["ext.github.filter"])); }
            (Role::Ext, _) => { body.push(self.row(&["ext.asana.project", "ext.asana.tag"])); body.push(self.row(&["ext.asana.token"])); }
            (Role::Int, "jira") => {
                if self.ext == "jira" {
                    body.push(self.toggle(self.int_own_account, t(es, "Otro Jira u otra cuenta", "Another Jira or account"), t(es, "Por defecto usa el mismo Jira y la misma cuenta que los requerimientos.", "By default it uses the same Jira and account as requirements."), cx).into_any_element());
                }
                if self.ext != "jira" || self.int_own_account {
                    body.push(self.row(&["jirai.url"]));
                    body.push(self.deploy_choice(1, cx).into_any_element());
                    body.push(self.row(&["jirai.user", "jirai.token"]));
                }
                body.push(self.row(&["int.jira.project", "int.jira.type"]));
            }
            (Role::Int, "github") => {
                if self.ext != "github" { body.push(self.row(&["int.github.token"])); }
                body.push(self.github_fields(role, cx));
                body.push(self.row(&["int.github.labels"]));
            }
            (Role::Int, "asana") => {
                body.push(self.row(&["int.asana.project"]));
                if self.ext != "asana" { body.push(self.row(&["int.asana.token"])); }
            }
            _ => body.push(div().p(px(12.)).rounded(px(10.)).border_1().border_dashed().border_color(c(BORDER_2)).text_size(px(12.5)).text_color(c(MUTED))
                .child(t(es, "Sin tickets separados: el desarrollo se sigue en el requerimiento.", "Without separate tickets, development is tracked in the requirement.")).into_any_element()),
        }
        ui::card().flex_1().min_w(px(420.)).flex().flex_col().overflow_hidden()
            .child(div().p(px(16.)).flex().flex_col().gap(px(4.)).border_b_1().border_color(c(0x161D2D))
                .child(div().flex().items_center().gap(px(8.)).child(dot(if ext { BLUE } else { MAGENTA }))
                    .child(div().text_size(px(14.)).font_weight(FontWeight::SEMIBOLD).text_color(c(TEXT)).child(if ext { t(es, "Requerimientos", "Requirements") } else { t(es, "Tickets", "Tickets") }))
                    .child(div().flex_1())
                    .when(!ext, |d| d.child(chip(t(es, "opcional", "optional"), BORDER_2, MUTED))))
                .child(div().text_size(px(12.)).text_color(c(MUTED)).child(if ext { t(es, "Lo que ve el cliente: ahí entra el pedido, se le responde y aprueba.", "What the client sees: the request arrives there, gets answered and approved.") } else { t(es, "Trabajo de desarrollo: se crea al cerrar el análisis.", "Development work: created when analysis closes.") })))
            .child(div().p(px(16.)).flex().flex_col().gap(px(14.))
                .child(self.kinds(role, cx))
                .children(body)
                .children(self.result(role)))
            .into_any_element()
    }

    fn skeleton_form(&self) -> AnyElement {
        let card = |n: usize| ui::card().flex_1().min_w(px(420.)).flex().flex_col().overflow_hidden()
            .child(div().p(px(16.)).flex().flex_col().gap(px(4.)).border_b_1().border_color(c(0x161D2D))
                .child(div().h(px(22.6)).flex().items_center().gap(px(8.)).child(skeleton(("ce-d", n), px(7.), 7.)).child(skeleton(("ce-t", n), px(110.), 10.)))
                .child(skeleton_text(("ce-s", n), relative(0.6), 12.)))
            .child(div().p(px(16.)).flex().flex_col().gap(px(14.))
                .child(skeleton(("ce-k", n), relative(1.), 34.))
                .children((0..3).map(|i| div().flex().gap(px(12.)).children((0..2).map(|j| div().flex_1().flex().flex_col().gap(px(5.))
                    .child(skeleton_text(("ce-l", n * 100 + i * 10 + j), px(120.), 11.5)).child(skeleton(("ce-i", n * 100 + i * 10 + j), relative(1.), 34.)))))));
        div().flex().flex_wrap().items_start().gap(px(16.)).child(card(0)).child(card(1)).into_any_element()
    }
}

impl Render for ConnectorsEditor {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let es = self.es;
        let busy = self.checking || self.saving;
        let header = div().pl(px(22.)).pr(px(56.)).py(px(16.)).flex().items_center().gap(px(10.)).border_b_1().border_color(c(BORDER))
            .child(div().id("conn-back").size(px(26.)).rounded(px(7.)).flex().items_center().justify_center().cursor_pointer().hover(|h| h.bg(c(0x161D2D)))
                .child(div().text_size(px(15.)).text_color(c(MUTED)).child("‹"))
                .on_click(cx.listener(|_, _, _, cx| cx.emit(Closed))))
            .child(ui::h1(t(es, "Configurar conectores", "Set up connectors")))
            .child(div().flex_1())
            .children(self.saving.then(|| ui::busy("conn-saving", t(es, "Guardando…", "Saving…"))))
            .child(button("conn-cancel", t(es, "Cancelar", "Cancel"), Kind::Ghost, cx.listener(|_, _, _, cx| cx.emit(Closed))))
            .child(button("conn-try", if self.checking { t(es, "Probando…", "Testing…") } else { t(es, "Probar", "Test") }, Kind::Accent, cx.listener(|this, _, _, cx| this.test(cx))).when(busy, |b| b.opacity(0.6)))
            .child(button("conn-save", t(es, "Guardar", "Save"), Kind::Primary, cx.listener(|this, _, _, cx| this.save(cx))).when(busy, |b| b.opacity(0.6)));
        let body: AnyElement = match &self.current {
            Load::Loading => self.skeleton_form(),
            Load::Failed(e) => ui::empty(t(es, "No se pudieron leer los conectores", "Could not read the connectors"), e.clone()).into_any_element(),
            Load::Ready(v) => {
                let legacy = v["legacy"].as_array().map(|a| !a.is_empty()).unwrap_or(false);
                div().flex().flex_col().gap(px(16.))
                    .child(div().max_w(px(720.)).text_size(px(12.5)).text_color(c(TEXT_2)).child(t(es,
                        "Dónde viven los requerimientos y tickets, y con qué cuenta entra orqen. Los tokens se guardan en orqen/.env (Git lo ignora) y nunca se muestran completos. «Probar» verifica la conexión sin guardar.",
                        "Where the tickets live and which account orqen uses. Tokens go to orqen/.env (ignored by Git) and are never shown in full. «Test» checks the connection without saving.")))
                    .when(legacy, |d| d.child(div().max_w(px(720.)).p(px(12.)).rounded(px(10.)).bg(c(0x1D1810)).border_1().border_color(c(0x4A3A1C)).text_size(px(12.)).text_color(c(0xF5C77A))
                        .child(t(es, "Tenés una configuración anterior. Al guardar se actualizará automáticamente.", "You have an older configuration. Saving updates it automatically."))))
                    .children(self.error.clone().map(|e| div().max_w(px(720.)).flex().items_start().gap(px(8.)).p(px(10.)).rounded(px(9.)).bg(c(0x1F0F14))
                        .child(icon("alert", 13., RED)).child(div().flex_1().text_size(px(12.)).text_color(c(0xFECACA)).child(SharedString::from(e)))))
                    // external and internal side by side; when the window is narrow the second one wraps below
                    .child(div().flex().flex_wrap().items_start().gap(px(16.))
                        .child(self.section(Role::Ext, cx))
                        .child(self.section(Role::Int, cx)))
                    .into_any_element()
            }
        };
        div().size_full().flex().flex_col().child(header)
            .child(div().id("conn-edit-scroll").flex_1().min_h(px(0.)).overflow_y_scroll().track_scroll(&self.scroll).p(px(22.)).child(body))
    }
}
