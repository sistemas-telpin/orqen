# orqen — AI Software Factory KIT

**orqen** es un kit de orquestación multiagente y automatización del desarrollo de software, diseñado para coordinar el ciclo de vida de los proyectos desde la definición de requerimientos hasta su implementación y entrega.

Construido como una capa superior a OpenSpec, integra agentes especializados de inteligencia artificial, repositorios de código, herramientas de desarrollo, reglas de ingeniería y bases de conocimiento en un ecosistema unificado.

Su arquitectura permite que múltiples agentes colaboren de manera coordinada en actividades de análisis, planificación, desarrollo, pruebas, validación y mantenimiento, bajo mecanismos de gobernanza, supervisión y trazabilidad.

Uno de sus pilares es el aprendizaje continuo a partir de la experiencia: aprovechar los resultados de desarrollos anteriores para enriquecer una base de conocimiento reutilizable y mejorar progresivamente los procesos de trabajo.

El análisis lo conduce un **analista** con el agente (`/orqen:analyze REC-1234`); el resto lo lleva el agente con aprobaciones humanas.

| Quién              | Qué corre                                                                                                        |
| ------------------ | ---------------------------------------------------------------------------------------------------------------- |
| Analista           | `/orqen:analyze REC-1234`: analiza el REC, elige el carril, escribe la spec si hace falta y crea el SIS en Jira   |
| Agente             | `/orqen:implement SIS-442`: implementa la spec o el plan aprobado · `/orqen:pr SIS-442`: abre el PR a desarrollo |
| Diseñador de e2e   | `/orqen:e2e-review SIS-442`: valida visualmente los tests e2e                                                     |
| Senior             | `/orqen:code-review SIS-442`: revisa el PR con el agente antes de dar `/approve` o `/reject`                      |
| Modo desatendido   | `orqen cycle --loop`: avanza los gates y lanza las etapas de agente pendientes                                   |
| Aprobadores (Jira) | `/approve` o `/reject <motivo>` en el issue                                                                      |

## Componentes

- **CLI `orqen`** (paquete npm, Node ≥ 20.12): maneja la máquina de estados, Jira, git, los PRs, los entornos de prueba y OpenSpec.
  Es determinística: el agente produce contenido y `orqen` decide el flujo.
- **`AGENTS.md` / `CLAUDE.md`**: lo que lee el agente. Explican el proceso y las reglas, y le indican que use la CLI.
- **Plugin de Claude Code** (`orqen/plugin/`): los comandos `/orqen:analyze`, `/orqen:implement`, `/orqen:e2e-review`, `/orqen:pr` y `/orqen:code-review`, y el skill `orqen:grilling`.
- **`orqen/stages/`**: las guías de cada etapa (análisis, especificación, desarrollo, testing, entrega, ejecución y verificación). Se pueden editar.
- **`orqen/work/<KEY>/`**: registro y estado de cada REC dentro del repo (lo escribe `orqen`).
- **`openspec/config.yaml`**: reglas del proceso REC aplicadas a los artefactos de OpenSpec.

## Análisis: `/orqen:analyze REC-1234`

```mermaid
flowchart TD
    A["/orqen:analyze REC-1234"] --> B["orqen analyze: reserva el REC,<br/>carga el contexto y crea orqen/work/REC-1234/"]
    B --> C["Grilling con el analista<br/>(skill orqen:grilling + repo + Jira por MCP, solo lectura)"]
    C -->|"lo contesta el cliente"| W["WAITING_CLIENT"] -->|"responde"| C
    C -->|"OK del analista"| D{"Propuesta de carril<br/>(el analista confirma)"}
    D -->|"directo<br/>sin spec"| G
    D -->|"liviano / completo"| E["orqen lane: rama + change de OpenSpec<br/>→ el agente escribe la spec con el analista"] --> G
    D -->|"operativa<br/>(sin código)"| G
    G["orqen complete: valida · crea el SIS · lo vincula al REC<br/>· registra en orqen/work/ · commit de la spec"] --> H(["DEVELOPMENT · o EXECUTION si es operativa"])
```

El agente **no escribe en Jira** (el MCP es solo lectura): la creación del SIS, el vínculo `SIS ↔ REC`, los comentarios y los
labels los hace `orqen` en `complete`, solo si el análisis tiene el OK del analista y la spec (si hay) valida.

### Carriles

