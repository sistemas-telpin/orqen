---
description: Guided, hands-on tour of orqen for newcomers - what to run at each stage, how a request moves on, how to watch the agent and the environments it starts
argument-hint: "[topic: map | pending | support | analysis | implement | testing | pr | review | delivery | watch | env | unattended | cheatsheet]"
allowed-tools: Bash(orqen status:*), Bash(orqen pending:*), Bash(orqen schema:*), Bash(orqen env status:*), Bash(orqen env up:*), Bash(orqen env down:*), Bash(orqen env test:*), Bash(orqen --version:*), Bash(orqen --help:*), Bash(node orqen/tools/db.mjs status:*), Bash(git status:*), Bash(git branch:*), Bash(git log:*), Bash(git diff:*), Read, Grep, Glob, Write, AskUserQuestion
---

Give the person who invoked this command a step-by-step, hands-on tour of orqen in this repository. They are new to orqen. If `$ARGUMENTS` names a topic, start at that step; otherwise start at step 0. The workflow and its rules are in `AGENTS.md`; the stage guides are in `orqen/stages/`.

## How to run the tour

- **Talk to the person in the language they write in.** If they have not written anything yet, use the language of the repository's README. Keep commands, state names, and file paths exactly as they are.
- **One step at a time.** For each step: explain the idea in three to six lines, show the exact commands in a code block, say what orqen does behind the scenes, what the person will see, and **how they know the step is done and what comes next**. Then stop and ask how to continue with `AskUserQuestion`, using options such as: `Next step` (recommended), `Try it now` (only when the step has a safe live demo), `Explain more`, and `Jump to another topic`. Never dump several steps at once.
- **Use this repository, not generic examples.** Before step 1, read `orqen/config.yaml` (processes, ports, tests, migrations) and the non-secret keys of `orqen/.env` (`REC_JQL`, `SIS_PROJECT`, `SUPPORT_STAGE`, `CODE_REVIEW_GATE`, `DEVEL_BRANCH`, `BASE_BRANCH`) and use those real names, ports, project prefixes, and test types in every example. If `orqen status` lists real requests, use one of their keys as the example; otherwise use `REC-1234` and `<SIS project>-442`.
- **Never show secrets.** Do not print or quote `JIRA_TOKEN`, `JIRA_USER`, passwords, or any value from `orqen/.env` other than the keys listed above. To check the Jira setup, only say which keys are set or missing.
- **Show the person's own shell.** Detect the platform. On Windows, give PowerShell commands (for example `Get-Content orqen\state\logs\api.log -Wait -Tail 50`); on Linux and macOS, give bash commands (`tail -f orqen/state/logs/api.log`).

## Safety: this is a tour, not real work

- **You may run these yourself, after saying what they do:** `orqen --version`, `orqen status [KEY]`, `orqen pending`, `orqen schema <STAGE>`, `orqen env status`, `git status`, `git branch`, `git log`, `git diff`, `node orqen/tools/db.mjs status`, and reading files.
- **Only with the person's explicit OK in this conversation:** `orqen env up [--all]`, `orqen env test`, and `orqen env down` (they start, test, and stop real local processes). Before `env up`, check `orqen env status` and say which ports will be used. If the tour started processes, offer `orqen env down` before it ends.
- **Never run, only show and explain:** `orqen support`, `analyze`, `lane`, `take`, `complete`, `block`, `release`, `pr`, `review`, `cycle`, `swarm`, `init`, `update`, any `/orqen:*` command, any Git write, and anything that writes to Jira or GitHub. These claim real requests, change their state, or post to the customer. If the person wants to do real work, tell them which command to run themselves when the tour ends.
- The only file you may write is the optional cheat sheet in the last step, at `orqen/tmp/cheatsheet.md` (ignored by Git).

## Steps

### 0. Welcome and check

1. Check that `orqen/config.yaml` exists. If it does not, explain that this repository is not initialized, tell them to run `orqen init` from the repository root, and stop.
2. Run `orqen --version`, read the configuration as described above, and tell the person in a few lines what you found: the processes orqen will start (name, command, port, `cuando`), the configured tests, whether Jira is configured (keys set or missing, no values), whether support is on, and how code review is decided.
3. Explain orqen in four lines: the customer opens a **REC** in Jira; orqen moves it through stages; people lead the stages that need judgment (support, analysis, reviews, approvals) with the agent, and the agent does the rest; `orqen` (the CLI) is the only one that writes to Jira, Git, and GitHub, and the agent produces content.
4. Ask their role with `AskUserQuestion`: support, analyst, developer (implement and PR), e2e test designer, senior reviewer, or "show me everything". Suggest the steps that matter for that role (everyone gets 1, 2, 9, and 10), and follow that path. They can jump to any step at any time.

