# orqen — AI Software Factory KIT

**orqen** es un kit de orquestación multiagente y automatización del desarrollo de software, diseñado para coordinar el ciclo de vida de los proyectos desde la definición de requerimientos hasta su implementación y entrega.

Construido como una capa superior a OpenSpec, integra agentes especializados de inteligencia artificial, repositorios de código, herramientas de desarrollo, reglas de ingeniería y bases de conocimiento en un ecosistema unificado.

Su arquitectura permite que múltiples agentes colaboren de manera coordinada en actividades de análisis, planificación, desarrollo, pruebas, validación y mantenimiento, bajo mecanismos de gobernanza, supervisión y trazabilidad.

Uno de sus pilares es el aprendizaje continuo a partir de la experiencia: aprovechar los resultados de desarrollos anteriores para enriquecer una base de conocimiento reutilizable y mejorar progresivamente los procesos de trabajo.

Opcionalmente, una persona de **soporte** atiende primero el reclamo con el agente (`/orqen:support SOP-1234`) e intenta responderle al cliente. Si no alcanza, lo escala al analista. El análisis lo conduce un **analista** con el agente (`/orqen:analyze SOP-1234`); el resto lo lleva el agente con aprobaciones humanas.

| Quién              | Qué corre                                                                                                        |
| ------------------ | ---------------------------------------------------------------------------------------------------------------- |
| Persona nueva      | `/orqen:tutorial` (o `orqen tutorial` en la terminal): 12 pasos cortos, en el idioma del sistema, con qué correr en cada etapa, cómo avanza un pedido y cómo mirar al agente y los entornos |
| Soporte (opcional) | `/orqen:support SOP-1234`: busca la respuesta, la redacta para el cliente y, si no se puede resolver, escala al analista con un resumen |
| Analista           | `/orqen:analyze SOP-1234`: analiza el pedido, elige el carril, escribe la spec si hace falta y crea el ticket interno (si hay)|
| Agente             | `/orqen:implement DEV-442`: implementa la spec o el plan aprobado · `/orqen:pr DEV-442`: abre el PR a desarrollo |
| Diseñador de e2e   | `/orqen:e2e-review DEV-442`: valida visualmente los tests e2e                                                     |
| Senior             | `/orqen:code-review DEV-442`: revisa el PR con el agente y después aprueba o pide cambios en GitHub               |
| Modo desatendido   | `orqen cycle --loop`: avanza los gates y lanza las etapas de agente pendientes                                   |
| Aprobadores        | `/approve` o `/reject <motivo>` en el issue (conformidad del cliente, carril operativo, destrabar un BLOCKED)    |

## Componentes

- **CLI `orqen`** (paquete npm, Node ≥ 20.12): maneja la máquina de estados, los tickets (conectores), git, los PRs, los entornos de prueba y OpenSpec.
  Es determinística: el agente produce contenido y `orqen` decide el flujo.
- **`AGENTS.md` / `CLAUDE.md`**: lo que lee el agente. Explican el proceso y las reglas, y le indican que use la CLI.
- **Plugin de Claude Code** (`orqen/plugin/`): los comandos `/orqen:tutorial`, `/orqen:support`, `/orqen:analyze`, `/orqen:implement`, `/orqen:e2e-review`, `/orqen:pr` y `/orqen:code-review`, y el skill `orqen:grilling`.
- **`orqen/stages/`**: las guías de cada etapa (soporte, análisis, especificación, desarrollo, testing, entrega, ejecución y verificación). Se pueden editar.
- **`orqen/work/<KEY>/`**: registro y estado de cada pedido dentro del repo (lo escribe `orqen`).
- **`openspec/config.yaml`**: reglas del proceso de pedidos aplicadas a los artefactos de OpenSpec.

## Tutorial para personas nuevas: `/orqen:tutorial`

Con el repo ya inicializado (`orqen init`), quien recién llega abre Claude Code en la carpeta y escribe `/orqen:tutorial`
(o `/orqen:tutorial env`, `/orqen:tutorial 4`… para ir directo a un paso). También anda sin Claude Code, en la terminal: `orqen tutorial`.

Son 12 pasos cortos, en palabras simples: bienvenida · 5 palabras que vas a escuchar · el camino de un pedido · **cómo se pasa a la etapa
siguiente** · ver qué hay para hacer · analizar · implementar · testing, PR y revisión · **mirar qué está haciendo el agente** ·
**mirar los entornos que levantó** · si algo sale mal · machete. Cada paso dice dónde se escribe cada cosa (`[Terminal]` o
`[Claude Code]`), qué va a pasar y cómo te das cuenta de que terminó.

- **El texto lo escribe orqen, no el agente**: está en la CLI (`cli/src/tutorial/content.ts`), así que es siempre el mismo y se puede corregir
  en un solo lugar. El comando de Claude Code corre `orqen tutorial --step <n> --json`, muestra el paso tal cual y ofrece los botones
  (siguiente, probalo, otro tema, salir). Si la persona pregunta algo, el agente contesta corto y vuelve al tutorial.
- **Con los datos del repo**: procesos, puertos y URLs de `orqen/config.yaml`, claves de ejemplo según los conectores (Jira, GitHub o Asana), si hay soporte,
  cómo se decide el code review y el comando para seguir un log en PowerShell (Windows) o bash. Nunca muestra secretos de `orqen/.env`.
- **"Probalo ahora"** solo corre comandos de lectura (`orqen status`, `orqen pending`, `orqen env status`, `git status`). Nunca toma ni cambia un pedido.

`orqen tutorial --list` lista los pasos y `orqen tutorial --step <n|id>` imprime uno.

## Idioma

orqen toma el idioma del sistema operativo: **español** si está en español, **inglés** para cualquier otro (en Windows, el idioma de
pantalla, `Get-UICulture`; en macOS, `AppleLanguages`; en Linux, `LC_ALL` / `LANG`). Se fuerza con `ORQEN_LANG=es` o `ORQEN_LANG=en`.

- El tutorial se muestra entero en ese idioma.
- Los agentes le hablan a la persona en ese idioma en todos los comandos `/orqen:*` (`orqen lang` lo imprime y el contexto de cada etapa lo trae
  como `language`). Comandos, estados y rutas quedan como están, y los artefactos (specs, salidas) siguen sus propias reglas.
- Los mensajes del resto de la CLI siguen en inglés.

## Soporte (opcional): `/orqen:support SOP-1234`

Es la etapa **antes del analista**: la persona que recibe el reclamo intenta responderle al cliente sin llegar a un análisis ni a
un desarrollo. `SUPPORT_STAGE` (en `orqen/.env`, apagada por defecto) solo decide si `orqen pending` manda los pedidos nuevos a soporte: con `on` aparecen primero ahí; con `off`, el flujo es el de siempre
(`NEW` → `ANALYSIS`).

