#!/usr/bin/env bash
# Builds the ORQEN app and installs it where `orqen` looks for it:
#   macOS: ~/Applications/ORQEN.app    Linux: ~/.local/bin/orqen-desktop
# Requires Rust (https://rustup.rs). Linux also needs: libxkbcommon-dev libxkbcommon-x11-dev libwayland-dev
#   libfontconfig1-dev libvulkan-dev libx11-xcb-dev libxcb-xkb-dev (Debian/Ubuntu names) and a Vulkan driver.
set -euo pipefail
cd "$(dirname "$0")/.."
cargo build --release
if [[ "$(uname)" == "Darwin" ]]; then
  app="$HOME/Applications/ORQEN.app"
  mkdir -p "$app/Contents/MacOS"
  cp target/release/orqen-desktop "$app/Contents/MacOS/orqen-desktop"
  cat > "$app/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>ORQEN</string>
  <key>CFBundleIdentifier</key><string>com.telpin.orqen</string>
  <key>CFBundleExecutable</key><string>orqen-desktop</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict></plist>
PLIST
  echo "ORQEN installed in $app. Open a project folder and run: orqen"
else
  mkdir -p "$HOME/.local/bin"
  install -m 755 target/release/orqen-desktop "$HOME/.local/bin/orqen-desktop"
  echo "ORQEN installed in ~/.local/bin/orqen-desktop. Open a project folder and run: orqen"
fi
