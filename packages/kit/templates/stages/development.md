## Development (`DESARROLLO`)

The analysis is approved. The context includes the branch (`rama`), lane (`carril`), linked implementation issue (`sis`), and tasks (`tareas`).

1. Read `etapas_previas.ANALISIS` and consult `orqen/work/<KEY>/` for details.
2. For `liviano` or `completo`, follow OpenSpec's apply workflow using `openspec-apply-change`, `/opsx:apply`, or `openspec instructions apply --change <change> --json`. Read the proposal, design, specs, and tasks, and check off each completed task in `tasks.md`. `orqen complete` rejects incomplete tasks.
3. For `directo`, implement the analysis `plan` in order. Follow the repository conventions and its `AGENTS.md` and `CLAUDE.md`.
4. Write automated tests for each acceptance criterion or Scenario. Name tests so their coverage is recognizable.
5. `orqen take` prepared the environment. Read `entorno.variables` for connection details and `entorno.comandos` for test commands. If `entorno.ok` is false, read `entorno.detalle` and `entorno.salida`. Fix code issues or block the request if infrastructure prevents progress.
6. Address failed `resultado_tests`, feedback in `etapas_previas.TESTING`, or a rejection in `feedback_humano` first. Run `orqen env test [unitarios|integracion|e2e|visual]` and the project linters before completing the stage.
7. Leave Git operations, OpenSpec archiving, and writes to `orqen/state/` and `orqen/work/` to orqen. It shuts down the development environment when the stage completes.
8. If an issue prevents progress, such as missing access or contradictory requirements, return `completado: false` with `bloqueo`.