```mermaid
flowchart TD
    A["/orqen:support SOP-1234"] --> B["orqen support: reserva el pedido (NEW → SUPPORT),<br/>carga el contexto y crea orqen/work/SOP-1234/"]
    B --> C["El agente busca la respuesta<br/>(reclamo, pedidos parecidos, specs, código; solo lectura)"]
    C --> D{"Resultado<br/>(lo acuerda la persona de soporte)"}
    D -->|"resuelto"| E["Redacta la respuesta al cliente<br/>→ la persona la aprueba"]
    D -->|"escalar"| F["Redacta el resumen para el analista<br/>→ la persona lo aprueba"]
    E --> G["orqen complete: valida · publica la respuesta en el ticket<br/>· registra support.md"] --> H(["ACCEPTANCE<br/>el cliente confirma con /approve o /reject"])
    F --> I["orqen complete: valida · comenta en el ticket<br/>· registra support.md"] --> J(["ANALYSIS<br/>el analista parte del resumen"])
```

**Quién y cómo.** La conduce una persona de soporte con el agente, igual que el análisis con el analista: el agente propone, la
persona decide. `orqen complete` rechaza la salida si falta el **OK explícito** de la persona (`support_ok`) sobre el resultado y sobre
el texto exacto que le llegará al cliente. No hay una lista de personas de soporte: puede tomarlo cualquiera.

| Resultado  | Cuándo                                                                                                                       | Qué pasa                                                                                                                                                       |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `resolved` | Se responde sin tocar código, datos ni configuración: una consulta de uso, una causa y solución conocidas, algo ya documentado | `orqen` publica la respuesta y el pedido pasa a **ACCEPTANCE**. **No se crea ticket interno.** Si el cliente hace `/reject <motivo>`, abre la ronda 2 y lo toma el analista |
| `escalate` | Pide algo nuevo, es un defecto que requiere código, una corrección de datos o de configuración, o no hay certeza de la respuesta | El pedido pasa a **ANALYSIS** con el `escalation_summary` (qué se sabe, qué se probó, qué falta). Se puede mandar además un acuse breve al cliente (opcional)    |

Ante la duda, **escalar**: una respuesta equivocada le cuesta una ronda al cliente; una escalación de más le cuesta unos minutos al
analista. El agente nunca promete fechas, alcance ni cambios al cliente.

**Qué no cambia.**

- El analista puede tomar un pedido `NEW` directamente con `orqen analyze`, sin pasar por soporte. También puede tomar uno en `SUPPORT`
  que nadie esté atendiendo; si hay una sesión de soporte activa, `orqen` se lo impide.
- El agente no escribe en el ticket: los comentarios los publica `orqen` en `complete`, solo con el OK de la persona.
- Es una etapa de persona: `orqen cycle` (modo desatendido) nunca la toma.

**Qué queda registrado.** `orqen/work/SOP-1234/round-1/support.md` (resultado, qué se revisó, respuesta al cliente y escalación) y
`support.json` (la salida validada). Cuando el analista abre el pedido escalado, recibe todo eso en `previous_stages.SUPPORT`, y la guía de
análisis le indica partir de ahí en vez de repetir el trabajo. La guía de la etapa está en `orqen/stages/support.md` y se puede editar.

`orqen pending` lista los pedidos para soporte aparte de los del analista y los del agente. Un pedido resuelto por soporte no tiene rama, así que su
registro en `orqen/work/` no se commitea solo (como pasa con el carril operativo).

## Análisis: `/orqen:analyze SOP-1234`

```mermaid
flowchart TD
    A["/orqen:analyze SOP-1234"] --> B["orqen analyze: reserva el pedido,<br/>carga el contexto y crea orqen/work/SOP-1234/"]
    B --> C["Grilling con el analista<br/>(skill orqen:grilling + repo + ticket por MCP, solo lectura)"]
    C -->|"lo contesta el cliente"| W["WAITING_CLIENT"] -->|"responde"| C
    C -->|"OK del analista"| D{"Propuesta de carril<br/>(el analista confirma)"}
    D -->|"directo<br/>sin spec"| G
    D -->|"liviano / completo"| E["orqen lane: rama + change de OpenSpec<br/>→ el agente escribe la spec con el analista"] --> G
    D -->|"operativa<br/>(sin código)"| G
    G["orqen complete: valida · crea el ticket interno · lo vincula al pedido<br/>· registra en orqen/work/ · commit de la spec"] --> H(["DEVELOPMENT · o EXECUTION si es operativa"])
```

El agente **no escribe en el ticket** (el MCP es solo lectura): la creación del ticket interno, el vínculo entre el interno y el externo, los comentarios y los
labels los hace `orqen` en `complete`, solo si el análisis tiene el OK del analista y la spec (si hay) valida.

### Carriles

| Carril                           | Cuándo (guía; ajustable en `orqen/stages/analysis.md`)                                 | Qué se genera                                                                                            |
| -------------------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `direct`                         | Un componente, ≲ 4 h, sin cambio de contrato, bajo riesgo                              | **Sin OpenSpec.** `plan` + criterios de aceptación en el análisis y el ticket interno. Testing contra los criterios |
| `light`                          | Comportamiento observable acotado, 1–2 capacidades, ≲ 2 días                           | Change de OpenSpec compacto: proposal + deltas + tasks (design mínimo)                                   |
| `full`                           | Varias capacidades, datos/integraciones, seguridad/facturación, > 2 días, arquitectura | Change completo: proposal + specs + design + tasks                                                       |
| operativa (`route: operational`) | Se resuelve sin cambiar código (SQL, datos, reinicio, config)                          | Sin spec ni rama; flujo EXECUTION → aprobación → aplicación → verificación                               |

### Qué queda en `orqen/work/SOP-1234/`

```
orqen/work/SOP-1234/
├── state.json             proyección del estado (state, lane, sis, branch, change, analyst)
├── log.md                 una línea por transición
└── round-1/
    ├── support.md         (solo con soporte) resultado, qué se revisó, respuesta al cliente y escalación
    ├── support.json       la salida validada de soporte
    ├── analysis.md        resumen, criterios, decisiones del grilling, carril y justificación, ticket interno, estimación
    ├── analysis.json      la salida validada de la etapa
    ├── devel-pr.md        explicación del PR a desarrollo (orqen pr)
    ├── code-review-1.md   informes del code review para el senior (orqen review), uno por review
    └── execution/         (solo carril operativo) script.sql, pasos, rollback, verificación
```

Se commitea con la rama del pedido (`orqen` commitea el registro en cada transición mientras esa rama está activa), así la
trazabilidad viaja con el código y la spec. La **fuente de verdad operativa** está en `orqen/state/` (ignorado por git);
`orqen/work/` es la proyección legible. Cada ronda nueva (rechazo de conformidad) agrega `round-2/`, etc.

## Implementación: `/orqen:implement DEV-442`

