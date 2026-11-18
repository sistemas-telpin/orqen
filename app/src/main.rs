//! ORQEN desktop app. `orqen` (the CLI) opens it with `--repo <folder> --cli <dist/index.js> --node <node>`.
//! Each project is a tab; a second `orqen` adds its folder to the open window.
#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

mod agent;
mod assets;
mod cli;
mod connectors;
mod create;
mod figures;
mod general;
mod init;
mod input;
mod instance;
mod logo;
mod project;
mod shell;
mod splash;
mod state;
mod theme;
mod ui;

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use gpui::{App, AppContext as _, Application, Bounds, TitlebarOptions, WindowBounds, WindowDecorations, WindowOptions, point, px, size};

fn arg(name: &str) -> Option<String> {
    let args: Vec<String> = std::env::args().collect();
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned().filter(|v| !v.is_empty())
}

/// Run from `cargo run` (the exe is under app/target/…): use the CLI of this same repository (cli/dist/index.js) with
/// `node` from the PATH, so the app and the CLI being developed always match. The installed app is not affected.
fn dev_cli() -> Option<(PathBuf, PathBuf)> {
    let exe = std::env::current_exe().ok()?;
    let target = exe.ancestors().find(|p| p.file_name().map(|n| n == "target").unwrap_or(false))?;
    let script = target.parent()?.parent()?.join("cli").join("dist").join("index.js");
    script.is_file().then(|| (PathBuf::from("node"), script))
}

fn main() {
    let _ = env_logger::try_init();
    let saved = state::load();
    let repo = arg("--repo").map(PathBuf::from).map(|r| cli::find_repo(&r).unwrap_or(r));
    if let Some(r) = &repo { if instance::forward(r) { return; } }
    // which CLI: the one `orqen` passes (--cli/--node) > this repo's, when run from cargo > the last one used
    let dev = if arg("--cli").is_none() { dev_cli() } else { None };
    let base = cli::Cli {
        node: arg("--node").map(PathBuf::from).or(dev.as_ref().map(|d| d.0.clone())).or(saved.node.clone()),
        script: arg("--cli").map(PathBuf::from).or(dev.map(|d| d.1)).or(saved.script.clone()),
        repo: state::home(),
    };
    let tabs: Vec<PathBuf> = saved.tabs.into_iter().filter(|p| p.exists()).collect();
    let active = repo.or(saved.active);
    let inbox = Arc::new(Mutex::new(Vec::new()));
    instance::listen(inbox.clone());

    Application::new().with_assets(assets::Assets).run(move |cx: &mut App| {
        input::bind_keys(cx);
        let bounds = Bounds::centered(None, size(px(1360.), px(860.)), cx);
        let options = WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(bounds)),
            titlebar: Some(TitlebarOptions { title: Some("ORQEN".into()), appears_transparent: true, traffic_light_position: Some(point(px(14.), px(12.))) }),
            window_decorations: Some(WindowDecorations::Client),
            window_min_size: Some(size(px(960.), px(620.))),
            app_id: Some("orqen".into()),
            ..Default::default()
        };
        let (base, tabs, active, inbox) = (base.clone(), tabs.clone(), active.clone(), inbox.clone());
        cx.open_window(options, move |_, cx| cx.new(|cx| shell::Shell::new(base, tabs, active, inbox, cx))).expect("could not open the window");
        cx.on_window_closed(|cx| { if cx.windows().is_empty() { cx.quit(); } }).detach();
        cx.activate(true);
    });
}
