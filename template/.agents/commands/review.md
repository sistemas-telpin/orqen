---
description: QA review of a full-lane request - check that the e2e tests prove what was asked, show them on screen, and record QA's approval or rejection
argument-hint: <KEY>
allowed-tools: Bash(orqen:*), Bash(git status:*), Bash(git branch:*), Bash(git diff:*), Bash(git log:*), Bash(npm:*), Bash(npx:*), Read, Grep, Glob, Write, AskUserQuestion
---

Run the QA review of `$ARGUMENTS` with the QA person who invoked this command. It applies to the **full lane** only: QA checks that the tests prove what the client asked, sees the e2e tests run on screen, and approves (the request goes on to the senior) or rejects (it goes back to development). QA controls test edits and the verdict. Follow the workflow in `AGENTS.md`.

## Rules

- **Talk to the person in their system language.** Run `orqen lang` once at the start (`es` = Spanish, `en` = English; the stage context also has it as `language`) and use it for every message, question, and option. Keep commands, state names, and paths as they are. Files and texts posted on the tickets follow their own rules.
- **Work with the person who invoked this command.** Before each important step, tell them what you are about to do and wait for their OK. When in doubt, ask them (with `AskUserQuestion` when available: concrete options plus your recommendation); never assume what you can ask. After each step, report what you did and what comes next.
- Do not run `orqen take`, `complete`, `block`, or `release`. The only command that records the verdict is `orqen qa`.
- Leave test edits to QA. Read the tickets read-only and leave Git writes, branch changes, and OpenSpec archiving to orqen.
- Report missing coverage and failures as observed. A verdict of `approve` needs QA's explicit approval of a passing run after any manual edits.

## Steps

1. Validate the key (external or internal ticket) and run `orqen status <KEY> --json`. Continue only when `state` is `CODE_REVIEW`, `lane` is `full`, and `artifacts.devel_pr` is set. Otherwise:
   - another lane: say that only the full lane goes through QA and that the senior reviews it with `/orqen:approve <KEY>`; stop;
   - no PR yet: say that development opens it with `/orqen:pr <KEY>`; stop;
   - another state: report it and its `next` command; stop.
2. Check that the current branch matches the request branch. If it differs, ask the person to switch (`git checkout <branch>`) and stop. Report pending changes unrelated to the e2e tests.
3. List the scenarios: the OpenSpec scenarios of the change (`openspec/changes/<change>/specs/**`). Detect the project's test runner and match each scenario to an e2e test of the branch by file and name. Check that each test's assertions verify the expected result (the THEN), not just that the page loads.
4. Start the project with `orqen env up --all` (it starts every process in `orqen/config.yaml`, waits until they respond, and runs migrations and seed; `orqen env status` shows each log). Do not ask QA to start anything by hand. Run the e2e tests with a visible browser, traces, and video (the runner's headed mode). Record the commands and where the traces and videos are.
5. Give QA a table: scenario · test · what should be seen on screen · result. Point out scenarios without a test, tests that do not check the result, fragile selectors, fixed waits, and order-dependent tests. QA decides and adjusts tests by hand on the branch; rerun after their edits.
6. Ask QA for the verdict:
   - **Approve** (only with a passing run): write a temporary Markdown report with the scenarios, their tests, the final run (commands, result, traces/videos), and the edits QA made. Record it:
     ```sh
     orqen qa <KEY> <report.md> --verdict approve --agent qa
     ```
   - **Reject**: write what development has to fix (scenario, problem, expected behavior), show it to QA, adjust it until they approve the text, and record it:
     ```sh
     orqen qa <KEY> <report.md> --verdict reject --agent qa
     ```
     The request goes back to development with that text as the indication.
   orqen saves the report as `orqen/work/<KEY>/round-<N>/qa-<n>.md`, comments it on the tickets, and records QA by their Git name (`--person "<name>"` overrides it).
7. If QA edited tests, the edits stay uncommitted on the branch: remind them to run `/orqen:pr <KEY>` again so they are added to the PR. Stop the processes with `orqen env down` and report the next step: approved → the senior, with `/orqen:approve <KEY>`; rejected → development, with `/orqen:implement <KEY>`.
