---
description: Handle a new customer request as first-line support, answer the customer when possible, and otherwise escalate it to the analyst
argument-hint: REC-1234 [support person name]
allowed-tools: Bash(orqen:*), Read, Grep, Glob, Write, Skill, AskUserQuestion
---

Handle the customer request in `$ARGUMENTS` with the support person who invoked this command. The first argument is the issue key. Use any remaining text as the person's name, or ask once and remember it. Work from the repository root and follow the customer request workflow in `AGENTS.md`.

## Rules

- **Work with the person who invoked this command.** Before each important step, tell them what you are about to do and wait for their OK. When in doubt, ask them (with `AskUserQuestion` when available: concrete options plus your recommendation); never assume what you can ask. After each step, report what you did and what comes next.
- Read-only on code and Jira (Jira MCP or `orqen search`). orqen posts the comment on the request. Do not edit code, tests, specs, or configuration.
- Leave Git operations and writes to `orqen/state/` and `orqen/work/` to orqen.
- Never promise dates, scope, or changes to the customer. Require the person's explicit approval of the outcome and of the exact text that reaches the customer.

## Steps

1. Check that the argument is a REC issue key, such as `REC-1234`. If it is missing or invalid, ask for it and stop.
2. Claim the request and load the stage instructions, context, and output schema:
   ```sh
   orqen support <KEY> --person "<name>" --agent support
   ```
   If this fails, explain the reason to the person and stop.
3. Read the issue and comments, then look for the answer: similar requests, the documented behavior in `openspec/specs/`, and the code when needed. Report what you found.
4. Agree the outcome with the person: `resolved` (the customer can be answered without changes) or `escalate` (the analyst must take it). When unsure, recommend `escalate`.
5. Draft the reply to the customer (or the escalation summary for the analyst), show it, and adjust it until the person approves it.
6. Write the JSON output with `support_ok: true` and submit it:
   ```sh
   orqen complete <KEY> <output.json> --agent support
   ```
   Correct validation errors and retry until the command reports success.
7. Report the outcome and what happens next: a resolved request waits for the customer's `/approve` or `/reject <reason>`, and an escalated one goes to the analyst with `/orqen:analyze <KEY>`. Stop after completing support.

If you cannot proceed, run `orqen block <KEY> "<specific reason>"`.
