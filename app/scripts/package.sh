#!/usr/bin/env bash
# CI: builds the app and leaves dist/orqen-app-<target>.tar.gz with what `orqen` installs.
#   darwin-*: ORQEN.app/    linux-*: orqen-desktop
set -euo pipefail
cd "$(dirname "$0")/.."
target="$1"
triple="${2:-}"
if [[ -n "$triple" ]]; then cargo build --release --target "$triple"; bin="target/$triple/release/orqen-desktop"; else cargo build --release; bin=target/release/orqen-desktop; fi
rm -rf dist/pkg && mkdir -p dist/pkg
case "$target" in
  darwin-*)
    app=dist/pkg/ORQEN.app
    mkdir -p "$app/Contents/MacOS"
    cp "$bin" "$app/Contents/MacOS/orqen-desktop"
    cat > "$app/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>ORQEN</string>
  <key>CFBundleIdentifier</key><string>com.telpin.orqen</string>
  <key>CFBundleExecutable</key><string>orqen-desktop</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>NSHighResolutionCapable</key><true/>
</dict></plist>
PLIST
    codesign --force --deep --sign - "$app" || true   # ad-hoc signature: Apple Silicon refuses unsigned binaries
    ;;
  *) install -m 755 "$bin" dist/pkg/orqen-desktop ;;
esac
tar -czf "dist/orqen-app-$target.tar.gz" -C dist/pkg .
echo "dist/orqen-app-$target.tar.gz"