Toma el ticket interno que creó el análisis y ejecuta la etapa **DEVELOPMENT**: aplica la spec de OpenSpec si el carril la tiene
(`light` / `full`) o sigue el `plan` del análisis (`direct`). Acepta la clave del ticket interno o la del externo; `orqen` resuelve a qué pedido
pertenece (el ticket interno vigente de la ronda actual).

```mermaid
flowchart TD
    A["/orqen:implement DEV-442"] --> B["orqen status DEV-442<br/>(resuelve interno → pedido y mira el estado)"]
    B -->|"no es DEVELOPMENT,<br/>o es vía operativa"| X(["Se explica qué etapa sigue<br/>y se corta sin reservar el pedido"])
    B -->|"DEVELOPMENT"| C["orqen take DEV-442: reserva el pedido, prepara la rama,<br/>levanta el entorno e imprime contexto + esquema"]
    C --> D{"Carril"}
    D -->|"liviano / completo"| E["Apply de OpenSpec<br/>(openspec-apply-change)<br/>proposal + design + specs + tasks<br/>→ tilda cada tarea en tasks.md"]
    D -->|"directo<br/>sin spec"| F["Implementa el plan del análisis<br/>en orden"]
    E --> G
    F --> G["Tests por cada Scenario / criterio de aceptación<br/>+ orqen env test y linters"]
    G -->|"falla algo"| G
    G --> H["orqen complete DEV-442 salida.json<br/>(rechaza si quedan tareas sin tildar; baja el entorno)"]
    H --> I(["TESTING<br/>una etapa por vez: el agente corta acá"])
    G -.->|"no se puede avanzar"| Z{{"orqen block DEV-442 'motivo'"}}
```

El agente usal ticket solo para leer y no hace `git commit/push/checkout`, ni `openspec archive`, ni toca `orqen/state/`, `orqen/work/` ni la
configuración de `orqen`. Si el contexto trae un test fallido o un rechazo de revisión (`human_feedback`), se corrige eso primero.

## Testing

Es una etapa del agente, sin intervención humana. `orqen take` levanta todos los procesos del proyecto (también el front), corre la suite configurada y los corta.
El agente mapea **cada Scenario** (carril directo: cada **criterio de aceptación**) contra el test que lo verifica, y `orqen` decide:
aprueba solo si la suite pasó y todo está cubierto. Si no, vuelve a DEVELOPMENT; al tercer intento fallido pasa a BLOCKED.

**Testing no abre ningún PR**: al aprobar, el pedido pasa a CODE_REVIEW y el PR se abre con `/orqen:pr`.

## Revisión de e2e: `/orqen:e2e-review DEV-3312`

Los tests e2e se generan durante la implementación a partir de los Scenarios / criterios de aceptación. Este comando deja todo
listo para que el **diseñador de testing e2e** (una persona) los valide **visualmente** y **espera su aprobación**, con los ajustes
que haga a mano. No mueve el estado del pedido (no hace `take` ni `complete`): se corre con el pedido en `TESTING` o `CODE_REVIEW`,
parado en la rama del pedido, y acepta la clave del ticket interno o la del externo.

```mermaid
flowchart TD
    A["/orqen:e2e-review DEV-3312"] --> B["orqen status: ¿TESTING o CODE_REVIEW?<br/>¿rama del pedido activa?"]
    B -->|"no"| X(["Se explica la etapa y se corta"])
    B -->|"sí"| C["Arma la lista de escenarios / criterios<br/>y los mapea contra los tests e2e de la rama"]
    C --> D["Deja listo el modo visual<br/>(headed / trace / video) + guía de revisión"]
    D --> E{"Diseñador e2e<br/>(revisa y ajusta a mano)"}
    E -->|"ajustó"| F["Re-corre los e2e y revisa el diff<br/>(¿siguen cubriendo todo?)"] --> E
    E -->|"rechaza"| R(["Qué corregir → DEVELOPMENT<br/>(lo decide una persona)"])
    E -->|"aprueba explícito + corrida en verde"| G(["Resumen listo para el PR/ticket interno<br/>→ sigue CODE_REVIEW"])
```

El agente **no edita los tests**: señala observaciones (escenarios sin e2e, tests que no verifican el THEN, esperas fijas) y el
diseñador decide. La aprobación la da la persona en la conversación; igual que el OK del analista, **`orqen` no puede comprobarla**
(barrera de proceso, no de seguridad). Los ajustes quedan sin commitear en la rama del pedido: `orqen pr` los commitea y los empuja
con el PR a desarrollo (si el PR ya existía, hay que volver a correr `/orqen:pr` para sumarlos).

## PR a desarrollo: `/orqen:pr DEV-32`

Manda la rama del pedido a la rama de integración (`DEVEL_BRANCH`, por defecto `desarrollo`) con un pull request cuya
descripción explica los cambios. Acepta la clave del ticket interno o la del externo y se corre con el pedido en `TESTING` o después (no en carril operativo).
Es el **único PR** del proceso: el senior hace el code review (CODE_REVIEW) sobre este PR.

```mermaid
flowchart TD
    A["/orqen:pr DEV-32"] --> B["orqen pr DEV-32<br/>(rama, base, análisis, change; ¿ya hay PR?)"]
    B -->|"todavía en desarrollo,<br/>operativo o desconocido"| X(["Se explica y se corta"])
    B -->|"ok"| R{"¿El repo está en<br/>la rama del pedido?"}
    R -->|"no"| Y(["Se pide cambiar de rama y se corta<br/>(orqen no escribe nada)"])
    R -->|"sí"| C["El agente lee el diff contra la base,<br/>el análisis y la spec/plan"]
    C --> D["Escribe la explicación (.md):<br/>resumen · cambios · desvíos · tests · cómo verificar · riesgos"]
    D --> E["orqen pr DEV-32 explicación.md<br/>guarda devel-pr.md · commitea lo pendiente · push · abre el PR"]
    E --> F(["URL del PR, comentada en el pedido y el ticket interno"])
```

El agente solo redacta: el commit, el push y el PR los hace `orqen` (`DEVEL_PR_COMMAND`, con `{base}`, `{branch}`, `{key}`, `{title}`, `{body}`).
La explicación queda en `orqen/work/<KEY>/round-N/devel-pr.md`. Es idempotente: si el PR ya existe, solo empuja los commits nuevos.
Como `orqen` commitea lo pendiente de la rama antes de empujar, los ajustes manuales (p. ej. los del diseñador de e2e) viajan con el PR.
Si el repo no está en la rama del pedido, `orqen pr` falla antes de escribir, commitear o empujar nada.

## Code review: `/orqen:code-review DEV-32`

Lo corre el **senior** con el pedido en `CODE_REVIEW` y el PR a desarrollo ya abierto. El agente revisa el diff del PR contra lo pedido
(análisis, spec o plan, Scenarios / criterios de aceptación, explicación del PR y convenciones del repo) y le devuelve un informe para decidir.
No mueve el estado: la decisión la toma el senior con un review en el PR de GitHub (ver más abajo).

