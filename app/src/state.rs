//! What the app remembers between runs (~/.orqen/app-tabs.json): open tabs, the active one, and which CLI to run.
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::cli::Cli;

#[derive(Serialize, Deserialize, Default)]
pub struct AppState {
    #[serde(default)] pub tabs: Vec<PathBuf>,
    pub active: Option<PathBuf>,
    pub node: Option<PathBuf>,
    pub script: Option<PathBuf>,
}

pub fn home() -> PathBuf {
    std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")).map(PathBuf::from).unwrap_or_else(|| PathBuf::from("."))
}

pub fn dir() -> PathBuf { home().join(".orqen") }

pub fn load() -> AppState {
    std::fs::read_to_string(dir().join("app-tabs.json")).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

pub fn save(tabs: &[PathBuf], active: Option<&PathBuf>, base: &Cli) {
    let st = AppState { tabs: tabs.to_vec(), active: active.cloned(), node: base.node.clone(), script: base.script.clone() };
    let _ = std::fs::create_dir_all(dir());
    let _ = std::fs::write(dir().join("app-tabs.json"), serde_json::to_string_pretty(&st).unwrap_or_default());
}
