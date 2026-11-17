---
description: Review the SIS integration PR for the senior and report whether the changes are sound or list each problem with its possible solutions
argument-hint: SIS-32
allowed-tools: Bash(orqen:*), Bash(git fetch:*), Bash(git diff:*), Bash(git log:*), Bash(git show:*), Bash(git status:*), Bash(git branch:*), Bash(gh pr view:*), Bash(gh pr diff:*), Bash(orqen env test:*), Read, Grep, Glob, Write
---

Review the integration PR for `$ARGUMENTS` on behalf of the senior who runs this command. Tell them whether the changes are sound and, for each problem, explain it with possible solutions. The senior decides: you give them a report, and they comment `/approve` or `/reject` in Jira. Follow the workflow in `AGENTS.md`.

## Rules

- Read-only on code. Do not edit code or tests, even when the fix is obvious: propose it as a solution. The only file you write is the report, in a temporary file, to record it with `orqen review`.
- Do not comment on, approve, or merge the PR (`gh pr review`, `gh pr comment`, and `gh pr merge` are not allowed). Use Jira for read-only access.
- Leave the request stage unchanged. Do not run `orqen take`, `complete`, `block`, or `release`. Leave Git writes, branch changes, and OpenSpec archiving to orqen.
- Base every finding on code you read, with its location (`file:line`). If something looks wrong but you cannot confirm it, mark it `to verify` and say what to check. Skip style issues that a linter already enforces.

## Steps

1. Validate the SIS or REC key. Run `orqen status <KEY>` and continue only for a development request in `CODE_REVIEW`. Otherwise, report the stage and stop.
2. Run `orqen pr <KEY>` to read the branch, base, lane, analysis path, spec change, and PR URL (`existing`). If there is no PR, tell the senior to open it with `/orqen:pr <KEY>` and stop.
3. Run `git fetch origin` and review the remote branch, so the senior does not need to switch branches: `git log origin/<base>..origin/<branch> --oneline`, `git diff origin/<base>...origin/<branch> --stat`, and the diff of each relevant file. Use `gh pr view` and `gh pr diff` when available to confirm you are reviewing what the PR contains. If the local branch has unpushed changes, say that the review covers the PR only.
4. Review the diff against:
   - the analysis (summary, acceptance criteria, grilling decisions, and risks) and, for the light and full lanes, `proposal.md`, `design.md`, and the scenarios in the spec deltas; for the direct lane, the plan;
   - the PR explanation in `orqen/work/<KEY>/round-<N>/devel-pr.md`: does it describe what the diff contains?
   - the repository conventions (`AGENTS.md`, `CLAUDE.md`, linters, and neighboring code).
5. Look for, in this order:
   - **Correctness**: logic that misses a scenario or criterion, edge cases (null, empty, limits, concurrency), swallowed or misreported errors, and regressions in existing code the change touches.
   - **Security and data**: injection (SQL, shell, HTML), missing permission checks or validation, secrets in code, and migrations that cannot be rolled back or that break existing data.
   - **Scope**: changes outside the request, and deviations from the spec or plan that the PR does not explain.
   - **Tests**: scenarios or criteria without a test, tests that do not check the THEN, and fragile tests. Run tests or linters with `orqen env test` when you need them to back a claim.
   - **Maintainability**: duplication, dead code, debug leftovers, and names or structures that contradict the repository conventions, only when the impact is real.
6. Verify each finding before reporting it. Re-read the code in context (callers and prior validation) and describe the concrete failing scenario (input or state → wrong result). If you cannot build that scenario, mark it `to verify` or drop it.
7. Give the senior the report:
   - **Verdict**, in one line: `Approvable`, `Approvable with minor changes`, or `Reject`, with the reason.
   - **Summary**: what the PR does, whether it meets the request, and how well tests cover it.
   - **Findings**, most severe first. For each:
     - `#N` · **severity** (`blocking`: breaks a criterion, security, or data · `important`: a likely bug or debt that should not be merged · `minor`: an improvement · `to verify`) · `file:line`;
     - **What happens**: the problem in one or two sentences;
     - **Why it matters**: the concrete failing scenario, or the criterion or scenario it breaks;
     - **Possible solutions**: one to three concrete options (what to change and where, with a short snippet if it helps) and their cost or trade-off. Put the recommended option first and mark it.
   - **What is good**: two or three lines, only when useful.
   - If there are no findings, say so plainly.
8. If the verdict is not `Approvable`, draft a `/reject <reason>` for Jira with the blocking and important findings (number, location, problem, and recommended solution, one line each). Jira passes that text back to development as feedback. If the verdict is approvable, remind the senior to comment `/approve` on the REC. The senior posts it, not you.
9. Stay available while the senior digs into a finding, drops one, or asks for another area to be reviewed, and update the report with their decisions.
10. When the senior accepts the report, write it to a temporary file with the verdict, summary, findings with their solutions, and the `/reject` text when there is one. Record it once:

    ```sh
    orqen review <KEY> <report.md> --verdict <approve|minor|reject> --agent code-review
    ```

    orqen saves it as `orqen/work/<KEY>/round-<N>/code-review-<n>.md` (numbered, so a later review does not overwrite it), commits it when the repository is on the request branch, and comments it on the SIS. It does not change the stage. Running it again records another review. If orqen reports that the Jira comment failed, the report is still saved: ask the senior to paste it manually. Do not continue with delivery or fix anything.
