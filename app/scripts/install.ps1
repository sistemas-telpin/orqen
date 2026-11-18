# Builds the ORQEN app and installs it where `orqen` looks for it:
#   %LOCALAPPDATA%\Programs\ORQEN\ORQEN.exe  (+ Start menu shortcut)
# Requires Rust (https://rustup.rs) with the MSVC toolchain (Visual Studio Build Tools, "Desktop development with C++").
$ErrorActionPreference = "Stop"
Set-Location (Split-Path -Parent $PSScriptRoot)

if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
  Write-Host "Falta Rust. Instalalo desde https://rustup.rs y abri una terminal nueva." -ForegroundColor Red; exit 1
}
# Rust on Windows needs the MSVC linker (link.exe) from the Visual Studio Build Tools.
$vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
$vc = if (Test-Path $vswhere) { & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath } else { $null }
if (-not $vc) {
  Write-Host "Faltan las herramientas de C++ de Visual Studio (link.exe). Instalalas con:" -ForegroundColor Red
  Write-Host '  Invoke-WebRequest https://aka.ms/vs/17/release/vs_BuildTools.exe -OutFile $env:TEMP\vs_BuildTools.exe'
  Write-Host '  Start-Process $env:TEMP\vs_BuildTools.exe -ArgumentList "--wait","--passive","--add","Microsoft.VisualStudio.Workload.VCTools","--includeRecommended" -Wait'
  Write-Host "y despues abri una terminal nueva y volve a correr este script."
  exit 1
}

cargo build --release
if ($LASTEXITCODE -ne 0) { Write-Host "La compilacion fallo (ver los errores de arriba)." -ForegroundColor Red; exit 1 }
$dest = Join-Path $env:LOCALAPPDATA "Programs\ORQEN"
New-Item -ItemType Directory -Force -Path $dest | Out-Null
Copy-Item "target\release\orqen-desktop.exe" (Join-Path $dest "ORQEN.exe") -Force
$lnk = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\ORQEN.lnk"
$s = (New-Object -ComObject WScript.Shell).CreateShortcut($lnk)
$s.TargetPath = Join-Path $dest "ORQEN.exe"
$s.Save()
Write-Host "ORQEN installed in $dest. Open a project folder and run: orqen"
