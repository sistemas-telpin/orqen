//! The terminal of a request: a chat with the agent (Claude Code, headless with `--output-format stream-json`) about
//! one request, with the next commands of the 9-step flow suggested above the prompt. Each message is one
//! `claude -p` run that resumes the same session (`--resume`), so the conversation survives closing the app:
//! the session and the transcript are kept in orqen/state/app-chat/<KEY>.json (ignored by git).
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use gpui::{
    AnyElement, ClipboardItem, Context, Entity, EventEmitter, FocusHandle, Focusable, FontWeight, IntoElement, Render,
    ScrollHandle, SharedString, Subscription, Window, div, prelude::*, px,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::input::{InputKey, TextInput};
use crate::theme::*;
use crate::ui::{icon, live_dot};

/// One suggested command (`next` of `orqen status <KEY> --json`, or one of the 9 commands while typing `/`).
#[derive(Clone, Debug)]
pub struct Suggestion { pub step: u8, pub command: String, pub what: String }

/// What the terminal shows.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "k")]
enum Line {
    /// What the person sent.
    You { text: String },
    /// Text written by the agent.
    Agent { text: String },
    /// A tool the agent used (Bash, Read…), with its argument.
    Tool { name: String, detail: String },
    /// The tool's answer (first lines).
    Out { ok: bool, text: String },
    Info { text: String },
    Err { text: String },
    /// End of a run: seconds and cost.
    Done { secs: f64, cost: Option<f64> },
}

#[derive(Default, Serialize, Deserialize)]
struct Saved { session: Option<String>, lines: Vec<Line>, history: Vec<String> }

/// A `claude -p` running for this request.
struct Run {
    child: Arc<Mutex<Option<Child>>>,
    out: Arc<Mutex<Vec<String>>>,
    err: Arc<Mutex<Vec<String>>>,
    readers: Arc<AtomicUsize>,
    started: Instant,
    got_result: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ChatEvent { Changed, Finished }

pub struct AgentChat {
    pub key: String,
    repo: PathBuf,
    es: bool,
    input: Entity<TextInput>,
    lines: Vec<Line>,
    session: Option<String>,
    run: Option<Run>,
    /// From the CLI: state of the request, key to work with, next commands and history.
    state: String,
    work: String,
    next: Vec<Suggestion>,
    events: Vec<Value>,
    history: Vec<String>,
    hist_pos: Option<usize>,
    pick: usize,
    scroll: ScrollHandle,
    _subs: Vec<Subscription>,
}

impl EventEmitter<ChatEvent> for AgentChat {}

impl Focusable for AgentChat {
    fn focus_handle(&self, cx: &gpui::App) -> FocusHandle { self.input.read(cx).focus_handle(cx) }
}

fn t(es: bool, a: &'static str, b: &'static str) -> &'static str { if es { a } else { b } }

/// The 9 commands of the flow: step, command, whether it takes the request key (and which one), Spanish / English.
/// `Ext` = the client's request (support, analysis); `Work` = the issue when there is one.
#[derive(Clone, Copy, PartialEq)]
enum Arg { Ext, Work, Fixed(&'static str) }
const FLOW: [(u8, &str, Arg, &str, &str); 9] = [
    (1, "/orqen:list", Arg::Fixed("requests"), "Lista de trabajo por rol", "Work list by role"),
    (2, "/orqen:support", Arg::Ext, "Soporte: responder o escalar", "Support: answer or escalate"),
    (3, "/orqen:analyze", Arg::Ext, "Análisis: criterios, carril y spec", "Analysis: criteria, lane and spec"),
    (4, "/orqen:list", Arg::Fixed("issues"), "Cola de desarrollo", "Development queue"),
    (5, "/orqen:implement", Arg::Work, "Implementar", "Implement"),
    (6, "/orqen:pr", Arg::Work, "Explicar los cambios y abrir el PR", "Explain the changes and open the PR"),
    (7, "/orqen:review", Arg::Work, "QA: validar los e2e en pantalla", "QA: check the e2e on screen"),
    (8, "/orqen:list", Arg::Fixed("prs"), "Cola del senior", "Senior's queue"),
    (9, "/orqen:approve", Arg::Work, "Aprobar el PR o pedir cambios", "Approve the PR or request changes"),
];

/// Label of a suggestion in the person's language (the CLI writes them in English).
pub fn step_label(step: u8, command: &str, state: &str, what: &str, es: bool) -> String {
    if !es { return what.to_string(); }
    if step == 9 && state == "DELIVERY" { return "Entregar al cliente".into(); }
    if step == 5 && what.contains("requested") { return "Implementar los cambios pedidos".into(); }
    if step == 2 && state == "SUPPORT" { return "Seguir con soporte".into(); }
    if step == 3 && state == "ANALYSIS" { return "Seguir el análisis".into(); }
    if let Some(f) = FLOW.iter().find(|f| f.0 == step && step > 0) { return f.3.to_string(); }
    if command.contains(" take ") && command.contains("tester") { return "Correr el testing automático".into(); }
    if command.contains(" take ") { return "Etapa operativa".into(); }
    match state {
        "WAITING_CLIENT" => "Espera las respuestas del cliente en el pedido".into(),
        "ACCEPTANCE" => "Espera que el cliente confirme con /approve".into(),
        "BLOCKED" => "Bloqueado: se destraba con /approve en el pedido".into(),
        "EXECUTION_APPROVAL" | "APPLICATION" => "Espera /approve en el pedido".into(),
        _ => "Ver el estado".into(),
    }
}

/// Next commands when the CLI does not send them (an orqen older than `orqen list`).
pub fn fallback_next(state: &str, key: &str, work: &str) -> Vec<(u8, String, String)> {
    match state {
        "NEW" => vec![(3, format!("/orqen:analyze {key}"), "Analysis".into()), (2, format!("/orqen:support {key}"), "Support".into())],
        "SUPPORT" => vec![(2, format!("/orqen:support {key}"), "Continue support".into())],
        "ANALYSIS" => vec![(3, format!("/orqen:analyze {key}"), "Continue the analysis".into())],
        "DEVELOPMENT" => vec![(5, format!("/orqen:implement {work}"), "Implement".into())],
        "TESTING" => vec![(0, format!("orqen take {work} --agent tester"), "Run the automatic testing".into()), (6, format!("/orqen:pr {work}"), "Open the PR".into())],
        "QA_REVIEW" => vec![(7, format!("/orqen:review {work}"), "QA review (full lane)".into())],
        "CODE_REVIEW" => vec![(6, format!("/orqen:pr {work}"), "Open the PR".into()), (9, format!("/orqen:approve {work}"), "Approve".into())],
        "DELIVERY" => vec![(9, format!("/orqen:approve {work}"), "Deliver".into())],
        _ => vec![(0, format!("orqen status {key}"), "See the state".into())],
    }
}

impl AgentChat {
    pub fn new(key: String, repo: PathBuf, es: bool, cx: &mut Context<Self>) -> Self {
        let placeholder = t(es, "Escribile al agente o elegí una sugerencia (/ para ver los comandos)", "Message the agent or pick a suggestion (/ for the commands)");
        let input = cx.new(|cx| TextInput::new(cx, placeholder, "", false).bare());
        let mut subs = vec![cx.subscribe(&input, |this, _, k: &InputKey, cx| this.on_key(*k, cx))];
        subs.push(cx.observe(&input, |this, _, cx| { this.pick = 0; cx.notify(); }));
        let saved: Saved = std::fs::read_to_string(saved_path(&repo, &key)).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
        let work = key.clone();
        Self {
            key, repo, es, input, lines: saved.lines, session: saved.session, run: None, state: "NEW".into(), work,
            next: vec![], events: vec![], history: saved.history, hist_pos: None, pick: 0, scroll: ScrollHandle::new(), _subs: subs,
        }
    }

    pub fn busy(&self) -> bool { self.run.is_some() }

    /// What the CLI says about the request: its state, the key to work with, the next commands and its history.
    pub fn set_context(&mut self, state: String, work: String, next: Vec<Suggestion>, events: Vec<Value>, es: bool, cx: &mut Context<Self>) {
        self.state = state; self.work = work; self.next = next; self.events = events; self.es = es;
        cx.notify();
    }

    /// Suggestions under the prompt: while typing `/`, the 9 commands that match; otherwise the next ones for this request.
    fn suggestions(&self, cx: &gpui::App) -> Vec<Suggestion> {
        let text = self.input.read(cx).text();
        let typed = text.trim_start();
        if typed.starts_with('/') {
            let word = typed.split_whitespace().next().unwrap_or("/").to_lowercase();
            let mut out: Vec<Suggestion> = FLOW.iter().filter(|f| f.1.starts_with(&word) || word.starts_with(f.1)).map(|f| {
                let arg = match f.2 { Arg::Ext => format!(" {}", self.key), Arg::Work => format!(" {}", self.work), Arg::Fixed(a) => format!(" {a}") };
                Suggestion { step: f.0, command: format!("{}{arg}", f.1), what: (if self.es { f.3 } else { f.4 }).to_string() }
            }).collect();
            out.dedup_by(|a, b| a.command == b.command);
            return out;
        }
        let mut out: Vec<Suggestion> = self.next.iter().filter(|n| n.step > 0 || !n.command.starts_with("orqen status")).cloned().collect();
        // the list of the role that acts now (steps 1, 4, 8), after the request's own commands
        let list = match out.first().map(|n| n.step) { Some(5) | Some(6) => 4, Some(7) | Some(9) => 8, _ => 1 };
        let f = FLOW.iter().find(|f| f.0 == list).unwrap();
        if let Arg::Fixed(a) = f.2 { out.push(Suggestion { step: f.0, command: format!("{} {a}", f.1), what: (if self.es { f.3 } else { f.4 }).to_string() }); }
        out
    }

    fn on_key(&mut self, k: InputKey, cx: &mut Context<Self>) {
        let typing_cmd = self.input.read(cx).text().trim_start().starts_with('/');
        let n = self.suggestions(cx).len();
        match k {
            InputKey::Submit => { let text = self.input.read(cx).text(); self.send(text, cx); }
            InputKey::Complete => {
                if let Some(sg) = self.suggestions(cx).get(self.pick).cloned() { self.input.update(cx, |i, cx| i.set_text(sg.command, cx)); }
            }
            InputKey::Up | InputKey::Down if typing_cmd && n > 0 => {
                self.pick = if k == InputKey::Up { (self.pick + n - 1) % n } else { (self.pick + 1) % n };
                cx.notify();
            }
            InputKey::Up => {
                if self.history.is_empty() { return; }
                let pos = match self.hist_pos { None => self.history.len() - 1, Some(0) => 0, Some(p) => p - 1 };
                self.hist_pos = Some(pos);
                let h = self.history[pos].clone();
                self.input.update(cx, |i, cx| i.set_text(h, cx));
            }
            InputKey::Down => {
                let Some(p) = self.hist_pos else { return };
                let (pos, text) = if p + 1 < self.history.len() { (Some(p + 1), self.history[p + 1].clone()) } else { (None, String::new()) };
                self.hist_pos = pos;
                self.input.update(cx, |i, cx| i.set_text(text, cx));
            }
            InputKey::Escape => { if self.busy() { self.stop(cx); } else { self.input.update(cx, |i, cx| i.set_text("", cx)); } }
        }
    }

    pub fn fill(&mut self, command: String, window: &mut Window, cx: &mut Context<Self>) {
        self.input.update(cx, |i, cx| i.set_text(command, cx));
        window.focus(&self.input.read(cx).focus_handle(cx));
    }

    /// Sends a message: starts `claude -p` (resuming this request's session) with the text on stdin.
    pub fn send(&mut self, text: String, cx: &mut Context<Self>) {
        let text = text.trim().to_string();
        if text.is_empty() || self.busy() { return; }
        let Some(claude) = find_claude() else {
            self.lines.push(Line::You { text });
            self.lines.push(Line::Err { text: t(self.es,
                "No encontré Claude Code en esta máquina. Instalalo (npm i -g @anthropic-ai/claude-code), iniciá sesión con `claude` una vez y volvé a intentar. También podés indicar la ruta con ORQEN_CHAT_AGENT.",
                "Claude Code was not found on this machine. Install it (npm i -g @anthropic-ai/claude-code), log in once with `claude` and try again. You can also set its path in ORQEN_CHAT_AGENT.").into() });
            self.input.update(cx, |i, cx| i.set_text("", cx));
            self.after_change(cx);
            return;
        };
        self.input.update(cx, |i, cx| i.set_text("", cx));
        if self.history.last() != Some(&text) { self.history.push(text.clone()); }
        self.hist_pos = None;
        self.lines.push(Line::You { text: text.clone() });
        match self.spawn(&claude, &text) {
            Ok(run) => self.run = Some(run),
            Err(e) => self.lines.push(Line::Err { text: format!("{}: {e}", t(self.es, "No se pudo iniciar el agente", "Could not start the agent")) }),
        }
        self.after_change(cx);
        if self.run.is_some() { self.pump_loop(cx); }
    }

    fn spawn(&self, claude: &Path, text: &str) -> anyhow::Result<Run> {
        let system = format!(
            "You are running inside the ORQEN desktop app, in the terminal of request {} (work key {}). The person reads you in a chat panel. \
             AskUserQuestion is not available here: ask your questions in plain text, one at a time, with numbered options and your recommendation, \
             then stop and wait for the answer in the next message. Keep messages short and talk to the person in {}.",
            self.key, self.work, if self.es { "Spanish" } else { "English" });
        let mut cmd = Command::new(claude);
        cmd.args(["-p", "--output-format", "stream-json", "--verbose", "--disallowedTools", "AskUserQuestion",
                  "--allowedTools", "Bash(orqen:*)", "Read", "Grep", "Glob", "--append-system-prompt", &system]);
        if let Some(s) = &self.session { cmd.args(["--resume", s]); }
        cmd.current_dir(&self.repo).env("NO_COLOR", "1").env("FORCE_COLOR", "0")
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        #[cfg(windows)]
        { use std::os::windows::process::CommandExt; cmd.creation_flags(crate::cli::CHILD_FLAGS); }
        let mut child = cmd.spawn()?;
        if let Some(mut w) = child.stdin.take() { w.write_all(text.as_bytes())?; }   // dropped: the prompt ends here
        let (out, err) = (Arc::new(Mutex::new(vec![])), Arc::new(Mutex::new(vec![])));
        let readers = Arc::new(AtomicUsize::new(2));
        for (pipe, sink) in [(child.stdout.take().map(|p| Box::new(p) as Box<dyn std::io::Read + Send>), out.clone()),
                             (child.stderr.take().map(|p| Box::new(p) as Box<dyn std::io::Read + Send>), err.clone())] {
            let readers = readers.clone();
            std::thread::spawn(move || {
                if let Some(pipe) = pipe {
                    for line in BufReader::new(pipe).lines().map_while(Result::ok) { sink.lock().unwrap().push(line); }
                }
                readers.fetch_sub(1, Ordering::SeqCst);
            });
        }
        Ok(Run { child: Arc::new(Mutex::new(Some(child))), out, err, readers, started: Instant::now(), got_result: false })
    }

    /// Stops the running agent (Esc or the stop button).
    pub fn stop(&mut self, cx: &mut Context<Self>) {
        if let Some(run) = &self.run {
            if let Some(child) = run.child.lock().unwrap().as_mut() { kill_tree(child); }
            self.lines.push(Line::Info { text: t(self.es, "Detenido.", "Stopped.").into() });
            cx.notify();
        }
    }

    fn pump_loop(&mut self, cx: &mut Context<Self>) {
        cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor().timer(Duration::from_millis(90)).await;
                let more = this.update(cx, |this, cx| this.pump(cx)).unwrap_or(false);
                if !more { break; }
            }
        }).detach();
    }

    /// Reads what the agent wrote since the last call. false when the run is over.
    fn pump(&mut self, cx: &mut Context<Self>) -> bool {
        let Some(run) = self.run.as_mut() else { return false };
        let lines: Vec<String> = std::mem::take(&mut *run.out.lock().unwrap());
        let mut changed = !lines.is_empty();
        for l in lines {
            let Ok(v) = serde_json::from_str::<Value>(&l) else { if !l.trim().is_empty() { self.lines.push(Line::Out { ok: true, text: l }); } continue };
            if v["type"] == "result" { run.got_result = true; }
            self.lines.push_event(&v, &mut self.session, self.es);
        }
        let exited = run.child.lock().unwrap().as_mut().map(|c| c.try_wait().ok().flatten()).unwrap_or(None);
        if let Some(status) = exited {
            if run.readers.load(Ordering::SeqCst) == 0 && run.out.lock().unwrap().is_empty() {
                let run = self.run.take().unwrap();
                let failed = self.lines.iter().rev().take_while(|l| !matches!(l, Line::You { .. })).any(|l| matches!(l, Line::Err { .. }));
                let errs: Vec<String> = run.err.lock().unwrap().iter().filter(|l| !l.trim().is_empty()).cloned().collect();
                let err = errs[errs.len().saturating_sub(6)..].join("\n");
                if (!run.got_result && !status.success()) || (failed && !err.trim().is_empty()) {
                    let gone = err.contains("No conversation found") || err.contains("--resume");
                    if gone { self.session = None; }
                    let hint = if gone { t(self.es, "\nLa conversación anterior ya no está en esta máquina: mandá el mensaje de nuevo y empieza una nueva.", "\nThe previous conversation is no longer on this machine: send the message again to start a new one.") } else { "" };
                    let text = if err.trim().is_empty() { format!("exit {}", status.code().unwrap_or(-1)) } else { err };
                    self.lines.push(Line::Err { text: format!("{text}{hint}") });
                }
                self.after_change(cx);
                cx.emit(ChatEvent::Finished);
                return false;
            }
        }
        if changed { self.after_change(cx); } else { changed = true; cx.notify(); }   // the elapsed time ticks
        changed
    }

    fn after_change(&mut self, cx: &mut Context<Self>) {
        self.scroll.scroll_to_bottom();
        let keep = self.lines.len().saturating_sub(400);
        let saved = Saved { session: self.session.clone(), lines: self.lines[keep..].to_vec(), history: self.history.iter().rev().take(50).rev().cloned().collect() };
        let path = saved_path(&self.repo, &self.key);
        if let Some(d) = path.parent() { let _ = std::fs::create_dir_all(d); }
        if let Ok(text) = serde_json::to_string(&saved) { let _ = std::fs::write(path, text); }
        cx.emit(ChatEvent::Changed);
        cx.notify();
    }

    /// Clears the conversation: the next message starts a new session.
    fn reset(&mut self, cx: &mut Context<Self>) {
        if self.busy() { return; }
        self.lines.clear();
        self.session = None;
        self.after_change(cx);
    }
}

trait PushEvent { fn push_event(&mut self, v: &Value, session: &mut Option<String>, es: bool); }
impl PushEvent for Vec<Line> {
    /// One event of `--output-format stream-json`.
    fn push_event(&mut self, v: &Value, session: &mut Option<String>, es: bool) {
        match v["type"].as_str().unwrap_or("") {
            "system" if v["subtype"] == "init" => {
                let id = v["session_id"].as_str().map(str::to_string);
                if id.is_some() && *session != id {
                    if session.is_none() {
                        let model = v["model"].as_str().unwrap_or("claude");
                        self.push(Line::Info { text: format!("claude · {model} · {} {}", t(es, "sesión", "session"), id.as_deref().unwrap_or("").chars().take(8).collect::<String>()) });
                    }
                    *session = id;
                }
            }
            "assistant" => for b in v["message"]["content"].as_array().into_iter().flatten() {
                match b["type"].as_str() {
                    Some("text") => { let t = b["text"].as_str().unwrap_or("").trim(); if !t.is_empty() { self.push(Line::Agent { text: t.to_string() }); } }
                    Some("tool_use") => self.push(Line::Tool { name: b["name"].as_str().unwrap_or("tool").to_string(), detail: tool_detail(&b["input"]) }),
                    _ => {}
                }
            },
            "user" => for b in v["message"]["content"].as_array().into_iter().flatten() {
                if b["type"] == "tool_result" {
                    let text = match &b["content"] {
                        Value::String(s) => s.clone(),
                        Value::Array(a) => a.iter().filter_map(|x| x["text"].as_str()).collect::<Vec<_>>().join("\n"),
                        _ => String::new(),
                    };
                    self.push(Line::Out { ok: b["is_error"].as_bool() != Some(true), text: crate::cli::strip_ansi(&text) });
                }
            },
            "result" => {
                if let Some(id) = v["session_id"].as_str() { *session = Some(id.to_string()); }
                if v["is_error"].as_bool() == Some(true) {
                    let r = v["result"].as_str().map(str::to_string).unwrap_or_else(|| v["subtype"].as_str().unwrap_or("error").to_string());
                    // the same text often already came as the agent's last message (e.g. an authentication error)
                    if let Some(Line::Agent { text }) = self.last() { if text.trim() == r.trim() { self.pop(); } }
                    let r = if r == "error_during_execution" { t(es, "El agente no pudo ejecutar el pedido.", "The agent could not run the request.").to_string() } else { r };
                    self.push(Line::Err { text: r });
                }
                self.push(Line::Done { secs: v["duration_ms"].as_f64().unwrap_or(0.) / 1000., cost: v["total_cost_usd"].as_f64() });
            }
            _ => {}
        }
    }
}

/// The argument worth showing of a tool call.
fn tool_detail(input: &Value) -> String {
    let pick = ["command", "file_path", "path", "pattern", "skill", "url", "query", "description", "prompt"];
    let s = pick.iter().find_map(|k| input[*k].as_str().map(str::to_string))
        .or_else(|| input.as_object().and_then(|o| o.values().find_map(|v| v.as_str().map(str::to_string))))
        .unwrap_or_default();
    let one = s.lines().next().unwrap_or("").to_string();
    if one.chars().count() > 160 { format!("{}…", one.chars().take(160).collect::<String>()) } else if s.lines().count() > 1 { format!("{one} …") } else { one }
}

fn saved_path(repo: &Path, key: &str) -> PathBuf {
    let safe: String = key.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' }).collect();
    repo.join("orqen").join("state").join("app-chat").join(format!("{safe}.json"))
}

/// Claude Code: ORQEN_CHAT_AGENT, the PATH, or where its installers leave it (the app may start without the shell's PATH).
pub fn find_claude() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("ORQEN_CHAT_AGENT") { let p = PathBuf::from(p); if p.exists() { return Some(p); } }
    let names: &[&str] = if cfg!(windows) { &["claude.exe", "claude.cmd"] } else { &["claude"] };
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default();
    if let Some(home) = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from) {
        dirs.push(home.join(".local").join("bin"));
        dirs.push(home.join(".claude").join("local"));
        dirs.push(home.join(".npm-global").join("bin"));
    }
    if let Some(appdata) = std::env::var_os("APPDATA") { dirs.push(PathBuf::from(appdata).join("npm")); }
    for d in ["/opt/homebrew/bin", "/usr/local/bin"] { dirs.push(PathBuf::from(d)); }
    dirs.iter().flat_map(|d| names.iter().map(move |n| d.join(n))).find(|p| p.is_file())
}