| Carril                           | Cuándo (guía; ajustable en `orqen/stages/analysis.md`)                                 | Qué se genera                                                                                            |
| -------------------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `direct`                         | Un componente, ≲ 4 h, sin cambio de contrato, bajo riesgo                              | **Sin OpenSpec.** `plan` + criterios de aceptación en el análisis y el SIS. Testing contra los criterios |
| `light`                          | Comportamiento observable acotado, 1–2 capacidades, ≲ 2 días                           | Change de OpenSpec compacto: proposal + deltas + tasks (design mínimo)                                   |
| `full`                           | Varias capacidades, datos/integraciones, seguridad/facturación, > 2 días, arquitectura | Change completo: proposal + specs + design + tasks                                                       |
| operativa (`route: operational`) | Se resuelve sin cambiar código (SQL, datos, reinicio, config)                          | Sin spec ni rama; flujo EXECUTION → aprobación → aplicación → verificación                               |

### Qué queda en `orqen/work/REC-1234/`

```
orqen/work/REC-1234/
├── state.json             proyección del estado (state, lane, sis, branch, change, analyst)
├── log.md                 una línea por transición
└── round-1/
    ├── analysis.md        resumen, criterios, decisiones del grilling, carril y justificación, SIS, estimación
    ├── analysis.json      la salida validada de la etapa
    ├── devel-pr.md        explicación del PR a desarrollo (orqen pr)
    ├── code-review-1.md   informes del code review para el senior (orqen review), uno por review
    └── execution/         (solo carril operativo) script.sql, pasos, rollback, verificación
```

Se commitea con la rama del REC (`orqen` commitea el registro en cada transición mientras esa rama está activa), así la
trazabilidad viaja con el código y la spec. La **fuente de verdad operativa** está en `orqen/state/` (ignorado por git);
`orqen/work/` es la proyección legible. Cada ronda nueva (rechazo de conformidad) agrega `round-2/`, etc.

## Implementación: `/orqen:implement SIS-442`

Toma el SIS que creó el análisis y ejecuta la etapa **DEVELOPMENT**: aplica la spec de OpenSpec si el carril la tiene
(`light` / `full`) o sigue el `plan` del análisis (`direct`). Acepta la key del SIS o la del REC; `orqen` resuelve a qué REC
pertenece (el SIS vigente de la ronda actual).

```mermaid
flowchart TD
    A["/orqen:implement SIS-442"] --> B["orqen status SIS-442<br/>(resuelve SIS → REC y mira el estado)"]
    B -->|"no es DEVELOPMENT,<br/>o es vía operativa"| X(["Se explica qué etapa sigue<br/>y se corta sin reservar el REC"])
    B -->|"DEVELOPMENT"| C["orqen take SIS-442: reserva el REC, prepara la rama,<br/>levanta el entorno e imprime contexto + esquema"]
    C --> D{"Carril"}
    D -->|"liviano / completo"| E["Apply de OpenSpec<br/>(openspec-apply-change)<br/>proposal + design + specs + tasks<br/>→ tilda cada tarea en tasks.md"]
    D -->|"directo<br/>sin spec"| F["Implementa el plan del análisis<br/>en orden"]
    E --> G
    F --> G["Tests por cada Scenario / criterio de aceptación<br/>+ orqen env test y linters"]
    G -->|"falla algo"| G
    G --> H["orqen complete SIS-442 salida.json<br/>(rechaza si quedan tareas sin tildar; baja el entorno)"]
    H --> I(["TESTING<br/>una etapa por vez: el agente corta acá"])
    G -.->|"no se puede avanzar"| Z{{"orqen block SIS-442 'motivo'"}}
```

El agente usa Jira solo para leer y no hace `git commit/push/checkout`, ni `openspec archive`, ni toca `orqen/state/`, `orqen/work/` ni la
configuración de `orqen`. Si el contexto trae un test fallido o un rechazo de revisión (`human_feedback`), se corrige eso primero.

## Testing

Es una etapa del agente, sin intervención humana. `orqen take` levanta el entorno completo (servicios y apps), corre la suite configurada y lo baja.
El agente mapea **cada Scenario** (carril directo: cada **criterio de aceptación**) contra el test que lo verifica, y `orqen` decide:
aprueba solo si la suite pasó y todo está cubierto. Si no, vuelve a DEVELOPMENT; al tercer intento fallido pasa a BLOCKED.

