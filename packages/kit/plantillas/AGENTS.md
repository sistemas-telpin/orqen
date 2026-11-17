## Proceso REC (requerimientos del cliente)

Este repo procesa los REC (requerimientos del cliente que llegan por Jira) con un proceso fijo:

```
ANALISIS ⇄ ESPERA_CLIENTE ──(OK del analista: carril + spec si corresponde + SIS)──▶ DESARROLLO ⇄ TESTING
   → REVISION_CODIGO → ENTREGA → CONFORMIDAD → CERRADO        (cualquier problema → BLOQUEADO)
```

**El análisis lo conduce un analista.** Se dispara con `/orqen:analizar REC-1234` (plugin `orqen`; en otros agentes:
*"analizá el REC-1234"*, que equivale a `orqen analizar REC-1234`). No es un trámite automático:

1. **Grilling**: leés el REC (Jira por MCP **solo lectura**, o `orqen buscar`) y el repo, y entrevistás al analista
   (skill `orqen:grilling`) hasta cerrar las dudas. Lo que solo puede contestar el cliente va como pregunta (ESPERA_CLIENTE).
2. **OK del analista** al análisis. Sin OK explícito no se avanza.
3. **Propuesta de carril** (el analista confirma):

   | Carril | Cuándo | Qué se genera |
   |---|---|---|
   | `directo` | Cambio acotado, un componente, ≲ 4 h, sin cambio de contrato, bajo riesgo | **Sin OpenSpec.** Plan + criterios de aceptación en el análisis y en el SIS |
   | `liviano` | Cambia comportamiento pero es acotado (1–2 capacidades, ≲ 2 días) | Change de OpenSpec compacto (proposal + deltas + tasks; design mínimo) |
   | `completo` | Varias capacidades, datos/integraciones, seguridad o facturación, > 2 días, decisiones de arquitectura | Change de OpenSpec completo (proposal + specs + design + tasks) |

   Con `liviano`/`completo`: `orqen carril <KEY> <carril>` crea la rama y el change, y escribís la spec con el analista.
4. **Cierre** (`orqen completar`): crea el **SIS** (issue de desarrollo en `SIS_PROYECTO`), lo **vincula al REC**, deja el
   registro en **`factory/<KEY>/`** y pasa a DESARROLLO. El REC sigue siendo el dueño de la conversación con el cliente
   (vinculado hasta `CONFORMIDAD`); el SIS recibe el seguimiento técnico (`TRANSICIONES_SIS`). `orqen tomar` lo informa en el contexto (`sis`).
   Si el cliente rechaza la conformidad, la ronda nueva vuelve a ANALISIS y genera un SIS nuevo.

**Carril operativo (`via: operativa`).** Si el REC se resuelve sin cambiar código (script SQL, corrección de datos,
reinicio, configuración), el análisis lo marca (carril `directo`, sin spec) y el flujo es:

```
ANALISIS → EJECUCION → APROBACION_EJECUCION → APLICACION → VERIFICACION → CONFORMIDAD → CERRADO
```

Sin OpenSpec, rama, tests ni PR (el SIS igual se crea al cerrar el análisis). Vos **proponés** (script + rollback + verificación) y después
**verificás en solo lectura**; una persona autoriza (`APROBADORES_EJECUCION`) y **aplica**. Nunca ejecutes SQL que modifique datos ni
toques servicios. Si la verificación demuestra que la causa es de código, el REC vuelve a ANALISIS (nace un SIS de desarrollo).

**Registro en `factory/<KEY>/`** (se commitea con la rama del REC): `estado.json` (proyección del estado), `bitacora.md`
(una línea por transición) y `ronda-N/analisis.md|json` (resumen, criterios, decisiones del grilling, carril, SIS; en el carril
operativo también `ronda-N/ejecucion/`). Lo escribe `orqen`; la fuente de verdad operativa sigue siendo `.orqen/estado/`.

**Vos trabajás en las etapas ANALISIS (con el analista), DESARROLLO, TESTING, ENTREGA, EJECUCION y VERIFICACION.** Las demás son
aprobaciones humanas en Jira (`/aprobar`, `/rechazar <motivo>`) y las maneja `orqen`.
La especificación se hace con **OpenSpec**: en los carriles liviano y completo cada REC es un *change* en `openspec/changes/`.

### Cómo trabajar un REC

1. `orqen pendientes` → lista los REC con trabajo, separados entre *para analizar* y *para un agente*.
2. **Análisis**: `orqen analizar <KEY> --analista "<nombre>"` → reserva el REC e imprime las instrucciones, el contexto
   completo (issue, comentarios, feedback) y el JSON Schema de la salida. Seguilas al pie de la letra.
   **Otras etapas**: `orqen tomar <KEY>` (hace lo mismo y además prepara rama y tests). `tomar` no sirve para ANALISIS.
3. Escribí tu salida en un archivo JSON y corré `orqen completar <KEY> <archivo.json>`.
   Si responde con errores, corregí (la salida o los archivos de OpenSpec) y repetí hasta que diga `✔`.
4. Una etapa por vez: después de `completar`, terminá. No sigas con la etapa siguiente aunque esté disponible.
5. Si no podés avanzar: `orqen bloquear <KEY> "motivo concreto"`.

### Reglas

- **Nunca** escribas en Jira (tampoco por MCP: el MCP es de solo lectura), ni hagas `git commit/push/checkout/reset/rebase`,
  ni cambies de rama, ni corras `openspec archive`. `orqen` lo hace en el momento correcto (incluida la creación del SIS y su vínculo con el REC).
- **Nunca** edites `.orqen/estado/`, `factory/` ni la configuración de orqen (`orqen.yaml`, `.orqen/`) como parte de un REC.
- **Nunca** cierres un análisis sin el OK explícito del analista al análisis y al carril.
- No inventes información del cliente. Lo que falte es una pregunta (ANALISIS) o un supuesto explícito.
- Las specs en `openspec/specs/` son la fuente de verdad del comportamiento actual: leelas antes de proponer cambios.
- Escribí en español rioplatense, claro y profesional. Mantené en inglés los encabezados estructurales
  de OpenSpec y las palabras SHALL/MUST.
- Sin red salvo lo que pida la etapa (instalar dependencias del proyecto si hace falta para correr tests).

## Entornos y tests

Los entornos del proyecto están en `orqen.yaml` (sección `entornos`) y se levantan con Docker Compose
(`docker-compose.orqen.yml`). **No le pidas a una persona que abra una terminal ni que levante nada**: usá

```sh
orqen entorno preparar                       # instala dependencias de cada componente
orqen entorno levantar                       # servicios y apps, espera los healthchecks, corre migraciones y seed
orqen entorno tests [unitarios|integracion|e2e|visual]
orqen entorno estado
orqen entorno bajar                          # al terminar la etapa
```

Stack detectado al inicializar:

{{RESUMEN_STACK}}

