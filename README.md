# orqen — AI Software Factory KIT

**orqen** es un kit de orquestación multiagente y automatización del desarrollo de software, diseñado para coordinar el ciclo de vida de los proyectos desde la definición de requerimientos hasta su implementación y despliegue.

Construido como una capa superior a OpenSpec, propone integrar agentes especializados de inteligencia artificial, repositorios de código, herramientas de desarrollo, reglas de ingeniería y bases de conocimiento en un ecosistema unificado.

Su arquitectura busca permitir que múltiples agentes colaboren de manera coordinada en actividades de análisis, planificación, desarrollo, pruebas, validación y mantenimiento, bajo mecanismos de gobernanza, supervisión y trazabilidad.

Uno de sus pilares es el aprendizaje continuo a partir de la experiencia: aprovechar los resultados de desarrollos anteriores para enriquecer una base de conocimiento reutilizable y mejorar progresivamente los procesos de trabajo.

El análisis lo conduce un **analista** con el agente (`/orqen:analyze REC-1234`); el resto lo lleva el agente con aprobaciones humanas.

- **`AGENTS.md`**: lo que el agente lee. Explica el proceso y las reglas, y le dice que use la CLI `cli`.
- **`cli/`**: CLI en TypeScript (Node ≥ 20.12) que maneja la máquina de estados, Jira, git, tests y OpenSpec.
  Es determinística: el agente produce contenido y `cli` decide el flujo.
- **`orqen/.agents`**: recursos para agentes con los comandos `/orqen:analyze`, `/orqen:implement` y `/orqen:e2e-review`, y el skill `orqen:grilling`.
- **`orqen/work/<KEY>/`**: registro y estado de cada REC dentro del repo (lo escribe `orqen`).
- **`openspec/config.yaml`**: reglas del proceso REC aplicadas a los artefactos de OpenSpec.

## Análisis: `/orqen:analyze REC-1234`

```mermaid
flowchart TD
    A["/orqen:analyze REC-1234"] --> B["orqen analyze: reserva el REC,<br/>crea orqen/work/REC-1234/"]
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

| Carril                           | Cuándo (guía; ajustable en `cli/stages/analysis.md`)                                   | Qué se genera                                                                                            |
| -------------------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `direct`                         | Un componente, ≲ 4 h, sin cambio de contrato, bajo riesgo                              | **Sin OpenSpec.** `plan` + criterios de aceptación en el análisis y el SIS. Testing contra los criterios |
| `light`                          | Comportamiento observable acotado, 1–2 capacidades, ≲ 2 días                           | Change de OpenSpec compacto: proposal + deltas + tasks (design mínimo)                                   |
| `full`                           | Varias capacidades, datos/integraciones, seguridad/facturación, > 2 días, arquitectura | Change completo: proposal + specs + design + tasks                                                       |
| operativa (`route: operational`) | Se resuelve sin cambiar código (SQL, datos, reinicio, config)                          | Sin spec ni rama; flujo EXECUTION → aprobación → aplicación → verificación                               |

### Qué queda en `orqen/work/REC-1234/`

```
orqen/work/REC-1234/
├── state.json            proyección del estado (state, lane, sis, branch, change, analyst)
├── log.md            una línea por transición
└── round-1/
    ├── analysis.md        resumen, criterios, decisiones del grilling, carril y justificación, SIS, estimación
    ├── analysis.json      la salida validada de la etapa
    └── execution/         (solo carril operativo) script.sql, pasos, rollback, verificación
```

Se commitea con la rama del REC (`cli` commitea el registro en cada transición mientras esa rama está activa), así la
trazabilidad viaja con el código y la spec. La **fuente de verdad operativa** sigue en `cli/.state/` (ignorado por git);
`orqen/` es la proyección legible. Cada ronda nueva (rechazo de conformidad) agrega `round-2/`, etc.

## Implementación: `/orqen:implement SIS-442`

Toma el SIS que creó el análisis y ejecuta la etapa **DEVELOPMENT**: aplica la spec de OpenSpec si el carril la tiene
(`light` / `full`) o sigue el `plan` del análisis (`direct`). Acepta la key del SIS o la del REC; `cli` resuelve a qué REC
pertenece (el SIS vigente de la ronda actual).

```mermaid
flowchart TD
    A["/orqen:implement SIS-442"] --> B["orqen status SIS-442<br/>(resuelve SIS → REC y mira el estado)"]
    B -->|"no es DEVELOPMENT,<br/>o es vía operativa"| X(["Se explica qué etapa sigue<br/>y se corta sin reservar el REC"])
    B -->|"DEVELOPMENT"| C["orqen take SIS-442: reserva el REC,<br/>prepara la rama e imprime contexto + esquema"]
    C --> D{"Carril"}
    D -->|"liviano / completo"| E["Apply de OpenSpec<br/>(openspec-apply-change)<br/>proposal + design + specs + tasks<br/>→ tilda cada tarea en tasks.md"]
    D -->|"directo<br/>sin spec"| F["Implementa el plan del análisis<br/>en orden"]
    E --> G
    F --> G["Tests por cada Scenario / criterio de aceptación<br/>+ corre tests y linters"]
    G -->|"falla algo"| G
    G --> H["orqen complete SIS-442 salida.json<br/>(rechaza si quedan tareas sin tildar)"]
    H --> I(["TESTING<br/>una etapa por vez: el agente corta acá"])
    G -.->|"no se puede avanzar"| Z{{"orqen block SIS-442 'motivo'"}}
