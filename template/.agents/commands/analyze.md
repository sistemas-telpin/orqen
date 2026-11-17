---
description: Analyze a customer request with the analyst, choose a lane, write a spec when needed, and create the linked Jira issue
argument-hint: REC-1234 [analyst name]
allowed-tools: Bash(orqen:*), Read, Grep, Glob, Write, Edit, Skill, AskUserQuestion
---

Analyze the customer request in `$ARGUMENTS` with the analyst who invoked this command. The first argument is the issue key. Use any remaining text as the analyst's name, or ask once and remember it. Work from the repository root and follow the customer request workflow in `AGENTS.md`.

## Rules

- **Talk to the person in their system language.** Run `orqen lang` once at the start (`es` = Spanish, `en` = English; the stage context also has it as `language`) and use it for every message, question, and option. Keep commands, state names, and paths as they are. Files and texts for Jira follow their own rules.
- **Work with the person who invoked this command.** Before each important step, tell them what you are about to do and wait for their OK. When in doubt, ask them (with `AskUserQuestion` when available: concrete options plus your recommendation); never assume what you can ask. After each step, report what you did and what comes next.
- Use Jira MCP for read-only access. orqen creates and links the SIS and posts comments.
- Leave Git operations, OpenSpec archiving, and writes to `orqen/state/` and `orqen/work/` to orqen.
- Require the analyst's explicit approval of the analysis and lane. Record unknowns as open questions or labeled assumptions.

## Steps

1. Check that the argument is a REC issue key, such as `REC-1234`. If it is missing or invalid, ask for it and stop.
2. Claim the request and load the stage instructions, context, and output schema:
   ```sh
   orqen analyze <KEY> --analyst "<name>" --agent analyst
   ```
   If this fails, explain the reason to the analyst and stop.
3. Read the issue, comments, repository specs, code, and relevant history. Load `orqen:grilling` and interview the analyst about decisions that remain open.
4. Once the analyst approves the analysis, propose `operational`, `direct`, `light`, or `full` using the criteria in the stage guide. Ask the analyst to confirm.
5. For `light` or `full`, run `orqen lane <KEY> <lane> --agent analyst` and write the spec with the analyst. The other lanes skip the spec.
6. Write the JSON output and submit it:
   ```sh
   orqen complete <KEY> <output.json> --agent analyst
   ```
   Correct validation errors and retry until the command reports success.
7. Report the lane, linked SIS key, `orqen/work/<KEY>/` record, and next stage. Stop after completing analysis.

If you cannot proceed, run `orqen block <KEY> "<specific reason>"`.