**Testing no abre ningún PR**: al aprobar, el REC pasa a CODE_REVIEW y el PR se abre con `/orqen:pr`.

## Revisión de e2e: `/orqen:e2e-review SIS-3312`

Los tests e2e se generan durante la implementación a partir de los Scenarios / criterios de aceptación. Este comando deja todo
listo para que el **diseñador de testing e2e** (una persona) los valide **visualmente** y **espera su aprobación**, con los ajustes
que haga a mano. No mueve el estado del REC (no hace `take` ni `complete`): se corre con el REC en `TESTING` o `CODE_REVIEW`,
parado en la rama del REC, y acepta la key del SIS o la del REC.

```mermaid
flowchart TD
    A["/orqen:e2e-review SIS-3312"] --> B["orqen status: ¿TESTING o CODE_REVIEW?<br/>¿rama del REC activa?"]
    B -->|"no"| X(["Se explica la etapa y se corta"])
    B -->|"sí"| C["Arma la lista de escenarios / criterios<br/>y los mapea contra los tests e2e de la rama"]
    C --> D["Deja listo el modo visual<br/>(headed / trace / video) + guía de revisión"]
    D --> E{"Diseñador e2e<br/>(revisa y ajusta a mano)"}
    E -->|"ajustó"| F["Re-corre los e2e y revisa el diff<br/>(¿siguen cubriendo todo?)"] --> E
    E -->|"rechaza"| R(["Qué corregir → DEVELOPMENT<br/>(lo decide una persona)"])
    E -->|"aprueba explícito + corrida en verde"| G(["Resumen listo para el PR/SIS<br/>→ sigue CODE_REVIEW"])
```

El agente **no edita los tests**: señala observaciones (escenarios sin e2e, tests que no verifican el THEN, esperas fijas) y el
diseñador decide. La aprobación la da la persona en la conversación; igual que el OK del analista, **`orqen` no puede comprobarla**
(barrera de proceso, no de seguridad). Los ajustes quedan sin commitear en la rama del REC: `orqen pr` los commitea y los empuja
con el PR a desarrollo (si el PR ya existía, hay que volver a correr `/orqen:pr` para sumarlos).

## PR a desarrollo: `/orqen:pr SIS-32`

Manda la rama del REC a la rama de integración (`DEVEL_BRANCH`, por defecto `desarrollo`) con un pull request cuya
descripción explica los cambios. Acepta la key del SIS o la del REC y se corre con el REC en `TESTING` o después (no en carril operativo).
Es el **único PR** del proceso: el senior hace el code review (CODE_REVIEW) sobre este PR.

```mermaid
flowchart TD
    A["/orqen:pr SIS-32"] --> B["orqen pr SIS-32<br/>(rama, base, análisis, change; ¿ya hay PR?)"]
    B -->|"todavía en desarrollo,<br/>operativo o desconocido"| X(["Se explica y se corta"])
    B -->|"ok"| R{"¿El repo está en<br/>la rama del REC?"}
    R -->|"no"| Y(["Se pide cambiar de rama y se corta<br/>(orqen no escribe nada)"])
    R -->|"sí"| C["El agente lee el diff contra la base,<br/>el análisis y la spec/plan"]
    C --> D["Escribe la explicación (.md):<br/>resumen · cambios · desvíos · tests · cómo verificar · riesgos"]
    D --> E["orqen pr SIS-32 explicación.md<br/>guarda devel-pr.md · commitea lo pendiente · push · abre el PR"]
    E --> F(["URL del PR, comentada en el REC y el SIS"])
```

El agente solo redacta: el commit, el push y el PR los hace `orqen` (`DEVEL_PR_COMMAND`, con `{base}`, `{branch}`, `{key}`, `{title}`, `{body}`).
La explicación queda en `orqen/work/<KEY>/round-N/devel-pr.md`. Es idempotente: si el PR ya existe, solo empuja los commits nuevos.
Como `orqen` commitea lo pendiente de la rama antes de empujar, los ajustes manuales (p. ej. los del diseñador de e2e) viajan con el PR.
Si el repo no está en la rama del REC, `orqen pr` falla antes de escribir, commitear o empujar nada.

## Code review: `/orqen:code-review SIS-32`