```

Mismas reglas que el análisis: Jira de solo lectura para el agente, sin `git commit/push/checkout`, sin `openspec archive`
y sin tocar `cli/.state/`, `orqen/work/` ni los scripts de `cli/`. Si el contexto trae un test fallido o un rechazo de revisión,
se corrige eso primero.

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
(barrera de proceso, no de seguridad). Los ajustes quedan sin commitear: hay que commitearlos en la rama del REC **antes de que se abra el PR**
(`orqen` abre el PR al aprobar `TESTING`).

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
    REV["CODE_REVIEW<br/>(senior)"]:::humano
    DELIVERY["DELIVERY"]:::agente
    CONF["ACCEPTANCE<br/>(cliente)"]:::humano
    CLOSED(["CLOSED"]):::final
    BLOQ{{"BLOCKED"}}:::bloq

    ANALYSIS <-->|preguntas / respuestas| ESPERA
    ANALYSIS -->|"OK analista: carril + SIS"| DESA
    DESA <-->|tests fallan / pasan| TEST
    TEST --> REV
    REV -->|/approve| DELIVERY
    REV -.->|/reject| DESA
    DELIVERY --> CONF
    CONF -->|/approve| CLOSED
    CONF -.->|"/reject: ronda 2"| ANALYSIS

    ANALYSIS & DESA & TEST & DELIVERY -.->|error / sin reintentos| BLOQ
    BLOQ -.->|"/approve &lt;indicaciones&gt;"| ANALYSIS
```

**Azul**: etapas del agente · **Amarillo**: gates humanos en Jira · **Rojo**: bloqueado (lo destraba una persona).
Jira, git, PR y `openspec archive` los ejecuta solo `orqen`; el agente produce contenido.
Desaparecieron los gates `APROBACION_ANALISIS` y `APROBACION_SPEC`: el OK del analista en el grilling los reemplaza
(y por eso `APPROVERS_SPEC` ya no existe).

| Estado         | Quién             | Qué pasa                                                                                                     | OpenSpec                                                                                                                                                      |
| -------------- | ----------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ANALYSIS       | analista + agente | grilling → OK → carril → spec (si corresponde) → SIS vinculado al REC                                        | lee `openspec/specs`; liviano/completo: `orqen lane` crea el change y `orqen complete` exige `validate --strict`, artefactos completos y `(Nh)` en cada tarea |
| WAITING_CLIENT | cliente           | responde en Jira (máx. 3 rondas)                                                                             | —                                                                                                                                                             |
| DEVELOPMENT    | agente            | implementa; con spec tilda `tasks.md`, en directo sigue el `plan`                                            | flujo _apply_; `orqen` rechaza si queda alguna tarea sin tildar                                                                                               |
| TESTING        | `orqen` + agente  | `orqen` corre la suite y el agente mapea test ↔ **cada Scenario** (directo: cada **criterio de aceptación**) | si falta alguno, se rechaza                                                                                                                                   |
| CODE_REVIEW    | senior            | revisa el PR (cuerpo = `proposal.md`, o `analysis.md` en directo)                                            | —                                                                                                                                                             |
| DELIVERY       | `orqen` + agente  | `orqen` archiva (si hubo spec) y el agente escribe notas y mensaje al cliente                                | `openspec archive` fusiona los deltas en `openspec/specs` dentro del mismo PR                                                                                 |
| ACCEPTANCE     | cliente           | `/approve` cierra; `/reject` abre la ronda 2 (vuelve a ANALYSIS: nuevo carril, change y SIS)                 | nuevo change `…-r2`                                                                                                                                           |

Si se agotan los reintentos o hay un error, el REC pasa a **BLOCKED**. Una persona destraba con `/approve <indicaciones>`
(`APPROVERS_ANALYSIS` + `APPROVERS_CODE`).

