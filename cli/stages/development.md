## Etapa DEVELOPMENT — implementar el carril acordado

Ya estás en la rama del REC (`branch` en el contexto). El análisis ya se cerró con el analista: el contexto trae `lane`, `sis` (el issue de seguimiento en el otro proyecto de Jira; el proceso lo actualiza solo, vos no escribís en Jira) y `tasks`.

1. Leé `previous_stages.ANALYSIS` (resumen, criterios, decisiones, plan) y `orqen/work/<KEY>/` si necesitás el detalle.
2. Según el carril:
   - **liviano / completo**: seguí el flujo **apply** de OpenSpec (skill `openspec-apply-change` / `/opsx:apply`; si no: `openspec instructions apply --change <change> --json`). Leé proposal, design, specs y tasks del change. Tildá cada tarea en `tasks.md` (`- [x]`) a medida que la terminás: `orqen complete` rechaza la salida si queda alguna sin tildar.
   - **direct** (no hay change): implementá el `plan` del análisis en orden. No hay `tasks.md` que tildar.
3. Respetá las convenciones del repo (y su AGENTS.md / CLAUDE.md).
4. Escribí tests automáticos para **cada criterio de aceptación / Scenario**, nombrados de forma que se reconozca cuál verifican.
5. Corré los tests y linters del proyecto antes de terminar.
6. Si el contexto trae `test_result` fallido, `previous_stages.TESTING` o un rechazo de revisión en `human_feedback`, **corregí eso primero**.
7. Prohibido: `git commit/push/checkout/reset`, cambiar de rama, `openspec archive`, tocar `cli/.state/` y `orqen/work/`. El proceso se encarga.
8. Si hay un bloqueo real (falta acceso, análisis contradictorio), devolvé `completed: false` con `blocker`.