Lo corre el **senior** con el REC en `CODE_REVIEW` y el PR a desarrollo ya abierto. El agente revisa el diff del PR contra lo pedido
(análisis, spec o plan, Scenarios / criterios de aceptación, explicación del PR y convenciones del repo) y le devuelve un informe para decidir.
No mueve el estado: el `/approve` o `/reject` lo sigue dando el senior en Jira.

```mermaid
flowchart TD
    A["/orqen:code-review SIS-32"] --> B["orqen status + orqen pr<br/>¿CODE_REVIEW? ¿hay PR?"]
    B -->|"no"| X(["Se explica y se corta<br/>(sin PR: primero /orqen:pr)"])
    B -->|"sí"| C["Lee el diff del PR (origin/base...origin/rama)<br/>contra análisis, spec/plan y criterios"]
    C --> D["Verifica cada hallazgo<br/>(escenario concreto que falla)"]
    D --> E["Informe: veredicto · hallazgos con severidad, archivo:línea,<br/>qué pasa, por qué importa y posibles soluciones"]
    E --> R["orqen review SIS-32 informe.md --verdict …<br/>guarda code-review-n.md · lo comenta en el SIS"]
    R --> F{"Senior"}
    F -->|"/approve en Jira"| G(["DELIVERY"])
    F -->|"/reject con el texto que dejó listo el agente"| H(["DEVELOPMENT<br/>(los hallazgos llegan como feedback)"])
```

Es **solo lectura**: el agente no corrige código, no comenta ni aprueba el PR (solo `gh pr view` / `gh pr diff`) y no escribe en Jira.
Cada hallazgo tiene severidad (`blocking`, `important`, `minor` o `to verify`) y una a tres soluciones posibles, con la recomendada primero.
Si el veredicto no es aprobable, el agente deja redactado el texto del `/reject`.

Cuando el senior da el informe por cerrado, el agente lo registra con `orqen review <KEY> <informe.md> --verdict <approve|minor|reject>`
(solo en `CODE_REVIEW` y con el PR abierto). Queda en `orqen/work/<KEY>/round-N/code-review-<n>.md` (numerado: un segundo review después
de un `/reject` no pisa al primero), se commitea si el repo está en la rama del REC (viaja con el próximo push) y se comenta en el SIS.

## Flujo completo

```mermaid
flowchart LR
    classDef agente fill:#dbeafe,stroke:#2563eb,color:#1e3a8a
    classDef humano fill:#fef3c7,stroke:#d97706,color:#78350f
    classDef final fill:#dcfce7,stroke:#16a34a,color:#14532d
    classDef bloq fill:#fee2e2,stroke:#dc2626,color:#7f1d1d

    ANALYSIS["ANALYSIS<br/>(analista + agente)"]:::agente
    ESPERA["WAITING_CLIENT<br/>(máx. 3 rondas)"]:::humano
    DESA["DEVELOPMENT"]:::agente
    TEST["TESTING"]:::agente
    REV["CODE_REVIEW<br/>(senior + /orqen:code-review)"]:::humano
    DELIVERY["DELIVERY"]:::agente
    CONF["ACCEPTANCE<br/>(cliente)"]:::humano
    CLOSED(["CLOSED"]):::final
    BLOQ{{"BLOCKED"}}:::bloq

    ANALYSIS <-->|preguntas / respuestas| ESPERA
    ANALYSIS -->|"OK analista: carril + SIS"| DESA
    DESA <-->|tests fallan / pasan| TEST
    TEST -->|"/orqen:pr abre el PR"| REV
    REV -->|/approve| DELIVERY
    REV -.->|/reject| DESA
    DELIVERY --> CONF
    CONF -->|/approve| CLOSED
    CONF -.->|"/reject: ronda 2"| ANALYSIS

    ANALYSIS & DESA & TEST & DELIVERY -.->|error / sin reintentos| BLOQ
    BLOQ -.->|"/approve &lt;indicaciones&gt;:<br/>vuelve a la etapa donde se bloqueó"| ANALYSIS & DESA & TEST & DELIVERY
```

**Azul**: etapas del agente · **Amarillo**: gates humanos en Jira · **Rojo**: bloqueado (lo destraba una persona).
Jira, git, PR y `openspec archive` los ejecuta solo `orqen`; el agente produce contenido.