```mermaid
flowchart TD
    A["/orqen:code-review DEV-32"] --> B["orqen status + orqen pr<br/>¿CODE_REVIEW? ¿hay PR?"]
    B -->|"no"| X(["Se explica y se corta<br/>(sin PR: primero /orqen:pr)"])
    B -->|"sí"| C["Lee el diff del PR (origin/base...origin/rama)<br/>contra análisis, spec/plan y criterios"]
    C --> D["Verifica cada hallazgo<br/>(escenario concreto que falla)"]
    D --> E["Informe: veredicto · hallazgos con severidad, archivo:línea,<br/>qué pasa, por qué importa y posibles soluciones"]
    E --> R["orqen review DEV-32 informe.md --verdict …<br/>guarda code-review-n.md · lo comenta en el ticket interno"]
    R --> F{"Senior"}
    F -->|"Approve en el PR de GitHub"| G(["DELIVERY"])
    F -->|"Request changes con el texto que dejó listo el agente"| H(["DEVELOPMENT<br/>(los hallazgos llegan como feedback)"])
```

Es **solo lectura**: el agente no corrige código, no comenta ni aprueba el PR (solo `gh pr view` / `gh pr diff`) y no escribe en el ticket.
Cada hallazgo tiene severidad (`blocking`, `important`, `minor` o `to verify`) y una a tres soluciones posibles, con la recomendada primero.
Si el veredicto no es aprobable, el agente deja redactado el texto del pedido de cambios.

Cuando el senior da el informe por cerrado, el agente lo registra con `orqen review <KEY> <informe.md> --verdict <approve|minor|reject>`
(solo en `CODE_REVIEW` y con el PR abierto). Queda en `orqen/work/<KEY>/round-N/code-review-<n>.md` (numerado: un segundo review después
de un pedido de cambios no pisa al primero), se commitea si el repo está en la rama del pedido (viaja con el próximo push) y se comenta en el ticket interno.

### Cómo se decide el gate: review en GitHub

Con `CODE_REVIEW_GATE=github` (el valor por defecto) el senior **no necesita comentar nada en el ticket**: aprueba o pide cambios con un review en el PR,
y `orqen` lo lee con `gh` en cada `orqen pending` / `orqen cycle`:

- **Approve** → el pedido pasa a DELIVERY y se comenta en el pedido y el ticket interno.
- **Request changes** → vuelve a DEVELOPMENT y el texto del review llega al agente como feedback (si no tiene texto, se le indica el PR).
- Si hay un approve y un request changes a la vez, **gana el pedido de cambios**.
- Solo cuentan los reviews hechos sobre el **commit actual del PR**: si después del review alguien empuja (por ejemplo `/orqen:pr` con ajustes de e2e), hace falta un review nuevo. Es lo mismo que "dismiss stale approvals" de GitHub, y conviene activarlo también en la protección de rama.
- Cada review se aplica **una sola vez**, así que un pedido de cambios viejo no devuelve el pedido a DEVELOPMENT por segunda vez.
- Con `GITHUB_REVIEWERS` definido (usuarios de GitHub, separados por coma), solo cuentan los reviews de esos usuarios; vacío = cualquiera. Para que además nadie más pueda mergear, usá la protección de rama de GitHub. `APPROVERS_CODE` (cuentas del ticket externo) sigue sirviendo para destrabar un pedido BLOCKED.
- Sin PR todavía, el pedido espera. Si `gh` falla o no hay red, también espera (no se bloquea).

Con `CODE_REVIEW_GATE=jira` el senior decide con `/approve` o `/reject <motivo>` en el issue, como antes (ahí `APPROVERS_CODE` limita quién puede decidir).

## Flujo completo

```mermaid
flowchart LR
    classDef agente fill:#dbeafe,stroke:#2563eb,color:#1e3a8a
    classDef humano fill:#fef3c7,stroke:#d97706,color:#78350f
    classDef final fill:#dcfce7,stroke:#16a34a,color:#14532d
    classDef bloq fill:#fee2e2,stroke:#dc2626,color:#7f1d1d

    SUPPORT["SUPPORT (opcional)<br/>(soporte + agente)"]:::agente
    ANALYSIS["ANALYSIS<br/>(analista + agente)"]:::agente
    ESPERA["WAITING_CLIENT<br/>(máx. 3 rondas)"]:::humano
    DESA["DEVELOPMENT"]:::agente
    TEST["TESTING"]:::agente
    REV["CODE_REVIEW<br/>(senior + /orqen:code-review)"]:::humano
    DELIVERY["DELIVERY"]:::agente
    CONF["ACCEPTANCE<br/>(cliente)"]:::humano
    CLOSED(["CLOSED"]):::final
    BLOQ{{"BLOCKED"}}:::bloq

    SUPPORT -->|"escala con resumen"| ANALYSIS
    SUPPORT -->|"resuelto: respuesta al cliente"| CONF
    ANALYSIS <-->|preguntas / respuestas| ESPERA
    ANALYSIS -->|"OK analista: carril + ticket interno"| DESA
    DESA <-->|tests fallan / pasan| TEST
    TEST -->|"/orqen:pr abre el PR"| REV
    REV -->|"approve en el PR"| DELIVERY
    REV -.->|"changes requested"| DESA
    DELIVERY --> CONF
    CONF -->|/approve| CLOSED
    CONF -.->|"/reject: ronda 2"| ANALYSIS

    ANALYSIS & DESA & TEST & DELIVERY -.->|error / sin reintentos| BLOQ
    BLOQ -.->|"/approve &lt;indicaciones&gt;:<br/>vuelve a la etapa donde se bloqueó"| ANALYSIS & DESA & TEST & DELIVERY
```

**Azul**: etapas del agente · **Amarillo**: gates humanos en el ticket · **Rojo**: bloqueado (lo destraba una persona).
Tickets, git, PR y `openspec archive` los ejecuta solo `orqen`; el agente produce contenido.

