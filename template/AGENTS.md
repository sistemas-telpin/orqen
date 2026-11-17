# AGENTS.md

## Proceso REC (requerimientos del cliente)

Este repo procesa los REC (requerimientos del cliente que llegan por Jira) con un proceso fijo:

```
ANALYSIS ⇄ WAITING_CLIENT ──(OK del analista: carril + spec si corresponde + SIS)──▶ DEVELOPMENT ⇄ TESTING
   → CODE_REVIEW → DELIVERY → ACCEPTANCE → CLOSED        (cualquier problema → BLOCKED)
```

**El análisis lo conduce un analista.** Se dispara con `/orqen:analyze REC-1234` (plugin `orqen`; en otros agentes:
_"analizá el REC-1234"_, que equivale a `./cli/bin/orqen analyze REC-1234`). No es un trámite automático:

1. **Grilling**: leés el REC (Jira por MCP **solo lectura**, o `orqen search`) y el repo, y entrevistás al analista
   (skill `orqen:grilling`) hasta cerrar las dudas. Lo que solo puede contestar el cliente va como pregunta (WAITING_CLIENT).
2. **OK del analista** al análisis. Sin OK explícito no se avanza.
3. **Propuesta de carril** (el analista confirma):

   | Carril     | Cuándo                                                                                                 | Qué se genera                                                               |
   | ---------- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
   | `direct`  | Cambio acotado, un componente, ≲ 4 h, sin cambio de contrato, bajo riesgo                              | **Sin OpenSpec.** Plan + criterios de aceptación en el análisis y en el SIS |
   | `light`  | Cambia comportamiento pero es acotado (1–2 capacidades, ≲ 2 días)                                      | Change de OpenSpec compacto (proposal + deltas + tasks; design mínimo)      |
   | `full` | Varias capacidades, datos/integraciones, seguridad o facturación, > 2 días, decisiones de arquitectura | Change de OpenSpec completo (proposal + specs + design + tasks)             |

   Con `light`/`full`: `orqen lane <KEY> <lane>` crea la rama y el change, y escribís la spec con el analista.

4. **Cierre** (`orqen complete`): crea el **SIS** (issue de desarrollo en `SIS_PROJECT`), lo **vincula al REC**, deja el
   registro en **`orqen/work/<KEY>/`** y pasa a DEVELOPMENT. El REC sigue siendo el dueño de la conversación con el cliente
   (vinculado hasta `ACCEPTANCE`); el SIS recibe el seguimiento técnico (`SIS_TRANSITIONS`). `orqen take` lo informa en el contexto (`sis`).
   Si el cliente rechaza la conformidad, la ronda nueva vuelve a ANALYSIS y genera un SIS nuevo.

**Carril operativo (`route: operational`).** Si el REC se resuelve sin cambiar código (script SQL, corrección de datos,
reinicio, configuración), el análisis lo marca (carril `direct`, sin spec) y el flujo es:

```
ANALYSIS → EXECUTION → EXECUTION_APPROVAL → APPLICATION → VERIFICATION → ACCEPTANCE → CLOSED
```

Sin OpenSpec, rama, tests ni PR (el SIS igual se crea al cerrar el análisis). Vos **proponés** (script + rollback + verificación) y después
**verificás en solo lectura**; una persona autoriza (`APPROVERS_EXECUTION`) y **aplica**. Nunca ejecutes SQL que modifique datos ni
toques servicios. Si la verificación demuestra que la causa es de código, el REC vuelve a ANALYSIS (nace un SIS de desarrollo).

**Registro en `orqen/work/<KEY>/`** (se commitea con la rama del REC): `state.json` (proyección del estado), `log.md`
(una línea por transición) y `round-N/analysis.md|json` (resumen, criterios, decisiones del grilling, carril, SIS; en el carril
operativo también `round-N/execution/`). Lo escribe `orqen`; la fuente de verdad operativa sigue siendo `cli/.state/`.

**Vos trabajás en las etapas ANALYSIS (con el analista), DEVELOPMENT, TESTING, DELIVERY, EXECUTION y VERIFICATION.** Las demás son
aprobaciones humanas en Jira (`/approve`, `/reject <motivo>`) y las maneja el script `orqen`.
La especificación se hace con **OpenSpec**: en los carriles liviano y completo cada REC es un _change_ en `openspec/changes/`.

### Cómo trabajar un REC

1. `./cli/bin/orqen pending` → lista los REC con trabajo, separados entre _para analizar_ y _para un agente_.
2. **Análisis**: `./cli/bin/orqen analyze <KEY> --analyst "<name>"` → reserva el REC e imprime las instrucciones, el contexto
   completo (issue, comentarios, feedback) y el JSON Schema de la salida. Seguilas al pie de la letra.
   **Otras etapas**: `./cli/bin/orqen take <KEY>` (hace lo mismo y además prepara rama y tests). `take` no sirve para ANALYSIS.
3. Escribí tu salida en un archivo JSON y corré `./cli/bin/orqen complete <KEY> <archivo.json>`.
   Si responde con errores, corregí (la salida o los archivos de OpenSpec) y repetí hasta que diga `✔`.
4. Una etapa por vez: después de `complete`, terminá. No sigas con la etapa siguiente aunque esté disponible.
5. Si no podés avanzar: `./cli/bin/orqen block <KEY> "motivo concreto"`.

### Reglas

- **Nunca** escribas en Jira (tampoco por MCP: el MCP es de solo lectura), ni hagas `git commit/push/checkout/reset/rebase`,
  ni cambies de rama, ni corras `openspec archive`. El script `orqen` lo hace en el momento correcto (incluida la creación del SIS y su vínculo con el REC).
- **Nunca** edites `cli/.state/`, `orqen/work/` ni los scripts de `cli/` como parte de un REC.
- **Nunca** cierres un análisis sin el OK explícito del analista al análisis y al carril.
- No inventes información del cliente. Lo que falte es una pregunta (ANALYSIS) o un supuesto explícito.
- Las specs en `openspec/specs/` son la fuente de verdad del comportamiento actual: leelas antes de proponer cambios.
- Escribí en español rioplatense, claro y profesional. Mantené en inglés los encabezados estructurales
  de OpenSpec y las palabras SHALL/MUST.
- Sin red salvo lo que pida la etapa (instalar dependencias del proyecto si hace falta para correr tests).
