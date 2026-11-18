//! ORQEN brand: navy background, electric blue, vivid magenta; Inter/Sora when installed, otherwise the system font.
use gpui::{Hsla, Rgba, rgb};

pub const BG: u32 = 0x07090F;
pub const PANEL: u32 = 0x0B0F18;
pub const SIDEBAR: u32 = 0x0A0E16;
pub const SURFACE: u32 = 0x0E1320;
pub const SURFACE_2: u32 = 0x121A2C;
pub const HOVER: u32 = 0x121826;
pub const BORDER: u32 = 0x1C2333;
pub const BORDER_2: u32 = 0x252E42;
pub const TEXT: u32 = 0xF4F6FA;
pub const TEXT_2: u32 = 0xCBD5E1;
pub const MUTED: u32 = 0x94A3B8;
pub const DIM: u32 = 0x7C8BA3;
pub const BLUE: u32 = 0x2563FF;
pub const BLUE_TEXT: u32 = 0x7FA6FF;
pub const MAGENTA: u32 = 0xFF2D9A;
pub const MAGENTA_TEXT: u32 = 0xFF6BB5;
pub const GREEN: u32 = 0x34D399;
pub const AMBER: u32 = 0xF5B04C;
pub const VIOLET: u32 = 0xB9A4FF;
pub const RED: u32 = 0xFF8C8C;

pub fn c(hex: u32) -> Rgba { rgb(hex) }
pub fn h(hex: u32) -> Hsla { rgb(hex).into() }

/// UI font: Inter if the person has it, otherwise the system font.
pub const UI_FONT: &str = ".SystemUIFont";
#[cfg(target_os = "windows")]
pub const MONO_FONT: &str = "Consolas";
#[cfg(target_os = "macos")]
pub const MONO_FONT: &str = "Menlo";
#[cfg(not(any(target_os = "windows", target_os = "macos")))]
pub const MONO_FONT: &str = "DejaVu Sans Mono";

/// Color of each stage of the process.
pub fn stage_color(state: &str) -> u32 {
    match state {
        "NEW" => MUTED,
        "SUPPORT" => 0x5EEAD4,
        "ANALYSIS" | "WAITING_CLIENT" => BLUE_TEXT,
        "DEVELOPMENT" => VIOLET,
        "TESTING" => AMBER,
        "CODE_REVIEW" => MAGENTA_TEXT,
        "DELIVERY" | "ACCEPTANCE" | "CLOSED" => GREEN,
        "BLOCKED" => RED,
        _ => 0xFDBA74,
    }
}

pub fn stage_name(state: &str, es: bool) -> &'static str {
    match (state, es) {
        ("NEW", true) => "Nuevo", ("NEW", false) => "New",
        ("SUPPORT", true) => "Soporte", ("SUPPORT", false) => "Support",
        ("ANALYSIS", true) => "Análisis", ("ANALYSIS", false) => "Analysis",
        ("WAITING_CLIENT", true) => "Espera al cliente", ("WAITING_CLIENT", false) => "Waiting for client",
        ("DEVELOPMENT", true) => "Desarrollo", ("DEVELOPMENT", false) => "Development",
        ("TESTING", _) => "Testing",
        ("CODE_REVIEW", _) => "Code review",
        ("DELIVERY", true) => "Entrega", ("DELIVERY", false) => "Delivery",
        ("ACCEPTANCE", true) => "Conformidad", ("ACCEPTANCE", false) => "Acceptance",
        ("CLOSED", true) => "Cerrado", ("CLOSED", false) => "Closed",
        ("BLOCKED", true) => "Bloqueado", ("BLOCKED", false) => "Blocked",
        ("EXECUTION", true) => "Ejecución", ("EXECUTION", false) => "Execution",
        ("EXECUTION_APPROVAL", true) => "Aprobación", ("EXECUTION_APPROVAL", false) => "Approval",
        ("APPLICATION", true) => "Aplicación", ("APPLICATION", false) => "Application",
        ("VERIFICATION", true) => "Verificación", ("VERIFICATION", false) => "Verification",
        _ => "—",
    }
}
