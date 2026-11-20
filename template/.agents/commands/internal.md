---
description: Start an internal development (no client request, no support or analysis) and take it to development
argument-hint: <title>
allowed-tools: Bash(orqen:*), AskUserQuestion
---

Use the title in `$ARGUMENTS`. If it is missing, ask the person for it. This is development the team starts itself: there is no client, no request and no issue in an external tool, so support and analysis are skipped.

Talk with the person briefly, in their language, until you have what `orqen new` needs. Ask only what you cannot infer, one question at a time with your recommendation:
- **description**: what to do and why, in a few sentences.
- **acceptance_criteria**: at least one, each testable ("Given … when … then …"). Testing evaluates every one.
- **plan**: the steps, each ending with its estimate in hours, e.g. `Unify the entry point (2h)`.
- **estimated_hours**: the total.

Show the person the brief and get their explicit OK. Then write it as JSON in a temporary file outside the repository and run, from the repository root:

`orqen new "<title>" <brief.json>`

The brief is `{ "description": "...", "acceptance_criteria": ["..."], "plan": ["... (2h)"], "estimated_hours": 4 }`. orqen creates `INT-<n>` in `orqen/worqs/INT-<n>/` (its ticket and the brief travel with the branch) and leaves it in DEVELOPMENT, direct lane. If it reports the brief is invalid, fix what it names and run it again.

Then continue with `/orqen:implement INT-<n>`. The rest of the flow is the usual one (testing, `/orqen:pr`, senior `/orqen:approve`) without QA. There is no delivery or client acceptance: when a person merges the PR by hand, orqen detects it and closes the worq.
