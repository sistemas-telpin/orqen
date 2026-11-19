# El flujo de orqen, paso a paso

Hay dos formas de recorrer el flujo, y hacen lo mismo:

- **Con comandos** `orqen …` en la terminal.
- **Con skills** `/orqen:…` en Claude Code, o en cualquier agente al que le pidas lo mismo. La skill lanza al agente, que lee el
  contexto, conversa con la persona y recién después ejecuta los mismos comandos `orqen` (los de las filas "CLI").

El CLI es determinístico: valida, mueve los estados, escribe en los tickets y hace git y PR. El agente solo produce contenido
(análisis, código, textos) y no toca tickets ni git por su cuenta.

```
NEW → [SUPPORT] → ANALYSIS ⇄ WAITING_CLIENT → DEVELOPMENT → TESTING → [QA_REVIEW] → CODE_REVIEW → DELIVERY → ACCEPTANCE → CLOSED
                                                                (solo carril completo)      (merge manual del PR)
```

## 0. Preparación (una vez por repositorio)

```sh
orqen init                  # detecta el stack; escribe orqen/config.yaml, orqen/environment.yaml, el plugin /orqen:* y AGENTS.md; ofrece commitear
orqen connectors setup      # dónde viven los tickets (Jira, GitHub o Asana); propone las columnas del project; el token va a ~/.orqen/credentials.env
orqen connectors            # prueba la conexión
```

- En Claude Code, abrí la carpeta y aceptá **Trust this folder**: así aparecen los `/orqen:*`.
- Si el `init` no commiteó, hacelo vos: `git add -A && git commit -m "Install orqen"` (o corré `orqen init --commit`). Sin ese commit,
  el primer `orqen take` no puede cambiar de rama.
- Ajustá `orqen/config.yaml` (aprobadores, rama de integración, transitions) y `orqen/environment.yaml` (cómo se levanta y testea el proyecto).

## 1. Los 9 pasos

### Paso 1 · Ver el trabajo pendiente

| | |
|---|---|
| **Skill** | `/orqen:list requests` |
| **CLI** | `orqen list requests [--json] [--all]` |
| **Qué hace** | Primero procesa lo que ya tiene decisión en los tickets (respuestas del cliente, `/approve`, reviews del PR) y después lista los pedidos por rol (soporte, analista, desarrollo, QA, senior, cliente, bloqueados) con el comando siguiente. No toma nada. |

### Paso 2 · Soporte (opcional)

| | |
|---|---|
| **Skill** | `/orqen:support GH-4` |
| **CLI** | `orqen support GH-4 --agent support` → `orqen complete GH-4 salida.json --agent support` |
| **Qué hace el CLI** | `support` reserva el pedido (queda en `SUPPORT`) y muestra el contexto y el esquema (`orqen schema SUPPORT`). `complete` valida el JSON, comenta en el ticket y avanza. |
| **Qué hace el agente** | Lee el pedido, busca la respuesta (pedidos parecidos, `openspec/specs/`, el código), propone `resolved` o `escalate`, redacta el texto para el cliente y se lo muestra a la persona. Solo con su aprobación explícita pone `support_ok: true`. |
| **Resultado** | `resolved` → `ACCEPTANCE`: el cliente confirma con `/approve` o `/reject <motivo>`. `escalate` → `ANALYSIS`. |

### Paso 3 · Análisis

| | |
|---|---|
| **Skill** | `/orqen:analyze GH-4` (usa además la skill `orqen:grilling`) |
| **CLI** | `orqen analyze GH-4 --agent analyst` → `orqen lane GH-4 direct\|light\|full` → `orqen complete GH-4 salida.json --agent analyst` |
| **Qué hace el CLI** | `analyze` reserva el pedido y entrega el contexto (con el resumen de soporte y el feedback del cliente, si hay). `lane` registra el carril; en light/full además crea la rama y el change de OpenSpec. `complete` valida; si el análisis queda listo, crea el issue y lo vincula. |
| **Qué hace el agente** | Lee el pedido, las specs y el código, y entrevista al analista con `grilling` (una pregunta por vez, con su recomendación). Propone el carril, escribe la spec si corresponde y arma el JSON (`orqen schema ANALYSIS`). `analyst_ok: true` solo con el OK explícito del analista. |
| **Resultado** | Con preguntas para el cliente (`open_questions`) → `WAITING_CLIENT` (ver sección 2). Listo → `DEVELOPMENT` (o `EXECUTION` si es operativo). |

Carriles: `direct` (sin spec, plan en el análisis), `light` (OpenSpec compacto), `full` (OpenSpec completo, con revisión de QA), y `operational`
(sin código: SQL, reinicios, datos).