| Estado         | Quién             | Qué pasa                                                                                                      | OpenSpec                                                                                                                                                      |
| -------------- | ----------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SUPPORT        | soporte + agente  | opcional: busca la respuesta y la redacta con la persona. **Resuelto** → ACCEPTANCE (sin ticket interno); **escalar** → ANALYSIS con el resumen | —                                                                                                                                                             |
| ANALYSIS       | analista + agente | grilling → OK → carril → spec (si corresponde) → ticket interno vinculado                                      | lee `openspec/specs`; liviano/completo: `orqen lane` crea el change y `orqen complete` exige `validate --strict`, artefactos completos y `(Nh)` en cada tarea |
| WAITING_CLIENT | cliente           | responde en el ticket (máx. 3 rondas)                                                                              | —                                                                                                                                                             |
| DEVELOPMENT    | agente            | implementa con el entorno levantado; con spec tilda `tasks.md`, en directo sigue el `plan`                    | flujo _apply_; `orqen` rechaza si queda alguna tarea sin tildar                                                                                               |
| TESTING        | `orqen` + agente  | `orqen` corre la suite y el agente mapea test ↔ **cada Scenario** (directo: cada **criterio de aceptación**). No abre PR | si falta alguno, se rechaza                                                                                                                         |
| CODE_REVIEW    | senior            | revisa el PR a desarrollo (`/orqen:pr`) con el informe de `/orqen:code-review` y decide con un review en GitHub | —                                                                                                                                                             |
| DELIVERY       | `orqen` + agente  | `orqen` archiva (si hubo spec) y el agente escribe notas y mensaje al cliente                                 | `openspec archive` fusiona los deltas en `openspec/specs` y se empuja a la rama del PR                                                                       |
| ACCEPTANCE     | cliente           | `/approve` cierra; `/reject` abre la ronda 2 (vuelve a ANALYSIS: nuevo carril, change y ticket interno)                  | nuevo change `…-r2`                                                                                                                                           |

Si se agotan los reintentos o hay un error, el pedido pasa a **BLOCKED**. Una persona destraba con `/approve <indicaciones>`
(`APPROVERS_ANALYSIS` + `APPROVERS_CODE`): el pedido vuelve a la etapa en la que se bloqueó, con los contadores de reintentos en cero
y las indicaciones como feedback para el agente.

**Carril operativo.** Si el pedido se resuelve sin cambiar código, el flujo es
`ANALYSIS → EXECUTION → EXECUTION_APPROVAL → APPLICATION → VERIFICATION → ACCEPTANCE → CLOSED`: el agente propone el script, el rollback
y la verificación; una persona de `APPROVERS_EXECUTION` autoriza y aplica, y el agente verifica en solo lectura. Si la verificación muestra
que la causa es de código, el pedido vuelve a ANALYSIS y nace un ticket interno de desarrollo.


## Crear un proyecto nuevo: `orqen bootstrap`

Arma un repo desde cero, con el código base, los scripts que levantan sus entornos y orqen ya listo para los agentes:

```sh
orqen bootstrap "Plataforma de Pagos"                          # pregunta el stack y los datos
orqen bootstrap "Facturación" --stack java-tomcat-sqlserver --dir ./facturacion
orqen bootstrap --list                                                 # lista los stacks disponibles
```

1. Pide el repositorio de GitHub del equipo si todavía no está clonado, y pregunta el nombre, la carpeta y el **stack** disponible en ese catálogo.
2. Revisa los requisitos (Node, Maven, Docker…) y pide los parámetros del stack (puertos, paquete Java); si un puerto está
   ocupado propone el siguiente libre.
3. Crea la carpeta y el repo git, genera el código (generadores oficiales, como `create-vue`, más un esqueleto propio con
   health check, migraciones y tests de ejemplo) y copia a `orqen/tools/` el script de la base (`orqen/tools/db.mjs`, PostgreSQL o
   SQL Server en Docker).
4. Corre `orqen init` con el stack y los entornos ya definidos (sin detección ni IA): OpenSpec, conectores, `AGENTS.md`, plugin.
5. Ofrece el commit inicial.

Después: `cd <carpeta>`, `orqen env up` (base + backend + migraciones; `--all` también el front) y `orqen env test`.
Los stacks viven en un repositorio de GitHub de cada equipo, que puede ser privado. Solo `orqen bootstrap` pide su ruta (por ejemplo `@telpin-sistemas/tools`) y se clona dentro de `cli/tools/`, junto a la instalación del CLI. El repositorio puede tener cualquier nombre; `cli/tools/` es solo el destino local del clon. Cada stack mantiene `<id>/tool.yaml` y su esqueleto; los scripts compartidos van en `_shared/`. El catálogo se reutiliza en las siguientes ejecuciones, se ignora en Git y no se incluye en el paquete npm.

Quien ejecuta el comando necesita acceso al repositorio mediante sus credenciales de Git (HTTPS con un credential helper, o SSH). No se guardan tokens en la configuración. Para automatizar el primer `bootstrap`, se requiere `--tools-repo` o `ORQEN_TOOLS_REPO` si el catálogo todavía no está clonado:

```sh
orqen bootstrap "Mi proyecto" --yes --tools-repo @telpin-sistemas/stacks
# También: ORQEN_TOOLS_REPO=@telpin-sistemas/tools
```

Para actualizar el catálogo se usa `git -C cli/tools pull --ff-only` desde la carpeta de instalación de ORQEN. Para cambiar de repositorio, mover el clon anterior y ejecutar con otro `--tools-repo`. Los stacks anteriores a esta separación quedan localmente en `cli/tools-backup/` (ignorado). ORQEN no usa esa carpeta: se puede borrar cuando sus archivos ya estén trasladados al repo privado o respaldados.

`/orqen:implement DEV-32` ejecuta internamente `orqen swarm` con el contexto y el plan aprobado del ticket. Verifica el resultado y lo integra en la rama del pedido; la persona ve el avance y los resultados de la implementación sin tener que ejecutar otro comando.

## Instalación en un repo

```sh
npm i -g orqen          # o: pnpm add -g orqen (Node ≥ 20.12)
cd mi-repo
orqen init
```

`orqen init`:

1. Verifica Node, git y el gestor de paquetes. No consulta ni clona el repositorio externo de stacks.
2. Detecta componentes, cómo se levanta cada uno y qué servicios necesita (`package.json`, `pom.xml`, `pyproject.toml`, Prisma, `.env.example`) y,
   si hay un agente de IA instalado, le pide que revise un resumen del repo (`--deep` para que lo explore entero, `--no-ai` para solo detección automática).
3. Te deja confirmar o editar componentes, el comando que levanta cada parte (`npm run dev`, `npm start`…), tests, migraciones y seeds.
4. Instala OpenSpec (2.x) si hace falta y corre `openspec init` para las herramientas elegidas.
5. Pregunta dónde viven los tickets (**conectores**: externo e interno, ver más abajo) y los aprobadores. Lo que es configuración va a `conectores` en `orqen/config.yaml`; los tokens, a `orqen/.env` (ignorado por git).
6. Escribe la configuración del entorno (sin Docker de por medio), `AGENTS.md` / `CLAUDE.md`, el plugin, las guías de etapa y el manifiesto,
   y fusiona las reglas del proceso con el `openspec/config.yaml` existente.

Opciones: `--yes` (no interactivo), `--agent "<comando>"`, `--tools claude,codex`, `--no-openspec`.

**Plugin para Claude Code** (da los comandos `/orqen:*` y el skill de grilling), una vez por usuario:

```
/plugin marketplace add ./
/plugin install orqen@orqen
```