fn kill_tree(child: &mut Child) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = Command::new("taskkill").args(["/T", "/F", "/PID", &child.id().to_string()]).creation_flags(crate::cli::CHILD_FLAGS).status();
    }
    let _ = child.kill();
}

// ================================================================ view

/// Agent text, as a terminal shows it: line by line, with `#` titles, bullets and code blocks.
fn term_text(text: &str, color: u32) -> Vec<AnyElement> {
    let mut out = vec![];
    let mut code: Option<Vec<String>> = None;
    for line in text.lines() {
        if line.trim_start().starts_with("```") {
            if let Some(lines) = code.take() {
                out.push(div().my(px(3.)).px(px(10.)).py(px(6.)).rounded(px(6.)).bg(c(0x0D1220)).border_1().border_color(c(0x18203A)).text_color(c(TEXT))
                    .children(lines.into_iter().map(|l| div().child(if l.is_empty() { " ".to_string() } else { l }))).into_any_element());
            } else { code = Some(vec![]); }
            continue;
        }
        if let Some(c) = code.as_mut() { c.push(line.to_string()); continue; }
        let l = line.replace("**", "").replace('`', "");
        if l.trim().is_empty() { out.push(div().h(px(8.)).into_any_element()); continue; }
        if let Some(h) = l.strip_prefix("### ").or(l.strip_prefix("## ")).or(l.strip_prefix("# ")) {
            out.push(div().mt(px(2.)).font_weight(FontWeight::BOLD).text_color(c(TEXT)).child(h.to_string()).into_any_element());
        } else if let Some(b) = l.trim_start().strip_prefix("- ").or(l.trim_start().strip_prefix("* ")) {
            let indent = (l.len() - l.trim_start().len()) as f32 * 4.;
            out.push(div().flex().pl(px(indent)).child(div().w(px(16.)).flex_none().text_color(c(BLUE_TEXT)).child("•")).child(div().flex_1().min_w(px(0.)).text_color(c(color)).child(b.to_string())).into_any_element());
        } else {
            out.push(div().text_color(c(color)).child(l).into_any_element());
        }
    }
    if let Some(lines) = code { out.extend(lines.into_iter().map(|l| div().text_color(c(TEXT)).child(l).into_any_element())); }
    out
}