## Instalación en un repo

```sh
# 1. copiar AGENTS.md (o fusionarlo con el existente), CLAUDE.md, cli/ y orqen/ en la raíz del repo
npm ci --prefix cli
npm i -g @fission-ai/openspec            # o definir OPENSPEC_CMD
openspec init --tools claude,codex,cursor --language es   # elegí las herramientas del equipo
#    → después fusioná template/openspec/config.yaml con openspec/config.yaml
cp cli/.env.example cli/.env              # Jira, SIS, aprobadores, comando de tests, AGENT_CMD
echo "cli/.state/" >> .gitignore         # orqen/work/ NO se ignora: es el registro versionado
```

**Plugin para Claude Code** (da `/orqen:analyze`, `/orqen:implement`, `/orqen:e2e-review` y el skill de grilling), una vez por analista:

```
/plugin marketplace add ./          # raíz de este repo (tiene .claude-plugin/marketplace.json); o la URL git del kit
/plugin install orqen@orqen
```

Recomendado: conectar también el MCP de Atlassian/Jira para que el grilling lea el REC y los relacionados. Es solo lectura:
las escrituras las hace `orqen` con `JIRA_TOKEN`. `openspec init --tools …` instala los skills/comandos de OpenSpec
(_propose_, _apply_…) y las guías de etapa los usan si existen (si no, recurren a `openspec instructions`).

## Uso

**Análisis (analista)**: en Claude Code, `/orqen:analyze REC-1234`. En otro agente: _"analizá el REC-1234"_ (el agente lee
`AGENTS.md` y corre `orqen analyze` → grilling → `orqen lane` → `orqen complete`).

**Implementación**: en Claude Code, `/orqen:implement SIS-442`. En otro agente: _"implementá el SIS-442"_ (`orqen status` → `orqen take` →
apply de la spec o plan → `orqen complete`). `take`, `complete`, `status`, `block` y `release` aceptan la key del SIS o la del REC.

**Validación de e2e**: en Claude Code, `/orqen:e2e-review SIS-3312`, a cargo del diseñador de testing e2e. En otro agente: _"preparame la revisión de e2e del SIS-3312"_ (el agente lee `AGENTS.md`).

**Resto de las etapas, interactivo**: _"procesá el REC REC-123"_ → `orqen take` → trabaja → `orqen complete`.

**Desatendido** (cron, CI o servidor), solo etapas de agente — **nunca** ANALYSIS:

```sh
./cli/bin/orqen cycle --loop     # cada REC_INTERVAL_SEC: avanza gates y lanza AGENT_CMD por REC pendiente
```

Para cambiar de agente alcanza con cambiar `AGENT_CMD`, por ejemplo a `codex exec --full-auto {prompt}`.

Otros comandos: `orqen pending` (separa _para analizar_ de _para un agente_), `orqen status [KEY]`, `orqen schema <ETAPA>`,
`orqen block`, `orqen release`, `orqen search <JQL>`. Los REC nuevos ya no se toman solos: quedan en NEW hasta que un analista corre `analyze`.

## Garantías y límites

- Las salidas se validan con zod y con OpenSpec. Si algo no cumple, el agente recibe la lista de errores y reintenta. Nada avanza a medias:
  el SIS no se crea hasta que el análisis (y la spec) están validados, y si Jira falla a mitad de camino, repetir `complete` retoma sin duplicar.
- El OK del analista es un campo obligatorio de la salida (`analyst_ok`), pero **lo declara el agente**: `orqen` no puede comprobar que la persona
  lo haya dado. Es una barrera de proceso, no de seguridad.
- Hay un lock por REC (vence a los `REC_LOCK_MIN`, pero el mismo agente puede completar igual si nadie más lo tomó, porque el grilling puede ser largo).
- Jira, git, PR y archive los ejecuta **solo** `orqen`. El agente tiene esa prohibición en `AGENTS.md`, pero
  al ser agnóstico **no hay un hook que lo impida a la fuerza**. Hay que reforzarlo con el sandbox o los permisos de
  cada herramienta (por ejemplo, denegar `git push` en `.claude/settings.json`, o permitir del MCP de Jira solo las herramientas de lectura).
- El estado vive en `cli/.state/*.json` (ignorado por git, sobrevive a los cambios de rama) y en labels de Jira `rec-estado-*`; `orqen/work/<KEY>/` es su proyección versionada.
- Usa un solo checkout, así que procesa un REC por vez por clon. Para trabajar en paralelo: un clon o worktree por agente.

## Tests

```sh
cd cli && npm test        # e2e con OpenSpec y git reales + gates, carriles y SIS con fakes
npm run typecheck
```
