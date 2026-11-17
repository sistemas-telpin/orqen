---
description: Prepare a visual review of the SIS end-to-end tests and collect explicit approval from the reviewer
argument-hint: SIS-3312
allowed-tools: Bash(orqen:*), Bash(git status:*), Bash(git branch:*), Bash(git diff:*), Bash(git log:*), Bash(npm:*), Bash(npx:*), Read, Grep, Glob, AskUserQuestion
---

Prepare a visual review of the end-to-end tests for `$ARGUMENTS`. The human reviewer controls test edits and approval. Follow the workflow in `AGENTS.md`.

## Rules

- **Talk to the person in their system language.** Run `orqen lang` once at the start (`es` = Spanish, `en` = English; the stage context also has it as `language`) and use it for every message, question, and option. Keep commands, state names, and paths as they are. Files and texts for Jira follow their own rules.
- **Work with the person who invoked this command.** Before each important step, tell them what you are about to do and wait for their OK. When in doubt, ask them (with `AskUserQuestion` when available: concrete options plus your recommendation); never assume what you can ask. After each step, report what you did and what comes next.
- Leave the request stage unchanged. Do not run `orqen take`, `complete`, `block`, or `release` during the review.
- Leave test edits to the reviewer. Use Jira for read-only access and leave Git writes, branch changes, and OpenSpec archiving to orqen.
- Report missing coverage and failures as observed. Wait for explicit approval of a passing run after any manual edits.

## Steps

1. Validate the SIS or REC key and run `orqen status <KEY>`. Continue only for a development request in `TESTING` or `CODE_REVIEW`. Record the branch, lane, change, and round.
2. Check that the current branch matches the request branch. If it differs, ask the user to switch and stop. Report pending changes unrelated to the end-to-end tests.
3. List the OpenSpec scenarios for the light and full lanes, or the acceptance criteria from `orqen/work/<KEY>/round-<N>/analysis.md` for the direct lane.
4. Detect the project's test runner and review the tests changed by the request. Match each scenario to a test by file and name, and check its assertions against the expected behavior.
5. Start the project with `orqen env up --all` (it starts every process in `orqen/config.yaml`, including the frontend, waits until they respond, and runs migrations and seed; `orqen env status` shows each log). Do not ask the reviewer to start anything by hand. Use the runner's supported headed mode, traces, screenshots, or video. Run the tests you can run and record the commands and artifact paths.
6. Give the reviewer a table of scenarios, tests, commands, and expected screen behavior. Flag missing assertions, fragile selectors, fixed waits, and order-dependent tests. Ask the reviewer to make any corrections directly on the branch.
7. Rerun after edits and verify that each scenario still has coverage. If the reviewer rejects the result, summarize the required development work and stop. If they approve a passing run, give them the approver, changed files, final coverage, and next stage. When the review ends, stop the processes with `orqen env down`.
8. If the reviewer edited tests, the edits stay uncommitted on the branch. `orqen pr` (`/orqen:pr`) commits and pushes them with the integration PR, which is the PR the senior reviews. If that PR is already open, remind the reviewer to run `/orqen:pr` again so the edits are added to it.