impl Render for AgentChat {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let es = self.es;
        let busy = self.busy();
        let focused = self.input.read(cx).focus_handle(cx).is_focused(window);
        let sugg = self.suggestions(cx);
        let typing_cmd = self.input.read(cx).text().trim_start().starts_with('/');
        let pick = self.pick.min(sugg.len().saturating_sub(1));

        // the request's history, like a terminal's welcome lines
        let motd = div().flex().flex_col().gap(px(1.)).pb(px(10.))
            .child(div().flex().gap(px(8.)).child(div().text_color(c(MAGENTA_TEXT)).child("orqen")).child(div().text_color(c(DIM)).child("·"))
                .child(div().text_color(c(BLUE_TEXT)).child(self.key.clone()))
                .children((self.work != self.key).then(|| div().text_color(c(0xFFB3D9)).child(self.work.clone())))
                .child(div().text_color(c(DIM)).child("·")).child(div().text_color(c(stage_color(&self.state))).child(stage_name(&self.state, es))))
            .children(self.events.iter().rev().take(6).rev().map(|ev| {
                let ts = ev["ts"].as_str().unwrap_or("");
                let when = ts.get(5..16).unwrap_or(ts).replace('T', " ");
                let (from, to) = (ev["from"].as_str().unwrap_or(""), ev["to"].as_str().unwrap_or(""));
                div().flex().gap(px(8.)).text_color(c(DIM))
                    .child(div().flex_none().child(when))
                    .child(div().flex_none().text_color(c(stage_color(from))).child(stage_name(from, es)))
                    .child(div().flex_none().child("→"))
                    .child(div().flex_none().text_color(c(stage_color(to))).child(stage_name(to, es)))
                    .child(div().flex_1().min_w(px(0.)).truncate().child(ev["detail"].as_str().unwrap_or("").to_string()))
            }))
            .when(self.events.is_empty(), |d| d.child(div().text_color(c(DIM)).child(t(es, "Todavía nadie lo tomó.", "Nobody has taken it yet."))))
            .when(self.lines.is_empty(), |d| d.child(div().pt(px(8.)).text_color(c(MUTED)).child(match sugg.first() {
                Some(s) if !typing_cmd => format!("{} {}  ({})", t(es, "Para empezar:", "To start:"), s.command, t(es, "Tab o clic para ponerlo, Enter para mandarlo", "Tab or click to put it in, Enter to send it")),
                _ => t(es, "Escribile al agente.", "Message the agent.").to_string(),
            })));

