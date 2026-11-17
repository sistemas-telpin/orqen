---
description: Implementa un SIS (etapa DEVELOPMENT): aplica la spec de OpenSpec si la tiene, o el plan del análisis si es carril directo
argument-hint: SIS-442
allowed-tools: Bash(./cli/bin/orqen:*), Bash(openspec:*), Bash(npm:*), Bash(npx:*), Read, Grep, Glob, Write, Edit, Skill
---

Vas a **implementar el SIS `$ARGUMENTS`**: la etapa DEVELOPMENT del proceso REC (`AGENTS.md`, "Proceso REC"). Estás parado en la raíz del repo.
El SIS es el issue de desarrollo que creó el análisis; `orqen` sabe a qué REC pertenece y trabaja con ese REC.

## Reglas que no se negocian

- **Jira es de solo lectura para vos** (también por MCP). Los comentarios y las transiciones del REC y del SIS los hace `orqen`.
- Prohibido: `git commit/push/checkout/reset/rebase`, cambiar de rama, `openspec archive`, editar `cli/.state/`, `orqen/work/` o los scripts de `cli/`.
- No cambies el alcance: implementás lo que dicen la spec / el plan y los criterios de aceptación. Si algo no cierra o falta una decisión, no inventes: frená y preguntale al usuario, o bloqueá.
- **Una etapa por vez**: al terminar DEVELOPMENT, `orqen complete` mueve el estado y vos cortás. No sigas con TESTING.

## Pasos

1. Validá que el argumento tenga forma `SIS-<número>` (o el prefijo del proyecto SIS configurado); si no, pedilo y cortá. También se acepta la key del REC.
2. Chequeá el estado **antes** de tomar nada:
   ```sh
   ./cli/bin/orqen status <SIS>
   ```
   Si dice `desconocido` o falla la resolución, explicale al usuario que ese SIS no está asociado a ningún REC de este repo y frená.
   Seguí solo si `estado` es `DEVELOPMENT` y la vía es de desarrollo (no `operational`). Si no:
   - `ANALYSIS` / `WAITING_CLIENT`: todavía falta el análisis (`/orqen:analyze <REC>`).
   - `TESTING`, `DELIVERY`, etc.: no es esta etapa; decile cuál es y cómo se sigue (`orqen take <KEY>`).
   - `EXECUTION` / `VERIFICATION`: es carril operativo, no hay código que implementar.
   - `BLOCKED`: contale el motivo (bitácora de `orqen status`).
   Cortá sin tomar el REC.
3. Tomá la etapa (reserva el REC, prepara la rama e imprime instrucciones, contexto y esquema de salida):
   ```sh
   ./cli/bin/orqen take <SIS> --agent implementador
   ```
   Si falla (lo tomó otro agente, etc.), explicá el motivo y frená.
4. Seguí al pie de la letra las instrucciones de la etapa que imprimió el paso 3. En resumen:
   - Leé `previous_stages.ANALYSIS` (resumen, criterios, decisiones, plan) y `orqen/work/<KEY>/` si necesitás detalle.
   - **Carril `light` / `full`** (hay change de OpenSpec): cargá el skill `openspec-apply-change` (o `/opsx:apply`); si no está, `openspec instructions apply --change <change> --json`. Leé proposal, design, specs y tasks. Implementá las tareas en orden y **tildá cada una en `tasks.md` (`- [x]`) al terminarla**.
   - **Carril `direct`** (sin change): implementá el `plan` del análisis en orden.
   - Respetá las convenciones del repo y las specs de `openspec/specs/` (comportamiento actual).
   - Escribí tests automáticos para **cada Scenario / criterio de aceptación**, nombrados de forma que se reconozca cuál verifican.
   - Corré los tests y linters del proyecto antes de terminar.
   - Si el contexto trae `test_result` fallido, `previous_stages.TESTING` o un rechazo en `human_feedback`, corregí eso primero.
5. Escribí la salida JSON según el esquema impreso y cerrá:
   ```sh
   ./cli/bin/orqen complete <SIS> <archivo.json> --agent implementador
   ```
   Si lista errores (p. ej. tareas sin tildar), corregilos y repetí hasta ver `✔`.
6. Cerrá contándole al usuario, en pocas líneas: qué se implementó, qué tests se agregaron y su resultado, y la etapa que sigue. Si hubo supuestos o desvíos de la spec, decilo explícitamente.

Si no se puede avanzar: `./cli/bin/orqen block <SIS> "motivo concreto"`.
