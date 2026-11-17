---
description: Prepare a visual review of the SIS end-to-end tests and collect explicit approval from the reviewer
argument-hint: SIS-3312
allowed-tools: Bash(orqen:*), Bash(git status:*), Bash(git branch:*), Bash(git diff:*), Bash(git log:*), Bash(npm:*), Bash(npx:*), Read, Grep, Glob
---

Prepare a visual review of the end-to-end tests for `$ARGUMENTS`. The human reviewer controls test edits and approval. Follow the workflow in `AGENTS.md`.

## Rules

- Leave the request stage unchanged. Do not run `orqen take`, `complete`, `block`, or `release` during the review.
- Leave test edits to the reviewer. Use Jira for read-only access and leave Git writes, branch changes, and OpenSpec archiving to orqen.
- Report missing coverage and failures as observed. Wait for explicit approval of a passing run after any manual edits.

## Steps

1. Validate the SIS or REC key and run `orqen status <KEY>`. Continue only for a development request in `TESTING` or `CODE_REVIEW`. Record the branch, lane, change, and round.
2. Check that the current branch matches the request branch. If it differs, ask the user to switch and stop. Report pending changes unrelated to the end-to-end tests.
3. List the OpenSpec scenarios for the light and full lanes, or the acceptance criteria from `orqen/work/<KEY>/round-<N>/analysis.md` for the direct lane.
4. Detect the project's test runner and review the tests changed by the request. Match each scenario to a test by file and name, and check its assertions against the expected behavior.
5. Prepare the app, test data, and connection variables as needed. Use the runner's supported headed mode, traces, screenshots, or video. Run the tests you can run and record the commands and artifact paths.
6. Give the reviewer a table of scenarios, tests, commands, and expected screen behavior. Flag missing assertions, fragile selectors, fixed waits, and order-dependent tests. Ask the reviewer to make any corrections directly on the branch.
7. Rerun after edits and verify that each scenario still has coverage. If the reviewer rejects the result, summarize the required development work and stop. If they approve a passing run, give them the approver, changed files, final coverage, and next stage.
8. If the reviewer edited tests, have those edits included in the branch before integration. `orqen pr` can commit pending changes when an authorized user opens the integration PR.
