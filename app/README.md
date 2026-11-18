# ORQEN app (escritorio)

App de escritorio de ORQEN hecha en Rust con [GPUI](https://gpui.rs) (el framework de Zed). Funciona en Windows, macOS y Linux.

- **No tiene lógica propia**: todo lo lee y lo hace la CLI (`orqen status --json`, `pending --json`, `env status --json`, `connectors --json`, `tutorial --step N --json`, `env up/down`). La app solo lo muestra.
- **Se abre con `orqen`** (sin argumentos) desde la carpeta de un proyecto. La CLI le pasa `--repo <carpeta> --cli <dist/index.js> --node <node>`, así la app usa la misma CLI aunque no esté en el PATH.
- Al abrir, el logo se dibuja trazo a trazo (lo hace la app, no la terminal).

## Cómo se usa

- **Una pestaña por proyecto** (como Fork). `orqen` en la carpeta de un proyecto abre la app o, si ya está abierta, le agrega esa pestaña (una sola ventana). El `+` abre otra carpeta. Las pestañas se recuerdan (`~/.orqen/app-tabs.json`).
- En cada proyecto: Pendientes (lista por etapa, detalle con el recorrido y qué comando sigue, para copiar) · Entornos (procesos, levantar/apagar, log en vivo) · Enjambre (última corrida de `orqen swarm`).
- Barra de abajo: **Configuración** (Conectores y Tutorial del proyecto) y las **cuotas de IA** de la máquina (`orqen usage --json`: Claude Code y Codex con el % usado de cada ventana y cuándo se reinicia).
- Botones de minimizar / maximizar / cerrar propios (la barra del sistema está oculta); en macOS, los semáforos del sistema.

## Instalar

Requisito: Rust (https://rustup.rs). En Windows, además, Visual Studio Build Tools con "Desarrollo de escritorio con C++".

```powershell
# Windows → %LOCALAPPDATA%\Programs\ORQEN\ORQEN.exe
powershell -ExecutionPolicy Bypass -File app\scripts\install.ps1
```

```sh
# macOS → ~/Applications/ORQEN.app · Linux → ~/.local/bin/orqen-desktop
app/scripts/install.sh
```

Después, en la carpeta de un proyecto con orqen: `orqen`. Para otra ubicación: `ORQEN_APP=<ruta al ejecutable>`.

## Desarrollo

```sh
cd app
cargo run -- --repo ../ruta/a/un/proyecto     # usa `orqen` del PATH
RUST_LOG=info cargo run -- --repo …            # con logs
```

- `src/app.rs`: vista principal y pantallas · `src/cli.rs`: llamadas a la CLI · `src/logo.rs`: el logo animado · `src/theme.rs`: colores de marca · `src/assets.rs`: íconos embebidos.
- `patches/xattr`: `xattr 0.2.3` (dependencia de gpui) usa `libc::ENOATTR`, que la libc reciente ya no exporta en Linux. Se puede sacar cuando gpui actualice esa dependencia.
- La primera compilación tarda (GPUI tiene muchas dependencias); las siguientes son rápidas.
