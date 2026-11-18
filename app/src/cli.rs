//! Bridge to the orqen CLI: the app has no workflow logic of its own, it runs `orqen … --json` in the repository.
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::process::{Command, Stdio};

use anyhow::{Context as _, Result, anyhow};
use serde_json::Value;

/// CREATE_NO_WINDOW | BELOW_NORMAL_PRIORITY_CLASS: the CLI (node) and git never take the CPU from the UI thread,
/// so the opening animation and scrolling stay smooth while several of them start at once.
#[cfg(windows)]
const CHILD_FLAGS: u32 = 0x0800_0000 | 0x0000_4000;

#[derive(Clone, Debug)]
pub struct Cli {
    /// node + dist/index.js passed by `orqen` when it opens the app; otherwise `orqen` from the PATH.
    pub node: Option<PathBuf>,
    pub script: Option<PathBuf>,
    pub repo: PathBuf,
}

#[allow(dead_code)]
pub struct Output { pub ok: bool, pub stdout: String, pub stderr: String }

impl Cli {
    fn command(&self) -> Command {
        let mut cmd = match (&self.node, &self.script) {
            (Some(node), Some(script)) => { let mut c = Command::new(node); c.arg(script); c }
            _ if cfg!(windows) => { let mut c = Command::new("cmd"); c.args(["/C", "orqen"]); c }
            _ => Command::new("orqen"),
        };
        cmd.current_dir(&self.repo).env("NO_COLOR", "1").env("FORCE_COLOR", "0")
            .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
        #[cfg(windows)]
        { use std::os::windows::process::CommandExt; cmd.creation_flags(CHILD_FLAGS); }
        cmd
    }

    pub fn run(&self, args: &[&str]) -> Result<Output> {
        let out = self.command().args(args).output().context("could not run the orqen CLI (is it installed? `npm i -g orqen`)")?;
        Ok(Output { ok: out.status.success(), stdout: String::from_utf8_lossy(&out.stdout).into_owned(), stderr: String::from_utf8_lossy(&out.stderr).into_owned() })
    }

    /// Runs a long command (init) and pushes each output line to `sink` as it comes. true if it succeeded.
    pub fn stream(&self, args: &[&str], stdin: Option<String>, sink: Arc<Mutex<Vec<String>>>) -> Result<bool> {
        let mut cmd = self.command();
        cmd.args(args).env("ORQEN_NO_APP_DOWNLOAD", "1");
        if stdin.is_some() { cmd.stdin(Stdio::piped()); }
        let mut child = cmd.spawn().context("could not run the orqen CLI")?;
        if let (Some(text), Some(mut w)) = (stdin, child.stdin.take()) { w.write_all(text.as_bytes())?; }
        let mut readers = vec![];
        for pipe in [child.stdout.take().map(|p| Box::new(p) as Box<dyn std::io::Read + Send>), child.stderr.take().map(|p| Box::new(p) as Box<dyn std::io::Read + Send>)].into_iter().flatten() {
            let sink = sink.clone();
            readers.push(std::thread::spawn(move || {
                for line in BufReader::new(pipe).lines().map_while(Result::ok) {
                    let l = strip_ansi(&line).replace("[?25l", "").replace("[?25h", "");
                    if !l.trim().is_empty() { sink.lock().unwrap().push(l); }
                }
            }));
        }
        let status = child.wait()?;
        for r in readers { let _ = r.join(); }
        Ok(status.success())
    }

    /// Runs a command that reads `input` on stdin (`orqen connectors set -`).
    pub fn run_stdin(&self, args: &[&str], input: &str) -> Result<Output> {
        let mut cmd = self.command();
        cmd.args(args).stdin(Stdio::piped());
        let mut child = cmd.spawn().context("could not run the orqen CLI (is it installed? `npm i -g orqen`)")?;
        if let Some(mut w) = child.stdin.take() { w.write_all(input.as_bytes())?; }
        let out = child.wait_with_output()?;
        Ok(Output { ok: out.status.success(), stdout: String::from_utf8_lossy(&out.stdout).into_owned(), stderr: String::from_utf8_lossy(&out.stderr).into_owned() })
    }