| Estado         | Quién             | Qué pasa                                                                                                      | OpenSpec                                                                                                                                                      |
| -------------- | ----------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ANALYSIS       | analista + agente | grilling → OK → carril → spec (si corresponde) → SIS vinculado al REC                                         | lee `openspec/specs`; liviano/completo: `orqen lane` crea el change y `orqen complete` exige `validate --strict`, artefactos completos y `(Nh)` en cada tarea |
| WAITING_CLIENT | cliente           | responde en Jira (máx. 3 rondas)                                                                              | —                                                                                                                                                             |
| DEVELOPMENT    | agente            | implementa con el entorno levantado; con spec tilda `tasks.md`, en directo sigue el `plan`                    | flujo _apply_; `orqen` rechaza si queda alguna tarea sin tildar                                                                                               |
| TESTING        | `orqen` + agente  | `orqen` corre la suite y el agente mapea test ↔ **cada Scenario** (directo: cada **criterio de aceptación**). No abre PR | si falta alguno, se rechaza                                                                                                                         |
| CODE_REVIEW    | senior            | revisa el PR a desarrollo (`/orqen:pr`) con el informe de `/orqen:code-review`                                | —                                                                                                                                                             |
| DELIVERY       | `orqen` + agente  | `orqen` archiva (si hubo spec) y el agente escribe notas y mensaje al cliente                                 | `openspec archive` fusiona los deltas en `openspec/specs` y se empuja a la rama del PR                                                                       |
| ACCEPTANCE     | cliente           | `/approve` cierra; `/reject` abre la ronda 2 (vuelve a ANALYSIS: nuevo carril, change y SIS)                  | nuevo change `…-r2`                                                                                                                                           |

Si se agotan los reintentos o hay un error, el REC pasa a **BLOCKED**. Una persona destraba con `/approve <indicaciones>`
(`APPROVERS_ANALYSIS` + `APPROVERS_CODE`): el REC vuelve a la etapa en la que se bloqueó, con los contadores de reintentos en cero
y las indicaciones como feedback para el agente.

**Carril operativo.** Si el REC se resuelve sin cambiar código, el flujo es
`ANALYSIS → EXECUTION → EXECUTION_APPROVAL → APPLICATION → VERIFICATION → ACCEPTANCE → CLOSED`: el agente propone el script, el rollback
y la verificación; una persona de `APPROVERS_EXECUTION` autoriza y aplica, y el agente verifica en solo lectura. Si la verificación muestra
que la causa es de código, el REC vuelve a ANALYSIS y nace un SIS de desarrollo.

## Instalación en un repo

```sh
npm i -g orqen          # o: pnpm add -g orqen (Node ≥ 20.12)
cd mi-repo
orqen init
```

`orqen init`:

1. Verifica Node, git, el gestor de paquetes y (opcional) Docker.
2. Detecta componentes y servicios del repo (`package.json`, `pom.xml`, `pyproject.toml`, Dockerfiles, Compose, Prisma, `.env.example`) y,
   si hay un agente de IA instalado, le pide que revise un resumen del repo (`--deep` para que lo explore entero, `--no-ai` para solo detección automática).
3. Te deja confirmar o editar componentes, servicios, tests, migraciones y seeds.
4. Instala OpenSpec (2.x) si hace falta y corre `openspec init` para las herramientas elegidas.
5. Pide la conexión a Jira, los proyectos REC y SIS y los aprobadores, y los guarda en `orqen/.env` (ignorado por git).
6. Escribe la configuración del entorno, `docker-compose.orqen.yml`, `AGENTS.md` / `CLAUDE.md`, el plugin, las guías de etapa y el manifiesto,
   y fusiona las reglas del proceso con el `openspec/config.yaml` existente.

Opciones: `--yes` (no interactivo), `--agent "<comando>"`, `--tools claude,codex`, `--no-openspec`.

**Plugin para Claude Code** (da los comandos `/orqen:*` y el skill de grilling), una vez por usuario:

```
/plugin marketplace add ./
/plugin install orqen@orqen
```

Recomendado: conectar también el MCP de Atlassian/Jira para que el grilling lea el REC y los relacionados. Es solo lectura:
las escrituras las hace `orqen` con `JIRA_TOKEN`.

**Actualizar** una instalación: `orqen update` busca una versión nueva de la CLI, de OpenSpec y del kit. Los archivos que no editaste se
actualizan solos; para los editados elegís conservar, reemplazar o dejar una copia `.orqen-new`. `--no-cli`, `--no-openspec` y `--no-kit` saltean pasos.

