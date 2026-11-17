## Etapa ANALISIS — grilling con el analista, carril, spec y SIS

Esta etapa **la conduce una persona (el analista)**; vos sos quien la interroga y escribe. No es un trámite automático: no avanzás sin el OK explícito del analista.
Si tu herramienta tiene el skill `orqen:grilling`, usalo: define el método de la entrevista. Si no, aplicá la versión corta de abajo.

### 1. Prepará el terreno (antes de preguntar)

- Leé el issue y **toda** la conversación del contexto. Los comentarios con `es_del_agente: true` son de rondas anteriores; `feedback_humano` trae respuestas del cliente o el rechazo que motivó esta ronda.
- Si tenés el MCP de Jira, usalo **solo para leer** (issue, comentarios, vinculados, REC parecidos). Sin MCP: `orqen search '<JQL>'`. **No escribas en Jira**: lo hace `orqen`.
- Entendé el comportamiento actual: `openspec list --specs` y `openspec show <capacidad>` (fuente de verdad) y, si hace falta, el código (solo lectura).
- Todo lo que puedas contestar leyendo el repo o Jira **no se le pregunta al analista**.

### 2. Grilling (versión corta)

- De a **una pregunta por vez** (máx. 3 si son inseparables). Cada una con **tu respuesta recomendada** y por qué; el analista confirma, corrige o descarta.
- Recorré el árbol de decisiones en orden: objetivo/valor de negocio → alcance y *fuera de alcance* → quién lo usa y con qué permisos → comportamiento actual vs. deseado → casos borde y errores → datos/migración/integraciones → no funcionales → **¿se puede resolver sin tocar código?** → riesgos.
- Cuando una respuesta abre otra duda, seguí por ahí antes de pasar al próximo tema. No avances sobre supuestos sin marcarlos.
- Lo que solo puede contestar el **cliente** va a `preguntas_abiertas` (máx. 5) con `listo: false`; el REC pasa a ESPERA_CLIENTE y el analista retoma cuando respondan.
- Anotá cada decisión (`decisiones`: pregunta → respuesta) para el registro. Cortá cuando ya no queden dudas que cambien el diseño.

### 3. OK del analista

Resumí en pocas líneas: qué se hace, criterios de aceptación (Dado/Cuando/Entonces, observables y testeables), fuera de alcance, riesgos. Pedí el **OK explícito**. Sin OK, seguí preguntando; no pases a carril.

### 4. Proponé el carril y pedí confirmación

Proponé uno, con justificación, y que el analista confirme o lo cambie (ajustar estos umbrales es decisión del equipo):

| Carril | Cuándo | Qué se produce |
|---|---|---|
| **operativa** (`via: operativa`) | Se resuelve **sin cambiar código**: script SQL, corrección de datos, reinicio, configuración | Sin spec ni rama. El flujo sigue por EJECUCIÓN → aprobación → aplicación → verificación |
| **directo** | Cambio acotado: un solo componente, ≲ 4 h, sin cambio de contrato (API, datos persistentes, reglas de negocio), bajo riesgo, fácil de revertir | **Sin OpenSpec.** `plan` + criterios de aceptación en la salida; el SIS los lleva |
| **liviano** | Cambia comportamiento observable pero es acotado: 1–2 capacidades, ≲ 2 días, sin decisiones de arquitectura | Change de OpenSpec compacto: proposal + deltas + tasks (design mínimo) |
| **completo** | Varias capacidades, migración de datos, integraciones externas, seguridad/permisos/facturación, > 2 días, decisiones de arquitectura o riesgo alto | Change de OpenSpec completo: proposal + specs + design + tasks |

Ante la duda entre dos, elegí el de **más** rigor y decilo. Una vez confirmado: `analista_ok: true`.

### 5. Ejecutá el carril

- `operativa` o `directo`: no hay spec. Pasá a producir la salida.
- `liviano` o `completo`: corré `orqen lane <KEY> <carril>`. Crea la rama y el change de OpenSpec e imprime cómo escribir la spec (el analista revisa lo que escribís; ajustá lo que pida). No hagas commits: `orqen` los hace.

### 6. Salida

Producí el JSON del esquema:
- `resumen`, `tipo`, `criterios_aceptacion`, `capacidades_afectadas`, `decisiones`, `riesgos`, `preguntas_abiertas`.
- `listo: true` + `analista_ok: true` + `via` + `carril` + `justificacion_carril` solo con el OK del analista (vía operativa ⇒ `carril: "directo"`).
- Carril directo: `plan` (pasos en orden) y `estimacion_horas`.
- Carril liviano/completo: `especificacion` (`cambio` = el que asignó `orqen lane`, `resumen`, `supuestos`).

`orqen complete` valida todo (y con spec: `openspec validate --strict`, artefactos completos y horas en cada tarea). Si pasa, crea el **SIS**, lo vincula al REC, deja el registro en `orqen/work/<KEY>/` y mueve el REC a la etapa siguiente.
No toques `orqen/state/`. No hagas commit/push/checkout.
