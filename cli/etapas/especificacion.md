## Spec del change de OpenSpec — carril [liviano|completo]

`orqen lane` ya creó la rama y el change `<cambio>`. Tu trabajo es completar sus artefactos **con el analista** (mostrale lo que escribís y ajustá lo que pida). Seguís dentro de la etapa ANALISIS: cuando la spec valide, producí la salida del análisis (`especificacion` + `listo` + `analista_ok`).

1. Seguí el flujo **propose** de OpenSpec sobre ese change (si tu herramienta tiene el skill/comando `openspec-propose` o `/opsx:propose`, usalo indicando el change; si no, a mano):
   - `openspec status --change <cambio> --json` → orden de artefactos.
   - Para cada artefacto `ready`: `openspec instructions <artefacto> --change <cambio> --json` y escribí el archivo en `resolvedOutputPath` respetando `template`, `instruction` y `rules`.
   - Artefactos (schema spec-driven): `proposal.md` → `specs/<capacidad>/spec.md` (deltas) + `design.md` → `tasks.md`.
2. Alcance según el carril:
   [liviano] - **Liviano**: `proposal.md` corto, deltas solo de lo que cambia, `tasks.md` con pocas tareas. `design.md` mínimo (Context, Decisions y Risks en una o dos líneas cada uno: "sin decisiones de diseño relevantes" si es cierto); OpenSpec lo exige igual.
   [completo] - **Completo**: `design.md` real, con decisiones y alternativas descartadas, migraciones, riesgos y plan de despliegue. Un delta por capacidad afectada.
3. Reglas del proceso REC (además de las de OpenSpec):
   - **Cada criterio de aceptación del análisis debe ser al menos un `#### Scenario:`** con WHEN/THEN en algún spec delta.
   - Para capacidades existentes usá el path exacto de `openspec list --specs` y `## MODIFIED Requirements`.
   - **Cada tarea de `tasks.md` termina con su estimación en horas**, ej. `- [ ] 1.1 Endpoint de exportación (4h)`. Incluí tareas de tests y de documentación. Sé conservador.
   - En `proposal.md` referenciá el REC (`<KEY>`) en *Why*.
4. Validá: `openspec validate <cambio> --strict`. Corregí hasta que pase.
5. Si hay feedback de rechazo (`feedback_humano[].rechazo`) o de una ronda anterior, actualizá los artefactos existentes atendiendo cada punto; no crees otro change.
6. **No implementes código** ni hagas commits; el proceso commitea la spec cuando cierra el análisis.
