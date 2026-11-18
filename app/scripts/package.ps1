# CI: builds the app and leaves dist\orqen-app-win32-x64.tar.gz with ORQEN.exe (what `orqen` installs).
$ErrorActionPreference = "Stop"
Set-Location (Split-Path -Parent $PSScriptRoot)
cargo build --release
if ($LASTEXITCODE -ne 0) { exit 1 }
Remove-Item -Recurse -Force dist\pkg -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path dist\pkg | Out-Null
Copy-Item target\release\orqen-desktop.exe dist\pkg\ORQEN.exe
tar -czf dist\orqen-app-win32-x64.tar.gz -C dist\pkg ORQEN.exe
if ($LASTEXITCODE -ne 0) { exit 1 }