### Paso 4 · Cola de desarrollo

| | |
|---|---|
| **Skill** | `/orqen:list issues` |
| **CLI** | `orqen list issues [--json]` |
| **Qué hace** | Lista los pedidos en `DEVELOPMENT`: libres o tomados, horas estimadas, y los que volvieron con cambios, con el motivo. |

### Paso 5 · Implementar (con testing automático)

| | |
|---|---|
| **Skill** | `/orqen:implement GH-3` |
| **CLI** | `orqen take GH-3 --agent implementer` → (implementar) → `orqen env test unit` → `orqen complete GH-3 dev.json --agent implementer` → `orqen take GH-3 --agent tester` → `orqen complete GH-3 testing.json --agent tester` |
| **Qué hace el CLI** | El primer `take` crea la rama `orqen/gh-3`, instala dependencias y levanta los procesos de `environment.yaml`. `complete` (DEVELOPMENT) pasa a `TESTING`. El segundo `take` corre toda la suite (unit, integración y e2e) y devuelve el resultado y los escenarios o criterios a verificar. |
| **Qué hace el agente** | Muestra su plan y espera el OK. Implementa con `orqen swarm --file <tarea> --yes --json --apply` (planifica, reparte en worktrees y verifica) o siguiendo el plan del carril directo. Corre solo los tests de este cambio y, con el OK de la persona, cierra la etapa. Después corre `TESTING` por su cuenta, sin pedir OK: mapea cada criterio a su test y diagnostica las fallas. |
| **Resultado** | Pasa → `QA_REVIEW` (carril completo) o `CODE_REVIEW`. Falla → vuelve a `DEVELOPMENT` con el diagnóstico (hasta 3 veces; después se bloquea). |

### Paso 6 · Abrir el PR

| | |
|---|---|
| **Skill** | `/orqen:pr GH-3` |
| **CLI** | `orqen pr GH-3` (solo informa) → `orqen pr GH-3 explicacion.md --agent pr` |
| **Qué hace el CLI** | Sin archivo: muestra rama, base, carril y PR existente. Con archivo: commitea lo pendiente, empuja la rama y abre o actualiza el PR a la rama de integración (`workflow.devel_branch`). Necesita `gh`. |
| **Qué hace el agente** | Lee el diff contra el análisis o la spec, escribe la explicación (resumen, cambios, desvíos, tests, riesgos) y se la pasa a `orqen pr`. |

### Paso 7 · Revisión de QA (solo carril completo)

| | |
|---|---|
| **Skill** | `/orqen:review GH-3` |
| **CLI** | `orqen env up --all`, `orqen env test e2e -- <archivos>` → `orqen review GH-3 approve\|reject --report informe.md --person "QA" --agent qa` |
| **Qué hace el agente** | Levanta todo el proyecto (incluido el frontend), corre los e2e del cambio en modo visible, arma la tabla de escenarios y tests y marca lo que falta o es frágil. QA corrige directamente en la rama. |
| **Resultado** | Aprueba → `CODE_REVIEW`. Rechaza → `DEVELOPMENT` con el motivo. |

### Paso 8 · Cola de PRs del senior

| | |
|---|---|
| **Skill** | `/orqen:list prs` |
| **CLI** | `orqen list prs [--json]` |
| **Qué hace** | Muestra los PRs en revisión con el estado del CI, si hay conflictos, si el review es sobre el último commit, y los ya aprobados que esperan el merge. |

### Paso 9 · Decisión del senior, merge y entrega

| | |
|---|---|
| **Skill** | `/orqen:approve GH-3` |
| **CLI** | `orqen code-review` (opcional) → `orqen approve GH-3` o `orqen approve GH-3 --changes comentario.md` → (merge manual) → `orqen take GH-3 --agent delivery` → `orqen complete GH-3 entrega.json --agent delivery` |
| **Qué hace el agente** | Si el senior quiere, revisa el PR en solo lectura y entrega un informe con veredicto y hallazgos (`file:line`, severidad, soluciones), que registra con `orqen code-review`. Después le pide la decisión. Si pide cambios, redacta con él el texto exacto. |
| **Qué hace el CLI** | `approve` no aprueba un PR con el CI en rojo o con conflictos (salvo `--force`). Aprobar pasa a `DELIVERY`. Pedir cambios vuelve a `DEVELOPMENT`. |
| **Merge** | **orqen nunca mergea.** Una persona mergea el PR a mano; orqen lo detecta con `gh`, o se confirma con `orqen merged GH-3`. |
| **Entrega** | `take` archiva la spec y la empuja al PR. El agente redacta el mensaje al cliente (qué cambió y cómo validarlo), el senior lo aprueba y `complete` lo publica → `ACCEPTANCE`. |
| **Cierre** | El cliente comenta `/approve` → `CLOSED` (se cierra el ticket). Con `/reject <motivo>` → vuelve a `ANALYSIS`, ronda 2. |