Recomendado: conectar también el MCP de la herramienta de tickets (Atlassian, GitHub o Asana) para que el grilling lea el pedido y los relacionados. Es solo lectura:
las escrituras las hace `orqen` con el token del conector.

**Actualizar** una instalación: `orqen update` busca una versión nueva de la CLI, de OpenSpec y del kit. Los archivos que no editaste se
actualizan solos; para los editados elegís conservar, reemplazar o dejar una copia `.orqen-new`. `--no-cli`, `--no-openspec` y `--no-kit` saltean pasos.

### Qué queda en el repo

| Ruta                             | Para qué                                                                                       |
| -------------------------------- | ---------------------------------------------------------------------------------------------- |
| `orqen/config.yaml`              | Stack, cómo se levanta cada parte, migraciones, tests, rama base, agente y **conectores**       |
| `orqen/.env`                     | Tokens de los conectores y aprobadores (local, ignorado por git)                               |
| `orqen/stages/`                  | Guías de cada etapa (editables)                                                                |
| `orqen/plugin/`                  | Comandos de Claude Code y el skill de grilling                                                 |
| `orqen/work/<KEY>/`              | Registro versionado de cada pedido                                                                |
| `orqen/state/` y `orqen/tmp/`    | Estado operativo, procesos corriendo y sus logs (ignorados por git)                            |
| `orqen/manifest.json`            | Hashes de los archivos del kit, para que `orqen update` detecte tus cambios                    |
| `AGENTS.md` y `CLAUDE.md`        | Instrucciones del proceso para los agentes                                                     |
| `openspec/`                      | Specs y configuración de OpenSpec                                                              |

### Variables principales de `orqen/.env`

| Variable                                                     | Para qué                                                                                   |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `JIRA_URL`, `JIRA_USER`, `JIRA_TOKEN`, `JIRA_DEPLOYMENT`      | Conexión a Jira (`cloud` o `server`). Otro Jira: otro prefijo y `credenciales: <PREFIJO>` en el conector |
| `GITHUB_TOKEN`                                               | GitHub Issues/Projects (vacío = la sesión de `gh`)                                         |
| `ASANA_TOKEN`                                                | Asana (token personal)                                                                     |
| `SUPPORT_STAGE`                                              | `on`: `orqen pending` manda los pedidos nuevos primero a soporte. Por defecto `off`; `/orqen:support` funciona con cualquiera de los dos valores. No hay lista de personas de soporte: puede tomarlo cualquiera |
| `APPROVERS_ANALYSIS`, `APPROVERS_CODE`, `APPROVERS_CLIENT`, `APPROVERS_EXECUTION` | Quién puede decidir en cada gate, con cuentas de la herramienta del ticket externo (vacío = cualquiera). `APPROVERS_CODE` también destraba un BLOCKED |
| `CODE_REVIEW_GATE`, `GITHUB_REVIEWERS`                       | Quién decide en CODE_REVIEW: `github` (review en el PR, por defecto) o `ticket` (`/approve` y `/reject` en el ticket; `jira` sigue funcionando). `GITHUB_REVIEWERS`: usuarios de GitHub cuyos reviews cuentan (vacío = cualquiera) |
| `BASE_BRANCH`, `TEST_COMMAND`                                | Rama base de las ramas de pedidos y suite por defecto (si `config.yaml` no define tests)       |
| `DEVEL_BRANCH`, `DEVEL_PR_COMMAND`                           | Rama de integración y comando que abre el PR (`orqen pr`)                                  |
| `AGENT_CMD`, `ORQEN_INTERVAL_SEC`, `ORQEN_LOCK_MIN`          | Agente del modo desatendido, intervalo del ciclo y vencimiento del lock por pedido         |

## App de escritorio

`app/` es la app de ORQEN (Rust + GPUI, el framework de Zed) para Windows, macOS y Linux: pendientes, entornos, enjambre, conectores y tutorial, con la animación del logo al abrir. No tiene lógica propia: muestra lo que devuelve la CLI con `--json`.
Se abre con `orqen` (sin argumentos) en la carpeta de un proyecto: la primera vez la CLI la baja ya compilada para tu sistema (Windows, macOS o Linux) y la abre; no hace falta instalar Rust ni nada más. GitHub Actions la compila y la publica en cada release (`v*`). Ver `app/README.md`.

## Conectores: dónde viven los tickets

En **Configuración → General** se definen el **prefijo de requerimientos** (lo que ve el cliente) y el **prefijo de tickets** (desarrollo), independientemente de Jira, GitHub o Asana:

```yaml
general:
  prefijos:
    requerimientos: REQ
    tickets: TKT
```

Los proveedores se eligen en **Configuración → Conectores**. Sus etiquetas y filtros no son prefijos. Los proyectos existentes conservan sus claves hasta guardar explícitamente General; si ya hay historial, cambiar los prefijos requiere migrar las claves registradas. En Jira hay que seleccionar un proyecto por conector: ORQEN traduce el prefijo general a la clave nativa para las consultas y los enlaces.


orqen trabaja con dos tickets por pedido:

- **Externo**: lo que ve el cliente. Ahí entra el pedido, ahí orqen responde y ahí el cliente aprueba o rechaza (`/approve`, `/reject <motivo>`).
- **Interno** (opcional): el ticket del equipo. Nace cuando cierra el análisis, queda vinculado al externo y ahí se sigue el trabajo técnico. Sin conector interno, todo se trabaja sobre el externo.

Cada uno puede estar en **Jira**, **GitHub** (Issues, opcionalmente en un GitHub Project) o **Asana**, y se pueden mezclar
(por ejemplo, el Jira del cliente como externo y un GitHub Project del equipo como interno). Se configuran en `orqen/config.yaml`:

```yaml
conectores:
  externo:
    tipo: jira                 # jira | github | asana
    filtro: project = SOP AND labels = orqen AND statusCategory != Done
    transiciones: { ACCEPTANCE: "Esperando cliente", CLOSED: "Resuelto" }
  interno:                     # opcional
    tipo: github
    repo: mi-org/mi-repo
    proyecto: 7                # número del GitHub Project (opcional); mueve el campo Status
    transiciones: { DEVELOPMENT: "In progress", CODE_REVIEW: "In review", CLOSED: "Done" }
```

| Campo | Jira | GitHub | Asana |
| ----- | ---- | ------ | ----- |
| `filtro` | JQL de los pedidos que maneja orqen | calificadores de búsqueda (`is:open label:orqen` por defecto) | tag de las tareas (`orqen` por defecto) |
| `proyecto` | clave del proyecto donde se crea el interno | número del GitHub Project | id del proyecto |
| `transiciones` | estado de orqen → transición del workflow | estado → opción del campo `campo` (Status) | estado → sección (`completed` la cierra) |
| Claves | las de Jira (`SOP-123`) | `GH-42` (`prefijo` configurable) | `AS-<id>` |
| Extras | `credenciales`, `tipo_ticket`, `tipo_operativo`, `vinculo` | `repo`, `duenio_proyecto`, `campo`, `etiquetas` | `prefijo` |