        let body = self.lines.iter().enumerate().map(|(i, l)| match l {
            Line::You { text } => div().mt(px(10.)).flex().gap(px(8.)).child(div().flex_none().text_color(c(MAGENTA_TEXT)).font_weight(FontWeight::BOLD).child("›"))
                .child(div().flex_1().min_w(px(0.)).text_color(c(TEXT)).font_weight(FontWeight::SEMIBOLD).child(text.clone())).into_any_element(),
            Line::Agent { text } => {
                let copy = text.clone();
                div().id(("agent-line", i)).group(SharedString::from(format!("al{i}"))).relative().mt(px(6.)).flex().gap(px(8.))
                    .child(div().flex_none().w(px(10.)).text_color(c(BLUE_TEXT)).child("●"))
                    .child(div().flex_1().min_w(px(0.)).flex().flex_col().children(term_text(text, TEXT_2)))
                    .child(div().id(("copy-line", i)).absolute().top_0().right_0().invisible().group_hover(SharedString::from(format!("al{i}")), |s| s.visible())
                        .p(px(3.)).rounded(px(5.)).cursor_pointer().hover(|h| h.bg(c(0x161D2D))).child(icon("copy", 12., DIM))
                        .on_click(move |_, _, cx| cx.write_to_clipboard(ClipboardItem::new_string(copy.clone()))))
                    .into_any_element()
            }
            Line::Tool { name, detail } => div().mt(px(6.)).flex().gap(px(8.))
                .child(div().flex_none().w(px(10.)).text_color(c(GREEN)).child("●"))
                .child(div().flex_none().text_color(c(TEXT)).font_weight(FontWeight::SEMIBOLD).child(name.clone()))
                .child(div().flex_1().min_w(px(0.)).truncate().text_color(c(MUTED)).child(detail.clone())).into_any_element(),
            Line::Out { ok, text } => {
                let lines: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
                let shown: Vec<String> = lines.iter().take(4).map(|l| l.to_string()).collect();
                let more = lines.len().saturating_sub(4);
                div().flex().gap(px(8.)).pl(px(18.))
                    .child(div().flex_none().text_color(c(DIM)).child("⎿"))
                    .child(div().flex_1().min_w(px(0.)).flex().flex_col().text_color(c(if *ok { DIM } else { RED }))
                        .children(shown.into_iter().map(|l| div().truncate().child(l)))
                        .when(lines.is_empty(), |d| d.child(div().child(t(es, "(sin salida)", "(no output)"))))
                        .when(more > 0, |d| d.child(div().text_color(c(0x56627A)).child(format!("… +{more} {}", t(es, "líneas", "lines"))))))
                    .into_any_element()
            }
            Line::Info { text } => div().mt(px(4.)).text_color(c(DIM)).child(text.clone()).into_any_element(),
            Line::Err { text } => div().mt(px(6.)).flex().gap(px(8.)).child(div().flex_none().w(px(10.)).text_color(c(RED)).child("✘"))
                .child(div().flex_1().min_w(px(0.)).flex().flex_col().text_color(c(RED)).children(text.lines().map(|l| div().child(l.to_string())))).into_any_element(),
            Line::Done { secs, cost } => div().mt(px(6.)).flex().items_center().gap(px(8.)).text_color(c(0x56627A))
                .child(div().w(px(18.)).h(px(1.)).bg(c(0x232B3D)))
                .child(format!("{} {:.0} s{}", t(es, "listo en", "done in"), secs, cost.map(|c| format!(" · US$ {c:.2}")).unwrap_or_default()))
                .into_any_element(),
        }).collect::<Vec<_>>();

