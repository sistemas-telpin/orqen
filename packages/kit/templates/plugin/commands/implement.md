---
description: Implement a linked SIS issue using its OpenSpec change or the approved direct-lane plan
argument-hint: SIS-442
allowed-tools: Bash(orqen:*), Bash(openspec:*), Bash(npm:*), Bash(npx:*), Read, Grep, Glob, Write, Edit, Skill
---

Implement the request identified by `$ARGUMENTS` from the repository root. orqen resolves the SIS issue back to its customer request (REC). Follow the development stage in `AGENTS.md`.

## Rules

- Use Jira and Jira MCP for read-only access. orqen posts comments and updates issue transitions.
- Leave Git operations, branch changes, OpenSpec archiving, and writes to `orqen/state/`, `orqen/work/`, and orqen configuration to orqen.
- Follow the approved scope, specifications or plan, and acceptance criteria. Ask the user or block the request if you need a decision to proceed.
- Stop once `orqen complete` advances the request out of `DESARROLLO`.

## Steps

1. Check that the argument is a SIS or REC issue key. SIS keys use the configured project prefix. Ask for the key if it is missing or invalid.
2. Run `orqen status <SIS>`. If the issue cannot be resolved, explain that it is not linked to a REC in this repository and stop. Claim work only in `DESARROLLO` for a development request. Otherwise:
   - `ANALISIS` or `ESPERA_CLIENTE`: Explain that analysis must finish first.
   - `EJECUCION` or `VERIFICACION`: Explain that the request follows the operational workflow.
   - `BLOQUEADO`: Report the reason from the status history.
   - For any other stage, report it and explain how to proceed with `orqen take <KEY>`.
3. Claim the stage, which prepares the branch and environment and prints instructions, context, and the output schema:
   ```sh
   orqen take <SIS> --agent implementer
   ```
   If this fails, report the reason and stop.
4. Read `etapas_previas.ANALISIS` and the work record as needed. Address failures in `resultado_tests`, prior `etapas_previas.TESTING`, and review feedback in `feedback_humano` first.
   - For `liviano` or `completo`, use `openspec-apply-change`, `/opsx:apply`, or `openspec instructions apply --change <change> --json`. Read the proposal, design, specs, and tasks, then check off completed tasks in `tasks.md`.
   - For `directo`, follow the analysis `plan` in order.
   - Follow repository conventions and current specs. Write automated tests for each Scenario or acceptance criterion. Run `orqen env test` and project linters. Use `entorno.comandos` and `entorno.variables` from the context.
5. Write the JSON output and submit it:
   ```sh
   orqen complete <SIS> <output.json> --agent implementer
   ```
   Correct validation errors and retry until the command reports success.
6. Report the implementation, tests and results, assumptions or deviations, and the next stage.

If you cannot proceed, run `orqen block <SIS> "<specific reason>"`.
