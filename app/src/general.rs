//! General project settings. Naming is shared by all providers.
use gpui::{Context, Entity, EventEmitter, IntoElement, Render, Window, div, prelude::*, px};
use serde_json::json;

use crate::cli::Cli;
use crate::connectors::Saved;
use crate::input::TextInput;
use crate::theme::*;
use crate::ui::{self, Kind, button};

pub struct GeneralSettings {
    cli: Cli,
    es: bool,
    requirements: Entity<TextInput>,
    tickets: Entity<TextInput>,
    loading: bool,
    saving: bool,
    has_history: bool,
    error: Option<String>,
    saved: Option<(String, String)>,
}

impl EventEmitter<Saved> for GeneralSettings {}
fn t(es: bool, a: &'static str, b: &'static str) -> &'static str { if es { a } else { b } }

impl GeneralSettings {
    pub fn new(cli: Cli, es: bool, cx: &mut Context<Self>) -> Self {
        let mut this = Self {
            cli, es, requirements: cx.new(|cx| TextInput::new(cx, "REQ", "", false)),
            tickets: cx.new(|cx| TextInput::new(cx, "ISS", "", false)),
            loading: true, saving: false, has_history: false, error: None, saved: None,
        };
        for input in [&this.requirements, &this.tickets] {
            cx.observe(input, |_, _, cx| cx.notify()).detach();
        }
        this.load(cx);
        this
    }

    fn load(&mut self, cx: &mut Context<Self>) {
        self.loading = true;
        self.error = None;
        let cli = self.cli.clone();
        cx.spawn(async move |this, cx| {
            let result = cx.background_executor().spawn(async move { cli.json(&["connectors", "general-get"]) }).await;
            this.update(cx, |this, cx| {
                this.loading = false;
                match result {
                    Ok(v) => {
                        this.has_history = v["hasHistory"].as_bool().unwrap_or(false);
                        this.requirements.update(cx, |input, cx| input.set_text(v["general"]["prefijos"]["requests"].as_str().unwrap_or("REQ").to_string(), cx));
                        this.tickets.update(cx, |input, cx| input.set_text(v["general"]["prefijos"]["issues"].as_str().unwrap_or("ISS").to_string(), cx));
                    }
                    Err(e) => this.error = Some(e.to_string()),
                }
                cx.notify();
            }).ok();
        }).detach();
    }

    fn save(&mut self, cx: &mut Context<Self>) {
        if self.loading || self.saving { return; }
        let body = json!({ "prefijos": {
            "requests": self.requirements.read(cx).text().trim(),
            "issues": self.tickets.read(cx).text().trim(),
        } }).to_string();
        self.saving = true;
        self.saved = None;
        self.error = None;
        let cli = self.cli.clone();
        cx.spawn(async move |this, cx| {
            let result = cx.background_executor().spawn(async move { cli.json_stdin(&["connectors", "general-set", "-"], &body) }).await;
            this.update(cx, |this, cx| {
                this.saving = false;
                match result {
                    Ok(v) => {
                        this.requirements.update(cx, |input, cx| input.set_text(v["general"]["prefijos"]["requests"].as_str().unwrap_or("").to_string(), cx));
                        this.tickets.update(cx, |input, cx| input.set_text(v["general"]["prefijos"]["issues"].as_str().unwrap_or("").to_string(), cx));
                        this.saved = Some((this.requirements.read(cx).text(), this.tickets.read(cx).text()));
                        cx.emit(Saved);
                    }
                    Err(e) => this.error = Some(e.to_string()),
                }
                cx.notify();
            }).ok();
        }).detach();
        cx.notify();
    }
}

impl Render for GeneralSettings {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let es = self.es;
        let saved = self.saved.as_ref().map(|(requirements, tickets)| *requirements == self.requirements.read(cx).text() && *tickets == self.tickets.read(cx).text()).unwrap_or(false);
        div().size_full().flex().flex_col()
            .child(div().pl(px(22.)).pr(px(56.)).py(px(16.)).flex().items_center().gap(px(10.)).border_b_1().border_color(c(BORDER))
                .child(ui::h1("General")).child(div().flex_1())
                .child(button("general-save", if self.saving { t(es, "Guardando...", "Saving...") } else { t(es, "Guardar", "Save") }, Kind::Primary, cx.listener(|this, _, _, cx| this.save(cx)))))
            .child(div().id("general-body").flex_1().overflow_y_scroll().p(px(22.)).flex().flex_col().gap(px(18.))
                .child(div().max_w(px(640.)).text_size(px(12.5)).text_color(c(TEXT_2)).child(t(es, "Definí cómo se identifican los requests del cliente y los issues de desarrollo. Estos prefijos se usan con cualquier proveedor.", "Choose how customer requests and development issues are identified. These prefixes work with any provider.")))
                .when(self.loading, |d| d.child(ui::busy("general-loading", t(es, "Cargando configuración...", "Loading settings..."))))
                .when(!self.loading, |d| d.children([
                    (t(es, "Prefijo de requests", "Request prefix"), t(es, "Lo que ve el cliente. Por ejemplo: REQ-123.", "What the customer sees. For example: REQ-123."), self.requirements.clone()),
                    (t(es, "Prefijo de issues", "Issue prefix"), t(es, "Trabajo de desarrollo. Por ejemplo: ISS-123.", "Development work. For example: ISS-123."), self.tickets.clone()),
                ].into_iter().map(|(label, hint, input)| div().max_w(px(420.)).flex().flex_col().gap(px(6.))
                    .child(div().text_size(px(13.)).text_color(c(TEXT)).child(label)).child(input)
                    .child(div().text_size(px(11.5)).text_color(c(MUTED)).child(hint)))))
                .when(self.has_history, |d| d.child(div().max_w(px(640.)).text_size(px(12.)).text_color(c(MUTED)).child(t(es, "Este proyecto ya tiene historial. Para cambiar los prefijos es necesario migrar primero las claves registradas.", "This project already has history. Changing prefixes requires migrating recorded keys first."))))
                .children(self.error.clone().map(|error| div().max_w(px(640.)).text_size(px(12.)).text_color(c(RED)).child(error)))
                .when(self.error.is_some(), |d| d.child(button("general-reload", t(es, "Volver a cargar", "Reload"), Kind::Ghost, cx.listener(|this, _, _, cx| { if !this.saving { this.load(cx); } }))))
                .when(saved, |d| d.child(div().text_size(px(12.)).text_color(c(GREEN)).child(t(es, "Configuración guardada.", "Settings saved.")))))
    }
}
