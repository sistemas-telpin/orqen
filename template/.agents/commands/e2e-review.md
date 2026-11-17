---
description: Prepara la validación visual de los tests e2e generados en la implementación de un SIS y espera la aprobación (con los ajustes hechos a mano) del diseñador de testing e2e
argument-hint: SIS-3312
allowed-tools: Bash(./cli/bin/orqen:*), Bash(git status:*), Bash(git branch:*), Bash(git diff:*), Bash(git log:*), Bash(npm:*), Bash(npx:*), Read, Grep, Glob
---

Vas a **preparar la revisión visual de los tests e2e del SIS `$ARGUMENTS`** para que la haga el **diseñador de testing e2e** (una persona), y vas a **esperar su aprobación**. Seguí el proceso de `AGENTS.md` ("Proceso REC"). Estás parado en la raíz del repo.

Los tests e2e los generó el agente durante DEVELOPMENT a partir de los Scenarios / criterios de aceptación. Un test que pasa no garantiza que pruebe lo correcto: esta revisión es el control humano. **El diseñador manda**: puede ajustar los tests a mano, y su versión es la que vale.

## Reglas que no se negocian

- **Este comando no mueve el proceso.** No corras `orqen take`, `complete`, `block` ni `release`: el estado del REC no cambia acá.
- **Vos no editás los tests e2e.** Los ajustes los hace el diseñador a mano. Tu trabajo es dejar todo listo, ejecutar lo que pida y volver a correr tras sus cambios. Si ves un problema, se lo señalás; no lo corregís.
- Jira es de solo lectura para vos (también por MCP). Prohibido: `git commit/push/checkout/reset/rebase`, `openspec archive`, editar `cli/.state/`, `orqen/work/` o los scripts de `cli/`.
- **No des la aprobación por el diseñador.** Sin un OK explícito y reciente, no hay aprobación. Si dudás de que lo haya dado, preguntá.
- No inventes: si no encontrás tests e2e o un escenario no tiene ninguno, decilo tal cual.

## Pasos

1. Validá que el argumento tenga forma `SIS-<número>` (o el prefijo del proyecto SIS configurado); si no, pedilo y cortá. También se acepta la key del REC.
2. Mirá el estado, sin tomar nada:
   ```sh
   ./cli/bin/orqen status <SIS>
   ```
   - `desconocido`: ese SIS no está asociado a ningún REC de este repo; frená.
   - Seguí solo si `estado` es `TESTING` o `CODE_REVIEW` y la vía es de desarrollo. Si es anterior (`ANALYSIS`, `DEVELOPMENT`…) todavía no hay tests para revisar; si es `DELIVERY` o posterior, los ajustes ya no entran en el PR. Decile al usuario en qué etapa está y cortá.
   - Anotá `branch`, `lane`, `change` y la ronda.
3. Confirmá que el repo está en la rama del REC (`git branch --show-current` debe coincidir con `branch`). Si no, pedile al usuario que cambie de rama (vos no podés) y cortá. Avisá si hay cambios sin commitear que no sean de e2e.
4. **Qué hay que cubrir.** Armá la lista de lo que los e2e deben demostrar, con la misma fuente que usa testing:
   - carril `light` / `full`: los `#### Scenario:` de `openspec/changes/<change>/specs/**` (o del archivo si ya se archivó);
   - carril `direct`: los criterios de aceptación de `orqen/work/<KEY>/round-<N>/analysis.md`.
5. **Qué hay.** Detectá el framework e2e del repo (por ejemplo `playwright.config.*`, `cypress.config.*`, o el que declare `package.json`) y los tests e2e que cambió la rama (`git diff --name-only <base>...HEAD`, con `BASE_BRANCH` o `main`). Leé esos tests y mapeá **cada escenario/criterio ↔ test e2e** (`archivo::nombre`) comprobando leyendo el código que el test realmente verifica el THEN, no solo que exista.
6. **Preparalo para ver.** Averiguá cómo se corre el e2e en modo visual en este repo (headed, UI mode, `--debug`, trace viewer, video/screenshots: lo que ofrezca el framework y los scripts de `package.json`) y dejá listos:
   - la preparación previa si hace falta (servidor de la app, datos de prueba, variables): no cambies datos de ambientes reales; si el e2e necesita algo que no podés levantar vos, decile al diseñador qué falta;
   - el comando exacto por test o por grupo, ordenado como la lista del paso 4;
   - una corrida completa que deje artefactos revisables (trazas, capturas o video) y dónde quedaron.
   Corré lo que pueda correr en el entorno; lo que requiera mirar la pantalla en vivo se lo dejás armado al diseñador.
7. **Entregá la guía de revisión** al usuario (el diseñador), corta y accionable:
   - SIS, REC, rama, carril y cómo levantar el entorno;
   - una tabla `escenario / criterio → test e2e → comando para verlo → qué tiene que ver en pantalla (el THEN)`;
   - lo que detectaste: escenarios sin e2e, tests que no verifican el THEN, selectores frágiles, esperas fijas (`sleep`), tests que dependen del orden o de datos que no crean. Marcá cada uno como _observación_, no lo arregles;
   - cómo ajustar: _"editá los tests directamente en tu working tree de esta rama; avisame cuando termines"_.
8. **Esperá al diseñador.** Con sus respuestas:
   - **Hizo ajustes**: volvé a correr los e2e (y la suite si tocó helpers compartidos) y mostrale el resultado; revisá `git diff` de lo que cambió y confirmá que sigue cubriendo todos los escenarios del paso 4. Si algo dejó de cubrirse o falla, decíselo y volvé a esperar.
   - **Pidió ver algo de nuevo**: repetí el paso 6 para eso.
   - **Rechazó** (o dice que falta cubrir algo): resumí qué hay que corregir y cortá. Eso se resuelve en DEVELOPMENT (`/reject` en el code review, o `orqen block <KEY> "motivo"` si una persona lo decide); no lo muevas vos.
   - **Aprobó explícitamente** y la última corrida está en verde: seguí al paso 9.
9. **Cierre.** Contale al usuario, en pocas líneas y listo para pegar en el PR o en el SIS:
   - quién aprobó y que fue con los ajustes manuales (listá los archivos e2e que cambió respecto de lo generado);
   - el resultado de la última corrida y la tabla final escenario ↔ test;
   - que los ajustes quedaron **sin commitear** en la rama. `orqen` solo commitea el código en `DEVELOPMENT` y al archivar en `DELIVERY`, y el PR se abre al aprobar `TESTING`: **el diseñador debe commitearlos a mano en la rama del REC antes de que el PR salga** o no viajan con él. Recordáselo explícitamente (vos no commiteás);
   - la etapa que sigue: `CODE_REVIEW` (aprobación del senior en Jira con `/approve`).
   Una etapa por vez: no sigas con el code review ni con la entrega.
