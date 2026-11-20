---
description: Start a worq the team itself needs (no client request, no support or analysis): creates its issue in the connector and takes it to development
argument-hint: <title>
allowed-tools: Bash(orqen:*), AskUserQuestion
---

Use the title in `$ARGUMENTS`. If it is missing, ask the person for it. This is work the team starts itself: there is no client or request, so support and analysis are skipped. orqen creates the issue in the connector the project uses (the issues connector, or the requests one when there is none).

Talk with the person briefly, in their language, until you have what `orqen new_worq` needs. Ask only what you cannot infer, one question at a time with your recommendation:
- **description**: what to do and why, in a few sentences.
- **acceptance_criteria**: at least one, each testable ("Given … when … then …"). Testing evaluates every one.
- **plan**: the steps, each ending with its estimate in hours, e.g. `Unify the entry point (2h)`.
- **estimated_hours**: the total.

Show the person the brief and get their explicit OK, because the issue is created in the tracker right away. Then write it as JSON in a temporary file outside the repository and run, from the repository root:

`orqen new_worq "<title>" <brief.json>`

The brief is `{ "description": "...", "acceptance_criteria": ["..."], "plan": ["... (2h)"], "estimated_hours": 4 }`. orqen validates it, creates the issue in the connector and starts the worq with that issue's key (`<KEY>`), in DEVELOPMENT, direct lane. If it reports the brief is invalid, nothing was created: fix what it names and run it again.

Then continue with `/orqen:implement <KEY>`. The rest of the flow is the usual one (testing, `/orqen:pr`, senior `/orqen:approve`) without QA. There is no delivery or client acceptance: when a person merges the PR by hand, orqen detects it and closes the worq and its issue.
