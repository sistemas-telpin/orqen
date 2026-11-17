---
description: Implement a linked SIS issue using its OpenSpec change or the approved direct-lane plan
argument-hint: SIS-442
allowed-tools: Bash(orqen:*), Bash(openspec:*), Bash(npm:*), Bash(npx:*), Read, Grep, Glob, Write, Edit, Skill, AskUserQuestion
---

Implement the request identified by `$ARGUMENTS` from the repository root. orqen resolves the SIS issue back to its customer request (REC). Follow the development stage in `AGENTS.md`.

## Rules

- **Work with the person who invoked this command.** Before each important step, tell them what you are about to do and wait for their OK. When in doubt, ask them (with `AskUserQuestion` when available: concrete options plus your recommendation); never assume what you can ask. After each step, report what you did and what comes next.
- Use Jira and Jira MCP for read-only access. orqen posts comments and updates issue transitions.
- Leave Git operations, branch changes, OpenSpec archiving, and writes to `orqen/state/`, `orqen/work/`, and orqen configuration to orqen.
- Follow the approved scope, specifications or plan, and acceptance criteria. Ask the user or block the request if you need a decision to proceed.
- Stop once `orqen complete` advances the request out of `DEVELOPMENT`.

## Steps

1. Check that the argument is a SIS or REC issue key. SIS keys use the configured project prefix. Ask for the key if it is missing or invalid.
2. Run `orqen status <SIS>`. If the issue cannot be resolved, explain that it is not linked to a REC in this repository and stop. Claim work only in `DEVELOPMENT` for a development request. Otherwise:
   - `ANALYSIS` or `WAITING_CLIENT`: Explain that analysis must finish first.
   - `EXECUTION` or `VERIFICATION`: Explain that the request follows the operational workflow.
   - `BLOCKED`: Report the reason from the status history.
   - For any other stage, report it and explain how to proceed with `orqen take <KEY>`.
3. Claim the stage, which prepares the branch and environment and prints instructions, context, and the output schema:
   ```sh
   orqen take <SIS> --agent implementer
   ```
   If this fails, report the reason and stop.
4. **Before touching code, show the person your plan** (files you will change, in what order, which tests you will add, and anything in the spec that is not clear) and **wait for their OK**. Then report as you finish each task or group of tasks.
   Read `previous_stages.ANALYSIS` and the work record as needed. Address failures in `test_result`, prior `previous_stages.TESTING`, and review feedback in `human_feedback` first.
   - For `light` or `full`, use `openspec-apply-change`, `/opsx:apply`, or `openspec instructions apply --change <change> --json`. Read the proposal, design, specs, and tasks, then check off completed tasks in `tasks.md`.
   - For `direct`, follow the analysis `plan` in order.
   - Follow repository conventions and current specs. Write automated tests for each Scenario or acceptance criterion. Run `orqen env test` and project linters. Use `environment.commands` and `environment.variables` from the context.
5. Show the person a summary (what was implemented, tests and results, assumptions or deviations) and **ask for their OK to close the stage**. With their OK, write the JSON output and submit it:
   ```sh
   orqen complete <SIS> <output.json> --agent implementer
   ```
   Correct validation errors and retry until the command reports success.
6. Report the implementation, tests and results, assumptions or deviations, and the next stage.

If you cannot proceed, run `orqen block <SIS> "<specific reason>"`.
