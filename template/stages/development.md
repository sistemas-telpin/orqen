## Development (`DEVELOPMENT`)

The analysis is approved. The context includes the branch (`branch`), lane (`lane`), linked implementation issue (`sis`), and tasks (`tasks`).

1. Read `previous_stages.ANALYSIS` and consult `orqen/work/<KEY>/` for details.
2. For `light` or `full`, follow OpenSpec's apply workflow using `openspec-apply-change`, `/opsx:apply`, or `openspec instructions apply --change <change> --json`. Read the proposal, design, specs, and tasks, and check off each completed task in `tasks.md`. `orqen complete` rejects incomplete tasks.
3. For `direct`, implement the analysis `plan` in order. Follow the repository conventions and its `AGENTS.md` and `CLAUDE.md`.
4. Write automated tests for each acceptance criterion or Scenario. Name tests so their coverage is recognizable.
5. `orqen take` prepared the environment. Read `environment.variables` for connection details and `environment.commands` for test commands. If `environment.ok` is false, read `environment.detail` and `environment.output`. Fix code issues or block the request if infrastructure prevents progress.
6. Address failed `test_result`, feedback in `previous_stages.TESTING`, or a rejection in `human_feedback` first. Run `orqen env test [unitarios|integracion|e2e|visual]` and the project linters before completing the stage.
7. Leave Git operations, OpenSpec archiving, and writes to `orqen/state/` and `orqen/work/` to orqen. It shuts down the development environment when the stage completes.
8. If an issue prevents progress, such as missing access or contradictory requirements, return `completed: false` with `blocker`.