### Qué queda en el repo

| Ruta                             | Para qué                                                                                       |
| -------------------------------- | ---------------------------------------------------------------------------------------------- |
| `orqen/config.yaml`              | Stack, servicios, migraciones, tests, rama base y configuración del agente                     |
| `orqen/.env`                     | Credenciales de Jira, proyectos y aprobadores (local, ignorado por git)                        |
| `orqen/stages/`                  | Guías de cada etapa (editables)                                                                |
| `orqen/plugin/`                  | Comandos de Claude Code y el skill de grilling                                                 |
| `orqen/work/<KEY>/`              | Registro versionado de cada REC                                                                |
| `orqen/state/` y `orqen/tmp/`    | Estado operativo y temporales (ignorados por git)                                              |
| `orqen/manifest.json`            | Hashes de los archivos del kit, para que `orqen update` detecte tus cambios                    |
| `docker-compose.orqen.yml`       | Servicios con health checks y apps opcionales en el perfil `apps`                              |
| `AGENTS.md` y `CLAUDE.md`        | Instrucciones del proceso para los agentes                                                     |
| `openspec/`                      | Specs y configuración de OpenSpec                                                              |

### Variables principales de `orqen/.env`

| Variable                                                     | Para qué                                                                                   |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `JIRA_URL`, `JIRA_USER`, `JIRA_TOKEN`, `JIRA_DEPLOYMENT`      | Conexión a Jira (`cloud` o `server`)                                                       |
| `REC_JQL`                                                    | Qué REC procesa `orqen`                                                                    |
| `SIS_PROJECT`, `SIS_TYPE`, `SIS_LINK`, `SIS_TYPE_OPERATIONAL` | Cómo se crea y vincula el SIS                                                              |
| `JIRA_TRANSITIONS`, `SIS_TRANSITIONS`                        | Transiciones de Jira por estado                                                            |
| `APPROVERS_ANALYSIS`, `APPROVERS_CODE`, `APPROVERS_CLIENT`, `APPROVERS_EXECUTION` | Quién puede dar `/approve` y `/reject` en cada gate (vacío = cualquiera) |
| `BASE_BRANCH`, `TEST_COMMAND`                                | Rama base de las ramas de REC y suite por defecto (si `config.yaml` no define tests)       |
| `DEVEL_BRANCH`, `DEVEL_PR_COMMAND`                           | Rama de integración y comando que abre el PR (`orqen pr`)                                  |
| `AGENT_CMD`, `REC_INTERVAL_SEC`, `REC_LOCK_MIN`              | Agente del modo desatendido, intervalo del ciclo y vencimiento del lock por REC            |

## Entornos y tests

`orqen/config.yaml` define los entornos en `entornos` y `docker-compose.orqen.yml` los servicios.

- En **DEVELOPMENT**, `orqen take` instala dependencias, espera los health checks de los servicios y corre migraciones y seeds.
  El agente recibe en `environment` el estado, las variables de conexión y los comandos de test. `orqen complete` baja el entorno.
- En **TESTING**, `orqen` levanta servicios y apps, corre toda la suite configurada y baja todo.

```sh
orqen env setup                                    # instala dependencias
orqen env up [--apps]                              # servicios + migraciones + seeds
orqen env test [unitarios|integracion|e2e|visual]
orqen env status
orqen env down
```

## Uso

**Análisis (analista)**: en Claude Code, `/orqen:analyze REC-1234`. En otro agente: _"analizá el REC-1234"_ (el agente lee
`AGENTS.md` y corre `orqen analyze` → grilling → `orqen lane` → `orqen complete`).

**Implementación**: en Claude Code, `/orqen:implement SIS-442`. En otro agente: _"implementá el SIS-442"_ (`orqen status` → `orqen take` →
apply de la spec o plan → `orqen complete`).

**Validación de e2e**: en Claude Code, `/orqen:e2e-review SIS-3312`, a cargo del diseñador de testing e2e. En otro agente: _"preparame la revisión de e2e del SIS-3312"_.

**PR a desarrollo**: en Claude Code, `/orqen:pr SIS-32`. En otro agente: _"abrí el PR a desarrollo del SIS-32"_ (`orqen pr` → explicación → `orqen pr <KEY> <archivo.md>`).

