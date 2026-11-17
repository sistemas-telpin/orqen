## Etapa DESARROLLO — implementar el carril acordado

Ya estás en la rama del REC (`rama` en el contexto). El análisis ya se cerró con el analista: el contexto trae `carril`, `sis` (el issue de seguimiento en el otro proyecto de Jira; el proceso lo actualiza solo, vos no escribís en Jira) y `tareas`.

1. Leé `etapas_previas.ANALISIS` (resumen, criterios, decisiones, plan) y `orqen/work/<KEY>/` si necesitás el detalle.
2. Según el carril:
   - **liviano / completo**: seguí el flujo **apply** de OpenSpec (skill `openspec-apply-change` / `/opsx:apply`; si no: `openspec instructions apply --change <cambio> --json`). Leé proposal, design, specs y tasks del change. Tildá cada tarea en `tasks.md` (`- [x]`) a medida que la terminás: `orqen complete` rechaza la salida si queda alguna sin tildar.
   - **directo** (no hay change): implementá el `plan` del análisis en orden. No hay `tasks.md` que tildar.
3. Respetá las convenciones del repo (y su AGENTS.md / CLAUDE.md).
4. Escribí tests automáticos para **cada criterio de aceptación / Scenario**, nombrados de forma que se reconozca cuál verifican.
5. **El entorno ya está levantado**: `orqen take` instaló dependencias, levantó los servicios (DB, colas…) con Docker y corrió migraciones. Mirá `entorno` en el contexto: `variables` (cómo conectarse) y `comandos` (cómo correr cada tipo de test). No le pidas a nadie que levante nada. Si `entorno.ok` es `false`, leé `entorno.detalle` / `entorno.salida`: arreglalo si es del código o, si es de infraestructura, bloqueá el REC.
6. Corré los tests (`orqen env test [unitarios|integracion|e2e|visual]`) y los linters del proyecto antes de terminar. Al completar la etapa, orqen baja el entorno solo.
7. Si el contexto trae `resultado_tests` fallido, `etapas_previas.TESTING` o un rechazo de revisión en `feedback_humano`, **corregí eso primero**.
8. Prohibido: `git commit/push/checkout/reset`, cambiar de rama, `openspec archive`, tocar `orqen/state/` y `orqen/work/`. El proceso se encarga.
9. Si hay un bloqueo real (falta acceso, análisis contradictorio), devolvé `completado: false` con `bloqueo`.