### 1. The map

Show the workflow as text and who acts in each state:

```text
[SUPPORT] → ANALYSIS ⇄ WAITING_CLIENT → DEVELOPMENT ⇄ TESTING → CODE_REVIEW → DELIVERY → ACCEPTANCE → CLOSED
                                        anything that cannot go on → BLOCKED
```

- REC = the customer conversation; SIS = the implementation issue that analysis creates and links to the REC. Most commands accept either key.
- Lanes: `direct` (plan, no spec), `light` / `full` (OpenSpec change), and operational (no code: EXECUTION → EXECUTION_APPROVAL → APPLICATION → VERIFICATION).
- **How a request moves to the next stage**, the key idea of the tour: a stage ends only when `orqen complete` accepts its output (an agent stage) or when a person decides at a gate (`/approve` or `/reject <reason>` in Jira, or a review on the PR in GitHub when `CODE_REVIEW_GATE=github`). Each `/orqen:*` command does **one** stage and stops; its last message says what comes next and who acts. `orqen pending` and `orqen cycle` read the gates and move the request.
- Where things live: `orqen/work/<KEY>/` (readable record: `state.json`, `log.md`, `round-N/…`, committed with the request branch), `orqen/state/` (operational state, process registry, and logs, ignored by Git), `openspec/changes/` (specs in progress).

### 2. What is pending and where a request is

```sh
orqen pending          # what is waiting, grouped: for support / for an analyst / for an agent
orqen status           # every request this repo knows: key, state, SIS, change
orqen status REC-1234  # one request: state, lane, branch, lock, and its full transition history
```

Live demo: run `orqen status` (and `orqen pending` if Jira is configured; it only reads) and walk through the output with them (an empty `orqen status` means no request has gone through orqen in this clone yet). Point out that `orqen status <KEY>` is the first thing to run when they do not know what to do with a request.

### 3. Support (optional)

Command: `/orqen:support REC-1234` in Claude Code. Explain: the agent claims the REC (`orqen support`), searches read-only (similar requests, specs, code), agrees the outcome with the person (`resolved` or `escalate`), and drafts the reply or the escalation summary, which the person approves word by word. `orqen complete` publishes it. Next: `resolved` → ACCEPTANCE (customer `/approve` or `/reject`), no SIS; `escalate` → ANALYSIS, with the summary for the analyst. Mention whether `SUPPORT_STAGE` is on in this repo and what that changes in `orqen pending`.

### 4. Analysis

Command: `/orqen:analyze REC-1234 [analyst name]`. Walk through what they will see: `orqen analyze` claims the REC and loads the context; the agent interviews the analyst (grilling skill) and asks questions with options; it summarizes scope and acceptance criteria and waits for the analyst's OK; it proposes a lane and waits for confirmation; for `light` / `full`, `orqen lane` creates the branch and the OpenSpec change and they write the spec together; `orqen complete` validates, creates the SIS, links it, and records `orqen/work/<KEY>/round-1/analysis.md`. Next: DEVELOPMENT (or EXECUTION for operational work), shown with the new SIS key. Questions only the customer can answer put the REC in WAITING_CLIENT. Live demo: `orqen schema ANALYSIS` to show what the analysis output must contain.

### 5. Implementation

Command: `/orqen:implement SIS-442`. Explain the sequence: `orqen status` (only DEVELOPMENT continues); `orqen take` claims it, prepares the request branch, **installs dependencies, starts the `cuando: siempre` processes of this repo (name them), waits until they respond, and runs migrations and seeds**; the agent shows its plan (files, order, tests) and waits for OK; it implements, checks off `tasks.md` (spec lanes) or follows the plan (direct), writes a test per Scenario or acceptance criterion, and runs `orqen env test`; it shows a summary and asks for OK to close; `orqen complete` validates (it rejects unchecked tasks) and **stops the processes**. Next: TESTING. If a review or a failed test sent it back, the feedback arrives in the context and is handled first.

### 6. Testing

An agent stage without a person: `orqen take <KEY>` starts **every** process (including `cuando: e2e`, such as the frontend), runs the full suite, and stops them; the agent maps each Scenario or criterion to its test and `orqen complete` decides. Pass → CODE_REVIEW (no PR yet). Fail → back to DEVELOPMENT; the third failure → BLOCKED. Who runs it: unattended `orqen cycle`, or interactively by asking the agent "process REC-1234" (it runs `orqen take`, works, and runs `orqen complete`).

### 7. PR, e2e review, and code review