**Code review**: en Claude Code, `/orqen:code-review SIS-32`, a cargo del senior. En otro agente: _"hacé el code review del PR del SIS-32"_.

**Resto de las etapas, interactivo**: _"procesá el REC REC-123"_ → `orqen take` → trabaja → `orqen complete`.

**Desatendido** (cron, CI o servidor), solo etapas de agente — **nunca** ANALYSIS:

```sh
orqen cycle --loop     # cada REC_INTERVAL_SEC: avanza gates y lanza AGENT_CMD por REC pendiente
```

Para cambiar de agente alcanza con cambiar `AGENT_CMD`, por ejemplo a `codex exec --full-auto {prompt}`.
Los REC nuevos no se toman solos: quedan en NEW hasta que un analista corre `analyze`.

### Comandos

```text
orqen init [dir]                       Inicializa un repo
orqen update [dir]                     Actualiza la CLI, OpenSpec y el kit

orqen env setup | up [--apps] | test [tipo] | status | down

orqen pending [--json]                 REC con trabajo: para analizar / para un agente
orqen analyze <KEY> [--analyst N]      Abre el análisis con un analista
orqen lane <KEY> <direct|light|full>   Registra el carril (light/full: rama + change de OpenSpec)
orqen take <KEY> [--agent N]           Reserva una etapa de agente y prepara rama y entorno
orqen complete <KEY> <salida.json|->   Valida la salida de la etapa y avanza el proceso
orqen pr <KEY> [<explicación.md>] [--title T]                     Sin archivo: informa. Con archivo: commit + push + PR a DEVEL_BRANCH
orqen review <KEY> <informe.md|-> --verdict <approve|minor|reject> Registra el informe del code review (CODE_REVIEW)
orqen status [KEY]                     Estado actual y log
orqen schema <ETAPA>                   JSON Schema de la salida de una etapa
orqen block <KEY> <motivo>             Escala a una persona
orqen release <KEY>                    Libera la reserva de un REC
orqen search <JQL>                     Busca issues (antecedentes / relacionados)
orqen cycle [--loop]                   Modo desatendido
```

`take`, `complete`, `status`, `block`, `release`, `pr` y `review` aceptan la key del REC o la de su SIS.

## Garantías y límites

- Las salidas se validan con zod y con OpenSpec. Si algo no cumple, el agente recibe la lista de errores y reintenta. Nada avanza a medias:
  el SIS no se crea hasta que el análisis (y la spec) están validados, y si Jira falla a mitad de camino, repetir `complete` retoma sin duplicar.
- El OK del analista es un campo obligatorio de la salida (`analyst_ok`), pero **lo declara el agente**: `orqen` no puede comprobar que la persona
  lo haya dado. Lo mismo pasa con la aprobación del diseñador de e2e. Son barreras de proceso, no de seguridad.
- Hay un lock por REC (vence a los `REC_LOCK_MIN`, pero el mismo agente puede completar igual si nadie más lo tomó, porque el grilling puede ser largo).
- Jira, git, PR y archive los ejecuta **solo** `orqen`. El agente tiene esa prohibición en `AGENTS.md`, pero
  al ser agnóstico **no hay un hook que lo impida a la fuerza**. Hay que reforzarlo con el sandbox o los permisos de
  cada herramienta (por ejemplo, denegar `git push` en `.claude/settings.json`, o permitir del MCP de Jira solo las herramientas de lectura).
- Nada obliga a abrir el PR antes del code review: el gate de CODE_REVIEW acepta `/approve` aunque no se haya corrido `/orqen:pr`.
- El estado vive en `orqen/state/` (ignorado por git, sobrevive a los cambios de rama) y en labels de Jira `rec-state-*`; `orqen/work/<KEY>/` es su proyección versionada.
- Usa un solo checkout, así que procesa un REC por vez por clon. Para trabajar en paralelo: un clon o worktree por agente.

## Desarrollo del kit

- [`cli/`](cli/README.md): la CLI (comandos, máquina de estados, entornos).
- `template/`: los archivos que instala `orqen init`.

```sh
cd cli
npm ci
npm run dev -- --help
npm test          # e2e con OpenSpec y git reales + gates, carriles, SIS y kit con fakes
npm run typecheck
npm run build
npm run setup     # compila y linkea la CLI local como `orqen`
```

El paquete `orqen` publicado incluye los templates. El workflow de release publica desde `cli/` cuando se empuja un tag de versión.