Los tokens van en `orqen/.env` (`JIRA_*`, `GITHUB_TOKEN`, `ASANA_TOKEN`). `orqen connectors` muestra los dos conectores y prueba las credenciales;
`orqen connectors setup` los configura con preguntas. Los comandos aceptan la clave del externo o la del interno.

**Si venías de una versión anterior** (`REC_JQL`, `SIS_PROJECT`, `SIS_*` en `orqen/.env`): siguen funcionando como Jira externo + Jira interno, con un aviso.
`orqen update` ofrece pasarlas a `conectores`. Las ramas `rec/<key>` de pedidos en curso se siguen usando; las nuevas son `orqen/<key>`.

## Entornos y tests

Cada parte del proyecto se levanta con su propio comando, sin Docker de por medio (si un equipo lo quiere, un proceso puede ser
`docker compose up db`). `orqen init` lo propone y lo deja en `orqen/config.yaml`:

```yaml
entornos:
  procesos:
    - nombre: api
      comando: npm run dev        # o npm start, mvn spring-boot:run, dotnet watch run…
      ruta: apps/api
      puerto: 3000                # listo cuando el puerto responde (o `url:` / `listo_si: "texto del log"`)
      cuando: siempre             # siempre: para desarrollar y testear · e2e: solo para tests e2e / visuales
    - nombre: web
      comando: npm run dev
      ruta: apps/web
      puerto: 5173
      cuando: e2e
  variables: { DATABASE_URL: postgresql://localhost:5432/pagos }
  preparar: [pnpm install]
  migrar: [npx prisma migrate deploy]
  tests: { unitarios: pnpm test, e2e: pnpm exec playwright test }
```

- En **DEVELOPMENT**, `orqen take` instala dependencias, levanta los procesos de `cuando: siempre` en segundo plano, espera a
  que respondan y corre migraciones y seeds. El agente recibe en `environment` el estado, las variables y los comandos de test.
  `orqen complete` los corta.
- En **TESTING**, `orqen` levanta todos los procesos (también los de e2e), corre toda la suite configurada y los corta.
- Si un proceso no levanta, el agente ve el final de su log (`orqen/state/logs/<proceso>.log`) y lo corrige o te pregunta.

```sh
orqen env setup                                    # instala dependencias
orqen env up [--all]                               # procesos + migraciones + seeds (--all: también los de e2e)
orqen env test [unitarios|integracion|e2e|visual]
orqen env status                                   # qué está corriendo y dónde está su log
orqen env down                                     # corta lo que levantó orqen
```

## Con la persona en el medio

orqen acompaña a la persona, no la reemplaza. Mientras haya alguien del otro lado (`/orqen:analyze`, `/orqen:implement`,
`/orqen:pr`, los reviews), el agente:

- cuenta qué va a hacer y espera el OK antes de cada paso importante (carril, spec, plan, cambios fuera del plan, abrir el PR,
  cerrar la etapa) y, al terminar cada paso, cuenta qué hizo y qué sigue;
- ante cualquier duda pregunta, con opciones concretas y su recomendación, en vez de suponer.

En modo desatendido (`orqen cycle`) nadie puede contestar: una duda que cambia el resultado se convierte en `orqen block` con la
pregunta, que orqen publica en el ticket; la persona responde con `/approve <respuesta>` y el agente sigue con esa respuesta.

## Enjambre: `orqen swarm`

Para una tarea de cualquier tipo que se pueda partir: orqen la divide en subtareas chicas, las resuelve en paralelo con modelos
chicos y junta todo en una rama.

```sh
orqen swarm "Agregar exportación a CSV en el listado de pagos, con filtros por fecha y tests"
orqen swarm --file tarea.md --parallel 6
orqen swarm "…" --plan-only          # solo el plan (orqen/state/swarm/<run>/plan.json), para revisarlo o editarlo
orqen swarm --plan plan.json         # corre un plan ya revisado
```

1. **Plan**: un modelo grande (`--planner`, por defecto Opus) lee el repo y devuelve un grafo de subtareas: archivos que toca
   cada una, dependencias, criterios y un `test` rápido que solo pasa cuando la subtarea está hecha. orqen valida el plan (ids,
   ciclos, y que dos subtareas que pueden correr a la vez no toquen el mismo archivo) y, si no cierra, se lo devuelve con los
   errores una vez.
2. **OK de la persona**: muestra el plan y pregunta antes de lanzar (`--yes` o sin terminal: sigue solo).
3. **Workers en paralelo**: cada subtarea corre en su propio `git worktree` (tu checkout no se toca), hasta `--parallel` a la vez
   (4 por defecto). Las que dependen de otras arrancan cuando esas ya están mergeadas, encima del código mergeado. En cada
   worktree nuevo corre `entornos.preparar` (o `--setup`).
4. **Verificación y escalado**: después de cada intento orqen corre el `test` de la subtarea. Si falla, resetea el worktree y
   reintenta pasándole al modelo la salida del error. El modelo chico (`--small`, Haiku) tiene 2 intentos; si no lo resuelve,
   la subtarea pasa al grande (`--large`, Sonnet) con 2 intentos más. Las marcadas `complex` en el plan arrancan en el grande.
5. **Merge**: cada subtarea que pasa se commitea y se mergea (`--no-ff`) a la rama `orqen/swarm-<run>`. Si choca con algo
   mergeado mientras tanto, se rehace encima de lo último (cuenta como intento).
6. **Test final**: con todo mergeado corre el `finalTest` del plan (o `--test` / `entornos.tests.unitarios`). Si falla, el
   modelo grande lo arregla sobre la rama de integración (hasta 2 veces).

Al terminar quedan la rama `orqen/swarm-<run>` lista para revisar y mergear (`git merge orqen/swarm-<run>` o un PR), y el
informe con cada intento, modelo y log en `orqen/state/swarm/<run>/`. Si una subtarea no se resuelve con ningún modelo, las que
dependen de ella se saltean, el resto se mergea igual y el comando sale con código 1. Los worktrees se borran al final
(`--keep` deja el de integración).

Los modelos son comandos headless, así que se puede usar cualquier agente: `--small "codex exec --full-auto -"`,
`--large "claude -p --model opus --permission-mode acceptEdits"` (o `ORQEN_SWARM_SMALL`, `ORQEN_SWARM_LARGE`,
`ORQEN_SWARM_PLANNER`). Con `{prompt}` en el comando, el prompt va como argumento en vez de stdin.

## Uso

**Primera vez**: en Claude Code, `/orqen:tutorial`.

