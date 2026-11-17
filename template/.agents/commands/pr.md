---
description: Write an explanation of the implemented SIS and ask orqen to open its integration pull request
argument-hint: SIS-32
allowed-tools: Bash(orqen:*), Bash(git diff:*), Bash(git log:*), Bash(git status:*), Bash(git branch:*), Bash(git show:*), Read, Grep, Glob, Write
---

Prepare the integration PR for `$ARGUMENTS` from the repository root. `orqen pr` targets `DEVEL_BRANCH` and is separate from the code review PR opened after testing. Follow the workflow in `AGENTS.md`.

## Rules

- Let `orqen pr` commit, push, and open the PR. Use Jira for read-only access. Leave branch changes, OpenSpec archiving, and workflow files to orqen.
- Describe the actual diff. Identify deviations from the specification or plan, and report only test results you observed.

## Steps

1. Validate the SIS or REC key. Run `orqen pr <KEY>` to read the branch, base, lane, SIS, analysis path, spec change, and any existing PR. If the request is ineligible, report the reason and stop.
2. Check the current branch with `git branch --show-current`. If it differs from the request branch, ask the user to switch and stop. Mention pending changes that `orqen pr` will commit.
3. Read the log and diff against the target base (or its remote-tracking branch), review the analysis and OpenSpec artifacts or direct plan, and inspect the tests. Run tests when needed to substantiate a result.
4. Write a temporary Markdown explanation with the REC and SIS, a summary, changes by capability, decisions and deviations, tests mapped to the acceptance criteria, verification steps, and risks or pending work.
5. Run `orqen pr <KEY> <explanation.md> --agent pr`. Pass `--title "<title>"` if needed. orqen saves the explanation to the work record, commits pending changes, pushes the branch, and opens or updates the PR. If the command fails, address the reported cause before retrying.
6. Report the PR URL, branch, target base, and relevant risks or deviations.