    /// Like `json`, with `input` on stdin.
    pub fn json_stdin(&self, args: &[&str], input: &str) -> Result<Value> { parse_json(self.run_stdin(args, input)?, args) }

    /// Runs a command that prints JSON (warnings on stderr are ignored).
    pub fn json(&self, args: &[&str]) -> Result<Value> { parse_json(self.run(args)?, args) }

    pub fn has_orqen(&self) -> bool { self.repo.join("orqen").join("config.yaml").exists() }
}

/// The JSON a command printed (warnings before it, or on stderr, are ignored).
fn parse_json(out: Output, args: &[&str]) -> Result<Value> {
    let text = out.stdout.trim();
    let start = text.find(['{', '[']).ok_or_else(|| anyhow!(first_line(if out.stderr.trim().is_empty() { text } else { &out.stderr })))?;
    serde_json::from_str(&text[start..]).map_err(|e| anyhow!("orqen {}: invalid JSON ({e})", args.join(" ")))
}

pub fn first_line(s: &str) -> String {
    s.lines().map(str::trim).find(|l| !l.is_empty()).unwrap_or("error").trim_start_matches("✘ ").to_string()
}

/// Closest folder (this one or a parent) with orqen/config.yaml.
pub fn find_repo(from: &Path) -> Option<PathBuf> {
    let mut d = from.canonicalize().ok()?;
    loop {
        if d.join("orqen").join("config.yaml").exists() { return Some(d); }
        if !d.pop() { return None; }
    }
}

/// Last lines of a log file.
pub fn tail(path: &Path, lines: usize) -> Vec<String> {
    let Ok(text) = std::fs::read_to_string(path) else { return vec![] };
    let all: Vec<&str> = text.lines().collect();
    all[all.len().saturating_sub(lines)..].iter().map(|l| strip_ansi(l)).collect()
}

pub fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\u{1b}' { while let Some(&n) = chars.peek() { chars.next(); if n.is_ascii_alphabetic() { break; } } } else { out.push(ch); }
    }
    out
}

/// Latest swarm report (orqen/state/swarm/<run>/report.json).
pub fn latest_swarm(repo: &Path) -> Option<Value> {
    let dir = repo.join("orqen").join("state").join("swarm");
    let mut runs: Vec<_> = std::fs::read_dir(dir).ok()?.filter_map(|e| e.ok()).filter(|e| e.path().join("report.json").exists()).collect();
    runs.sort_by_key(|e| e.metadata().and_then(|m| m.modified()).ok());
    let text = std::fs::read_to_string(runs.last()?.path().join("report.json")).ok()?;
    serde_json::from_str(&text).ok()
}

/// Current git branch of the repository (None outside git).
pub fn branch(repo: &Path) -> Option<String> {
    let mut cmd = Command::new("git");
    cmd.args(["rev-parse", "--abbrev-ref", "HEAD"]).current_dir(repo).stdin(Stdio::null()).stderr(Stdio::null());
    #[cfg(windows)]
    { use std::os::windows::process::CommandExt; cmd.creation_flags(CHILD_FLAGS); }
    let out = cmd.output().ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_string()).filter(|b| !b.is_empty())
}

/// AI agents installed on this machine and their quota (`orqen usage --json`). Needs no repository.
pub fn usage(cli: &Cli) -> anyhow::Result<Value> { cli.json(&["usage", "--json"]) }

/// owner/name of the GitHub origin remote, to propose it.
pub fn github_origin(repo: &Path) -> Option<String> {
    let mut cmd = Command::new("git");
    cmd.args(["remote", "get-url", "origin"]).current_dir(repo).stdin(Stdio::null()).stderr(Stdio::null());
    #[cfg(windows)]
    { use std::os::windows::process::CommandExt; cmd.creation_flags(CHILD_FLAGS); }
    let out = cmd.output().ok()?;
    let url = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let rest = url.split("github.com").nth(1)?.trim_start_matches([':', '/']);
    Some(rest.trim_end_matches(".git").to_string()).filter(|r| r.contains('/'))
}
