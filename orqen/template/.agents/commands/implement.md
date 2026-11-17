---
description: Implementa un SIS (etapa DESARROLLO): aplica la spec de OpenSpec si la tiene, o el plan del análisis si es carril directo
argument-hint: SIS-442
allowed-tools: Bash(./cli/bin/rec:*), Bash(openspec:*), Bash(npm:*), Bash(npx:*), Read, Grep, Glob, Write, Edit, Skill
---

Vas a **implementar el SIS `$ARGUMENTS`**: la etapa DESARROLLO del proceso REC (`AGENTS.md`, "Proceso REC"). Estás parado en la raíz del repo.
El SIS es el issue de desarrollo que creó el análisis; `rec` sabe a qué REC pertenece y trabaja con ese REC.

## Reglas que no se negocian

- **Jira es de solo lectura para vos** (también por MCP). Los comentarios y las transiciones del REC y del SIS los hace `rec`.
- Prohibido: `git commit/push/checkout/reset/rebase`, cambiar de rama, `openspec archive`, editar `cli/.estado/`, `factory/` o los scripts de `cli/`.
- No cambies el alcance: implementás lo que dicen la spec / el plan y los criterios de aceptación. Si algo no cierra o falta una decisión, no inventes: frená y preguntale al usuario, o bloqueá.
- **Una etapa por vez**: al terminar DESARROLLO, `rec completar` mueve el estado y vos cortás. No sigas con TESTING.

## Pasos

1. Validá que el argumento tenga forma `SIS-<número>` (o el prefijo del proyecto SIS configurado); si no, pedilo y cortá. También se acepta la key del REC.
2. Chequeá el estado **antes** de tomar nada:
   ```sh
   ./cli/bin/rec estado <SIS>
   ```
   Si dice `desconocido` o falla la resolución, explicale al usuario que ese SIS no está asociado a ningún REC de este repo y frená.
   Seguí solo si `estado` es `DESARROLLO` y la vía es de desarrollo (no `operativa`). Si no:
   - `ANALISIS` / `ESPERA_CLIENTE`: todavía falta el análisis (`/orqen:analyze <REC>`).
   - `TESTING`, `ENTREGA`, etc.: no es esta etapa; decile cuál es y cómo se sigue (`rec tomar <KEY>`).
   - `EJECUCION` / `VERIFICACION`: es carril operativo, no hay código que implementar.
   - `BLOQUEADO`: contale el motivo (bitácora de `rec estado`).
   Cortá sin tomar el REC.
3. Tomá la etapa (reserva el REC, prepara la rama e imprime instrucciones, contexto y esquema de salida):
   ```sh
   ./cli/bin/rec tomar <SIS> --agente implementador
   ```
   Si falla (lo tomó otro agente, etc.), explicá el motivo y frená.
4. Seguí al pie de la letra las instrucciones de la etapa que imprimió el paso 3. En resumen:
   - Leé `etapas_previas.ANALISIS` (resumen, criterios, decisiones, plan) y `factory/<KEY>/` si necesitás detalle.
   - **Carril `liviano` / `completo`** (hay change de OpenSpec): cargá el skill `openspec-apply-change` (o `/opsx:apply`); si no está, `openspec instructions apply --change <cambio> --json`. Leé proposal, design, specs y tasks. Implementá las tareas en orden y **tildá cada una en `tasks.md` (`- [x]`) al terminarla**.
   - **Carril `directo`** (sin change): implementá el `plan` del análisis en orden.
   - Respetá las convenciones del repo y las specs de `openspec/specs/` (comportamiento actual).
   - Escribí tests automáticos para **cada Scenario / criterio de aceptación**, nombrados de forma que se reconozca cuál verifican.
   - Corré los tests y linters del proyecto antes de terminar.
   - Si el contexto trae `resultado_tests` fallido, `etapas_previas.TESTING` o un rechazo en `feedback_humano`, corregí eso primero.
5. Escribí la salida JSON según el esquema impreso y cerrá:
   ```sh
   ./cli/bin/rec completar <SIS> <archivo.json> --agente implementador
   ```
   Si lista errores (p. ej. tareas sin tildar), corregilos y repetí hasta ver `✔`.
6. Cerrá contándole al usuario, en pocas líneas: qué se implementó, qué tests se agregaron y su resultado, y la etapa que sigue. Si hubo supuestos o desvíos de la spec, decilo explícitamente.

Si no se puede avanzar: `./cli/bin/rec bloquear <SIS> "motivo concreto"`.