## 2. Ida y vuelta con el cliente

El cliente no usa orqen: responde en el ticket (GitHub, Jira o Asana).

- **Respuesta de soporte:** `/approve` la acepta, `/reject <motivo>` la rechaza.
- **Preguntas del análisis:** si el análisis sale con `open_questions`, orqen las publica y el pedido pasa a `WAITING_CLIENT`. El cliente contesta con un comentario común.
- **Cómo se entera orqen:** la próxima vez que alguien corre `orqen list requests` (o `orqen cycle`), lee los comentarios nuevos. Un comentario común vuelve el pedido a `ANALYSIS` con la respuesta como feedback. Un `/reject` lo manda a `ANALYSIS` en la ronda 2.
- Mientras el pedido espera al cliente, `orqen analyze` se niega a seguir.

## El estado de un pedido en otra máquina

El estado operativo de cada pedido vive en `orqen/state/` (ignorado por git, uno por máquina y por clon). Si otra persona, otra máquina o un
clon nuevo no tiene ese registro, orqen lo reconstruye así, de más completo a menos:

1. **El registro local**, si existe.
2. **La foto del repositorio.** En cada cambio de estado orqen escribe `orqen/work/<KEY>/state.json` con el pedido completo (ronda, carril,
   análisis, feedback, comentarios ya vistos…; sin el lock) y lo commitea con la rama `orqen/<key>`. Si esa rama está en el repo local o
   se bajó con `git fetch origin orqen/<key>`, orqen la lee, la guarda en `orqen/state/` y sigue desde ahí, con el registro completo. Si
   hay varias copias (el árbol de trabajo, la rama local, `origin/…`), usa la más nueva.
3. **La etiqueta del ticket** (`orqen-state-…`), solo para mostrar. `orqen list` y `orqen status` muestran el estado que dice el ticket y
   marcan que esta máquina no tiene registro; no se guarda nada y no se ofrece como trabajo a un agente. Para seguir, hay que traer la rama
   (`git fetch origin orqen/<key>`).
4. Sin nada de eso, el pedido se trata como nuevo (`NEW`).

Límites: la foto solo existe una vez que hay rama del pedido y hay que subirla (`orqen pr` la empuja); un pedido que todavía está en soporte o
en análisis de carril directo no tiene rama, así que solo se ve por la etiqueta. Una foto puede ir un paso atrás del estado real si el pedido
cambió desde el último commit de la rama.

## 3. Comandos de apoyo

```sh
orqen status GH-4 [--json]      # estado, historial y qué sigue
orqen block GH-4 "motivo"       # escala a una persona; se destraba con /approve <instrucciones> en el ticket
orqen release GH-4              # libera un pedido tomado por un agente que ya no trabaja
orqen cancel GH-4 --reason "…"  # cierra sin entregar: cierra el PR sin mergear y el issue
orqen merged GH-3               # confirma el merge manual cuando gh no puede leerlo
orqen cycle [--loop]            # modo desatendido: solo etapas de agente, nunca soporte ni análisis
```

## 4. Qué agente hace cada etapa (`--agent`)

| Valor | Etapa | Comando |
|---|---|---|
| `support` | SUPPORT | `/orqen:support` |
| `analyst` | ANALYSIS | `/orqen:analyze` |
| `implementer` | DEVELOPMENT | `/orqen:implement` |
| `tester` | TESTING (automático, dentro de `/orqen:implement`) | `/orqen:implement` |
| `pr` | Abrir el PR | `/orqen:pr` |
| `qa` | QA_REVIEW | `/orqen:review` |
| `code-review` | Informe opcional del senior | `/orqen:approve` |
| `senior` | CODE_REVIEW (la decisión) | `/orqen:approve` |
| `delivery` | DELIVERY | `/orqen:approve` |

## 5. Qué se probó

En la prueba del 19/11/2026 contra `sistemas-telpin/superov` (project 4) se corrieron soporte, análisis (con preguntas al cliente),
desarrollo, testing, `cancel` y `list`, hasta el commit local de la rama. Un agente hizo de analista, de soporte y de cliente.

**No se probó:** `/orqen:review`, la decisión del senior con `orqen approve`, el merge, la entrega ni el cierre por el cliente. Tampoco
la parte que usa `gh` (abrir el PR y leer CI y merge), porque la máquina de prueba no lo tenía instalado.