        let working = self.run.as_ref().map(|r| r.started.elapsed().as_secs());
        let terminal = div().id(("term", 0usize)).track_scroll(&self.scroll).flex_1().min_h(px(0.)).overflow_y_scroll()
            .px(px(16.)).py(px(12.)).font_family(MONO_FONT).text_size(px(12.5)).line_height(px(19.))
            .child(motd).children(body)
            .children(working.map(|s| div().mt(px(8.)).flex().items_center().gap(px(8.)).text_color(c(MUTED))
                .child(live_dot("term-busy", BLUE_TEXT))
                .child(format!("{} {s} s", t(es, "trabajando…", "working…")))
                .child(div().text_color(c(0x56627A)).child(t(es, "Esc para detener", "Esc to stop")))));

        // suggestions: the next commands of the flow (or, while typing /, the 9 commands)
        let chips = sugg.iter().enumerate().map(|(i, sg)| {
            let cmd = sg.command.clone();
            let on = typing_cmd && i == pick;
            let label = step_label(sg.step, &sg.command, &self.state, &sg.what, es);
            div().id(("sugg", i)).flex().items_center().gap(px(7.)).h(px(28.)).pl(px(4.)).pr(px(10.)).rounded(px(7.)).cursor_pointer().border_1()
                .border_color(c(if on { 0x2E4A9A } else if i == 0 && !typing_cmd { 0x23345F } else { 0x1E2638 }))
                .bg(c(if on || (i == 0 && !typing_cmd) { 0x0F1A36 } else { SURFACE }))
                .hover(|h| h.border_color(c(0x2E4A9A)).bg(c(0x111A2E)))
                .child(div().size(px(19.)).flex_none().flex().items_center().justify_center().rounded(px(5.)).text_size(px(10.5)).font_weight(FontWeight::BOLD)
                    .bg(c(if sg.step > 0 { 0x1A2547 } else { 0x161D2D })).text_color(c(if sg.step > 0 { BLUE_TEXT } else { DIM }))
                    .child(if sg.step > 0 { sg.step.to_string() } else { "›".into() }))
                .child(div().font_family(MONO_FONT).text_size(px(12.)).text_color(c(TEXT)).child(sg.command.clone()))
                .child(div().text_size(px(11.)).text_color(c(MUTED)).child(label))
                .on_click(cx.listener(move |this, _, window, cx| this.fill(cmd.clone(), window, cx)))
        }).collect::<Vec<_>>();
        let suggestions = div().flex().flex_col().gap(px(6.)).px(px(14.)).pt(px(10.))
            .child(div().flex().items_center().gap(px(8.)).text_size(px(10.5)).text_color(c(DIM))
                .child(if typing_cmd { t(es, "COMANDOS DEL FLUJO", "FLOW COMMANDS") } else { t(es, "SUGERENCIAS", "SUGGESTIONS") })
                .child(div().flex_1())
                .when(!self.lines.is_empty() && !busy, |d| d.child(div().id("chat-reset").cursor_pointer().text_color(c(DIM)).hover(|h| h.text_color(c(TEXT_2)))
                    .child(t(es, "Nueva conversación", "New conversation")).on_click(cx.listener(|this, _, _, cx| this.reset(cx))))))
            .child(div().flex().flex_wrap().gap(px(6.)).children(chips)
                .when(sugg.is_empty(), |d| d.child(div().h(px(28.)).flex().items_center().text_size(px(11.5)).text_color(c(DIM))
                    .child(if typing_cmd { t(es, "Ningún comando del flujo empieza así.", "No flow command starts like that.") } else { t(es, "Nada que sugerir en esta etapa.", "Nothing to suggest at this stage.") }))));

