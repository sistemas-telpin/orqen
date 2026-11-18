//! Icons embedded in the binary (24×24, stroke = currentColor; GPUI paints them with text_color).
use std::borrow::Cow;

use anyhow::Result;
use gpui::{AssetSource, SharedString};

macro_rules! icons {
    ($($name:literal => $body:literal),* $(,)?) => {
        const ICONS: &[(&str, &str)] = &[$(($name, concat!(
            r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="black" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">"#,
            $body, "</svg>"))),*];
    };
}

icons! {
    "icons/pending.svg" => r#"<path d="M4 6h16M4 12h16M4 18h10"/>"#,
    "icons/env.svg" => r#"<rect x="3" y="4" width="18" height="6" rx="2"/><rect x="3" y="14" width="18" height="6" rx="2"/><path d="M7 7h.01M7 17h.01"/>"#,
    "icons/swarm.svg" => r#"<circle cx="5" cy="12" r="2.5"/><circle cx="19" cy="6" r="2.5"/><circle cx="19" cy="18" r="2.5"/><path d="M7.5 11 16.5 7M7.5 13l9 4"/>"#,
    "icons/plug.svg" => r#"<path d="M9 7V3M15 7V3M7 7h10v4a5 5 0 0 1-10 0z"/><path d="M12 16v5"/>"#,
    "icons/tutorial.svg" => r#"<path d="M2 7l10-4 10 4-10 4z"/><path d="M6 9v5c0 2 3 4 6 4s6-2 6-4V9"/>"#,
    "icons/search.svg" => r#"<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>"#,
    "icons/check.svg" => r#"<path d="m5 12 5 5 9-10"/>"#,
    "icons/x.svg" => r#"<path d="M6 6l12 12M18 6 6 18"/>"#,
    "icons/alert.svg" => r#"<circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/>"#,
    "icons/spinner.svg" => r#"<path d="M12 3a9 9 0 0 1 9 9"/>"#,
    "icons/refresh.svg" => r#"<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 5v6h-6"/>"#,
    "icons/copy.svg" => r#"<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/>"#,
    "icons/play.svg" => r#"<path d="M7 5v14l11-7z"/>"#,
    "icons/stop.svg" => r#"<rect x="6" y="6" width="12" height="12" rx="2"/>"#,
    "icons/arrow.svg" => r#"<path d="M5 12h14M13 6l6 6-6 6"/>"#,
    "icons/chevron.svg" => r#"<path d="m9 6 6 6-6 6"/>"#,
    "icons/folder.svg" => r#"<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>"#,
    "icons/terminal.svg" => r#"<path d="m4 17 6-5-6-5M12 19h8"/>"#,
    "icons/lock.svg" => r#"<rect x="4" y="10" width="16" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>"#,
    "icons/branch.svg" => r#"<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="8" r="2"/><path d="M6 7v10M18 10c0 4-6 3-12 7"/>"#,
    "icons/gear.svg" => r#"<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>"#,
    "icons/win-min.svg" => r#"<path d="M5 12h14"/>"#,
    "icons/win-max.svg" => r#"<rect x="5" y="5" width="14" height="14" rx="1"/>"#,
    "icons/win-restore.svg" => r#"<rect x="5" y="8" width="11" height="11" rx="1"/><path d="M8 8V5h11v11h-3"/>"#,
    "icons/dot.svg" => r#"<circle cx="12" cy="12" r="4" fill="black"/>"#,
}

pub struct Assets;

impl AssetSource for Assets {
    fn load(&self, path: &str) -> Result<Option<Cow<'static, [u8]>>> {
        Ok(ICONS.iter().find(|(p, _)| *p == path).map(|(_, svg)| Cow::Borrowed(svg.as_bytes())))
    }
    fn list(&self, path: &str) -> Result<Vec<SharedString>> {
        Ok(ICONS.iter().filter(|(p, _)| p.starts_with(path)).map(|(p, _)| SharedString::from(*p)).collect())
    }
}
