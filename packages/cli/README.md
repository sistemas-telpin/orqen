# orqen — CLI

```sh
pnpm add -g orqen        # o: npm i -g orqen
orqen init                       # en la raíz del repo a inicializar
```

Es un paquete público de npm: no necesita token ni configuración.

## `orqen init`

1. Pantalla de bienvenida animada en loop a ~60 fps: el isotipo se dibuja por píxeles (el trazo se traza solo, el degradado gira,
   un cometa recorre el anillo y tres satélites orbitan) hasta presionar Enter; estático sin TTY, en CI, con `--yes` o `--sin-animacion`. Después chequea Node ≥ 20.12, git, pnpm/npm y Docker (Docker es opcional: si falta, avisa).
2. **Detección automática** del stack: manifiestos (`package.json`, `pom.xml`, `build.gradle`, `requirements.txt`,
   `pyproject.toml`, `*.csproj`, `go.mod`, `composer.json`, `Gemfile`), Dockerfiles, `docker-compose` existentes,
   Prisma, `.env.example` y dependencias que delatan servicios (Postgres, MySQL, SQL Server, Mongo, Redis, RabbitMQ, Kafka…).
3. **Análisis con IA (rápido)**: arma un resumen del repo (árbol + archivos clave recortados) y se lo pasa en un solo
   turno al agente instalado, con su modelo más veloz (`claude -p --model haiku`, `codex exec`, `gemini`). Corre en
   **segundo plano** mientras se resuelve OpenSpec, así que casi no se espera. La propuesta se valida con zod.
   Si hace falta más precisión: `--profundo`, o la opción "Que el agente explore el repo a fondo" al revisar el stack
   (el agente recorre el repo con sus herramientas; tarda minutos).
4. Muestra el stack y deja aceptarlo o ajustarlo (componentes, servicios, comandos de tests, migraciones y seed).
5. **OpenSpec**: detecta si está y qué versión. Si falta o no es compatible (orqen requiere `>=2.0.0 <3`), lo instala como
   devDependency del repo (o global si el repo no es Node) y corre `openspec init --tools … --language es`.
6. Pide los datos de `.orqen/.env` (URL, tipo, usuario y token de Jira, proyectos REC y SIS, y opcionalmente los aprobadores)
   y genera el archivo. No se commitea. Con `--yes` lo genera con valores de ejemplo; si ya existe, pregunta antes de tocarlo.
7. Escribe:
   - `orqen.yaml`: configuración (stack, entornos, versión del kit, agente, OpenSpec);
   - `docker-compose.orqen.yml`: servicios con healthcheck y las apps bajo el perfil `apps`;
   - `AGENTS.md`: bloque administrado entre `<!-- orqen:inicio -->` y `<!-- orqen:fin -->` (lo demás es del equipo);
   - `CLAUDE.md` (`@AGENTS.md`), `.gitignore`, `.claude-plugin/marketplace.json`;
   - `.orqen/etapas/`, `.orqen/plugin/` (plugin de Claude Code), `.orqen/.env.example` y `.orqen/.env` (ignorado);
   - reglas del proceso REC fusionadas en `openspec/config.yaml` (sin borrar lo que haya);
   - `.orqen/manifest.json`: hash de cada archivo que escribió orqen (para que `update` sepa qué editó el equipo).

Opciones: `--yes` (sin preguntas; ante un conflicto deja la versión nueva al lado), `--sin-ia`, `--profundo`, `--sin-animacion`, `--agente "<cmd>"`,
`--herramientas claude,codex`, `--sin-openspec`. Si la terminal no es interactiva (CI), se comporta como `--yes`.

## `orqen update`

1. **CLI**: si hay una versión nueva de `orqen`, la instala (con pnpm o npm, según cómo se instaló) y pide volver a correr `orqen update`.
2. **OpenSpec**: si hay una versión compatible más nueva, la instala y corre `openspec update`.
3. **Kit**: los archivos que nadie tocó se reemplazan; los que el equipo editó muestran el diff y se elige
   *dejar la versión de orqen al lado* (`.orqen-nuevo`), *sobrescribir* o *mantener*.

No vuelve a explorar el stack ni regenera `docker-compose.orqen.yml` (para eso: `orqen init` otra vez).
Opciones: `--yes`, `--sin-cli`, `--sin-openspec`, `--sin-kit`.

## `orqen entorno`

Lo usan los agentes para no depender de una persona:

```sh
orqen entorno preparar                  # instala dependencias
orqen entorno levantar [--apps]         # docker compose up --wait + migraciones + seed
orqen entorno tests [unitarios|integracion|e2e|visual]
orqen entorno estado
orqen entorno bajar                     # down -v
```

Los tests corren con las variables de `entornos.variables` (ej. `DATABASE_URL` apuntando a `localhost`).

## Desarrollo

```sh
pnpm install
pnpm enlazar                                            # build + npm link: deja el comando `orqen` global apuntando a este código
pnpm test                                               # detección, compose, kit, agente (falso) y e2e de la CLI
pnpm typecheck && pnpm build
pnpm -r publish --access public                         # publica orqen-kit y orqen en npm (requiere `npm login`)
```