        let send = div().id("chat-send").size(px(36.)).flex_none().flex().items_center().justify_center().rounded(px(8.)).cursor_pointer()
            .when(busy, |d| d.bg(c(0x2A1420)).border_1().border_color(c(0x5A2440)).hover(|h| h.bg(c(0x3A1A2C))).child(icon("stop", 14., MAGENTA_TEXT)))
            .when(!busy, |d| d.bg(c(BLUE)).hover(|h| h.bg(c(0x3B74FF))).child(icon("send", 15., 0xFFFFFF)))
            .on_click(cx.listener(|this, _, _, cx| { if this.busy() { this.stop(cx); } else { let t = this.input.read(cx).text(); this.send(t, cx); } }));
        let prompt = div().flex().items_center().gap(px(8.)).px(px(14.)).pt(px(8.)).pb(px(12.))
            .child(div().flex_1().min_w(px(0.)).h(px(36.)).flex().items_center().gap(px(8.)).px(px(11.)).rounded(px(8.)).border_1()
                .border_color(c(if focused { 0x2E4A9A } else { 0x222B40 })).bg(c(0x070A10))
                .child(div().font_family(MONO_FONT).text_color(c(MAGENTA_TEXT)).font_weight(FontWeight::BOLD).child("›"))
                .child(div().flex_1().min_w(px(0.)).child(self.input.clone())))
            .child(send);

        div().size_full().flex().flex_col().bg(c(0x080B12))
            .child(terminal)
            .child(div().flex_none().border_t_1().border_color(c(BORDER)).bg(c(PANEL)).child(suggestions).child(prompt))
    }
}