- `/orqen:pr SIS-442` (developer): must be on the request branch (`git branch --show-current`); the agent writes the explanation from the real diff, then `orqen pr` commits pending changes, pushes, and opens or updates the only PR, to `DEVEL_BRANCH` (say its value). Rerun it to add later changes.
- `/orqen:e2e-review SIS-442` (e2e designer): runs `orqen env up --all`, maps scenarios to e2e tests, prepares headed mode, traces, or video, and waits for the designer's approval of a passing run; the designer's edits travel with the next `/orqen:pr`.
- `/orqen:code-review SIS-442` (senior): read-only review of the PR diff with findings, severity, `file:line`, and solutions; `orqen review` records it. **How it moves on** depends on `CODE_REVIEW_GATE` (say this repo's value): `github` → Approve in the PR → DELIVERY, Request changes → DEVELOPMENT with the text as feedback (only reviews on the PR's latest commit count); `jira` → `/approve` or `/reject <reason>` in the issue.

### 8. Delivery, acceptance, and BLOCKED

DELIVERY is an agent stage: `orqen` archives the OpenSpec change and the agent writes release notes and the message to the customer. ACCEPTANCE: the customer comments `/approve` (CLOSED) or `/reject <reason>` (round 2: back to ANALYSIS with a new SIS, recorded in `round-2/`). BLOCKED: the reason is in `orqen status <KEY>` and in Jira; an approver unblocks it with `/approve <instructions>` and the request returns to the stage where it stopped, with the instructions as feedback.

### 9. How to watch what the agent is doing

Cover all of these, briefly, with commands they can run in a second terminal while the agent works:

- **In Claude Code**: the agent announces each step and waits for OK; read what it proposes before approving commands or edits. Expand the full transcript, including command output, with `Ctrl+O`. Press `Esc` to interrupt it at any time and redirect it. It reports after each step.
- **The request's trail**: `orqen status <KEY>` (state, lock, and history), `orqen/work/<KEY>/log.md` (one line per transition), `orqen/work/<KEY>/state.json`, and `orqen/work/<KEY>/round-N/` (analysis, PR explanation, code reviews).
- **The code it is changing**: `git status` and `git diff` (or `git diff --stat`), and, in spec lanes, the checkboxes in `openspec/changes/<change>/tasks.md`.
- **Unattended** (`orqen cycle --loop`): the agent's output goes to the terminal where `cycle` runs (run it in a terminal you can see, or redirect it to a file and follow that file). If the agent ends without completing its stage, orqen blocks the request with the reason.
- **Swarm** (`orqen swarm`): the plan, each attempt, model, and log are in `orqen/state/swarm/<run>/`; the result is the branch `orqen/swarm-<run>`.

Live demo: run `orqen status` and `git status` and explain what each line means.

### 10. The environments the agent starts

If `entornos.procesos` is empty, say so, show the shape of one entry (`nombre`, `comando`, `ruta`, `puerto` | `url` | `listo_si`, `cuando`, `detener`) with a value guessed from the stack, and suggest asking the team to add it; skip the live demo. Otherwise, explain with this repository's real processes from `orqen/config.yaml`: which start in DEVELOPMENT (`cuando: siempre`) and which only for e2e and TESTING (`cuando: e2e`), their ports, migrations, and seeds. orqen starts them in the background and **the person never has to start anything by hand**.

```sh
orqen env status            # ● running / ○ stopped, command, port, and the path of each log
orqen env up [--all]        # start them yourself (--all also starts the e2e ones), migrate, and seed
orqen env test [unitarios|integracion|e2e|visual]
orqen env down              # stop everything orqen started, with its whole process tree
```

- Open each app at `http://localhost:<port>` (list the real URLs).
- Follow a log live: `orqen/state/logs/<process>.log` (give the platform's follow command). PIDs and log paths are in `orqen/state/processes.json`.
- If the project has `orqen/tools/db.mjs`: the database runs in Docker; `node orqen/tools/db.mjs status` shows it (`up`, `down`, and `reset` also exist; `reset` deletes data).
- If a process does not start, the end of its log appears in the agent's context and in its log file; the agent fixes code problems and asks the person about environment problems (a busy port, a missing database).

Live demo, only with OK: `orqen env up`, then `orqen env status`, show the last lines of one log with `Read`, give the URLs, and finish with `orqen env down` (ask first).

### 11. Cheat sheet and next steps

Show a compact cheat sheet tailored to their role: the commands they will use, how they know their stage ended, and what comes next. Offer to save it to `orqen/tmp/cheatsheet.md` (ignored by Git) and write it only if they accept. Point them to the README's sections, `AGENTS.md`, and `orqen/stages/` (editable stage guides). Tell them the exact command to start real work (for example `/orqen:analyze <KEY>` or `orqen pending`), and that they can rerun `/orqen:tutorial <topic>` to review any step. If the tour started processes, make sure they are stopped or that the person chose to keep them.