**Soporte (opcional)**: en Claude Code, `/orqen:support SOP-1234`. En otro agente: _"atendé el SOP-1234 como soporte"_ (`orqen support` → búsqueda → `orqen complete`). Si resuelve, `orqen` publica la respuesta y el cliente confirma con `/approve` o `/reject <motivo>`; si escala, el analista parte del resumen. El analista también puede tomar un pedido nuevo directo con `analyze`. `support` funciona aunque `SUPPORT_STAGE` esté en `off`: sirve para pasar un pedido puntual por soporte sin cambiar el flujo del resto.

**Análisis (analista)**: en Claude Code, `/orqen:analyze SOP-1234`. En otro agente: _"analizá el SOP-1234"_ (el agente lee
`AGENTS.md` y corre `orqen analyze` → grilling → `orqen lane` → `orqen complete`).

**Implementación**: en Claude Code, `/orqen:implement DEV-442`. En otro agente: _"implementá el DEV-442"_ (`orqen status` → `orqen take` →
apply de la spec o plan → `orqen complete`).

**Validación de e2e**: en Claude Code, `/orqen:e2e-review DEV-3312`, a cargo del diseñador de testing e2e. En otro agente: _"preparame la revisión de e2e del DEV-3312"_.

**PR a desarrollo**: en Claude Code, `/orqen:pr DEV-32`. En otro agente: _"abrí el PR a desarrollo del DEV-32"_ (`orqen pr` → explicación → `orqen pr <KEY> <archivo.md>`).

**Code review**: en Claude Code, `/orqen:code-review DEV-32`, a cargo del senior. En otro agente: _"hacé el code review del PR del DEV-32"_.

**Resto de las etapas, interactivo**: _"procesá el SOP-123"_ → `orqen take` → trabaja → `orqen complete`.

**Desatendido** (cron, CI o servidor), solo etapas de agente — **nunca** SUPPORT ni ANALYSIS:

```sh
orqen cycle --loop     # cada ORQEN_INTERVAL_SEC: avanza gates y lanza AGENT_CMD por pedido pendiente
```

Para cambiar de agente alcanza con cambiar `AGENT_CMD`, por ejemplo a `codex exec --full-auto {prompt}`.
Los pedidos nuevos no se toman solos: quedan en NEW hasta que soporte corre `support` o un analista corre `analyze` (con `SUPPORT_STAGE=on`, `orqen pending` los lista primero para soporte).

### Comandos

```text
orqen                                  Abre la app de escritorio de ORQEN en este repo (orqen --help: la ayuda)
orqen init [dir]                       Inicializa un repo
orqen update [dir]                     Actualiza la CLI, OpenSpec y el kit

orqen bootstrap [nombre] [--stack <id>] [--dir <carpeta>] · orqen bootstrap --list
orqen env setup | up [--all] | test [tipo] | status | down
orqen tutorial [paso] [--step <n|id>] [--list] [--lang es|en]   Tutorial paso a paso · orqen lang: idioma detectado
orqen swarm "<tarea>" [--parallel N] [--plan-only | --plan plan.json] [--small C] [--large C] [--yes]

orqen pending [--json]                 Pedidos con trabajo: para soporte / para analizar / para un agente
orqen support <KEY> [--person N]       Abre la atención de soporte (anda con SUPPORT_STAGE on u off)
orqen analyze <KEY> [--analyst N]      Abre el análisis con un analista
orqen lane <KEY> <direct|light|full>   Registra el carril (light/full: rama + change de OpenSpec)
orqen take <KEY> [--agent N]           Reserva una etapa de agente y prepara rama y entorno
orqen complete <KEY> <salida.json|->   Valida la salida de la etapa y avanza el proceso
orqen pr <KEY> [<explicación.md>] [--title T]                     Sin archivo: informa. Con archivo: commit + push + PR a DEVEL_BRANCH
orqen review <KEY> <informe.md|-> --verdict <approve|minor|reject> Registra el informe del code review (CODE_REVIEW)
orqen status [KEY]                     Estado actual y log
orqen schema <ETAPA>                   JSON Schema de la salida de una etapa
orqen block <KEY> <motivo>             Escala a una persona
orqen release <KEY>                    Libera la reserva de un pedido
orqen connectors [setup] [--json]      Muestra y prueba los conectores (externo e interno), o los configura
orqen search <JQL>                     Busca issues (antecedentes / relacionados)
orqen cycle [--loop]                   Modo desatendido
```

`take`, `complete`, `status`, `block`, `release`, `pr` y `review` aceptan la clave del ticket externo o la de su interno.

## Garantías y límites

- Las salidas se validan con zod y con OpenSpec. Si algo no cumple, el agente recibe la lista de errores y reintenta. Nada avanza a medias:
  el ticket interno no se crea hasta que el análisis (y la spec) están validados, y si el conector falla a mitad de camino, repetir `complete` retoma sin duplicar.
- El OK del analista es un campo obligatorio de la salida (`analyst_ok`), pero **lo declara el agente**: `orqen` no puede comprobar que la persona
  lo haya dado. Lo mismo pasa con la aprobación del diseñador de e2e. Son barreras de proceso, no de seguridad.
- Hay un lock por pedido (vence a los `ORQEN_LOCK_MIN`, pero el mismo agente puede completar igual si nadie más lo tomó, porque el grilling puede ser largo).
- Tickets, git, PR y archive los ejecuta **solo** `orqen`. El agente tiene esa prohibición en `AGENTS.md`, pero
  al ser agnóstico **no hay un hook que lo impida a la fuerza**. Hay que reforzarlo con el sandbox o los permisos de
  cada herramienta (por ejemplo, denegar `git push` en `.claude/settings.json`, o permitir del MCP de tickets solo las herramientas de lectura).
- Con `CODE_REVIEW_GATE=github`, sin PR abierto el pedido espera en CODE_REVIEW: no avanza hasta que se corra `/orqen:pr` y el senior revise. La aprobación sale de GitHub, así que `orqen` necesita `gh` autenticado; con `ticket` el gate sigue aceptando `/approve` aunque no exista el PR.
- El estado vive en `orqen/state/` (ignorado por git, sobrevive a los cambios de rama) y en una etiqueta `orqen-state-*` del ticket (Jira y GitHub) o la sección (Asana); `orqen/work/<KEY>/` es su proyección versionada.
- Usa un solo checkout, así que procesa un pedido por vez por clon. Para trabajar en paralelo: un clon o worktree por agente.

## Desarrollo del kit

- [`cli/`](cli/README.md): la CLI (comandos, máquina de estados, entornos).
- `template/`: los archivos que instala `orqen init`.

```sh
cd cli
npm ci
npm run dev -- --help
npm run test:e2e  # comandos completos hasta CLOSED, Git/OpenSpec reales y servicios externos simulados
npm test          # suite completa de regresion (incluye e2e)
npm run typecheck
npm run build
npm run setup     # compila y linkea la CLI local como `orqen`
```

El paquete `orqen` publicado incluye los templates. El workflow de release publica desde `cli/` cuando se empuja un tag de versión.
