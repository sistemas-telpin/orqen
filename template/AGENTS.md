## Customer request workflow (REC)

```text
ANALYSIS ⇄ WAITING_CLIENT → DEVELOPMENT ⇄ TESTING
  → CODE_REVIEW → DELIVERY → ACCEPTANCE → CLOSED
  Issues that require intervention → BLOCKED
```

### Working with the person

orqen works alongside the person; it does not replace them. While someone is on the other side (they invoked
`/orqen:analyze`, `/orqen:implement`, `/orqen:pr`, a review command, or asked you directly; `human_present: true` in the context):

- **Say what you are about to do before doing it**, in one or two lines, and **wait for their OK** before each important step:
  choosing the lane, writing or changing the spec, the implementation plan, any change outside the plan, deleting or
  rewriting files, adding dependencies, opening a PR, `orqen complete`, and `orqen block`.
- **When in doubt, ask; never assume.** An ambiguous requirement, two possible approaches, a failing test where you are not
  sure whether the test or the code is wrong, an environment error you do not understand: ask with concrete options and your
  recommendation (use your tool's question picker if it has one, such as `AskUserQuestion` in Claude Code).
- **After each step, report in a few lines what you did and what comes next.**
- When nobody can answer (`human_present: false`, unattended `orqen cycle`): do not guess. If the doubt changes the outcome,
  run `orqen block <KEY> "<specific question>"`; orqen posts it to Jira and a person answers with `/approve <answer>`.

### Analysis

1. Start with `/orqen:analyze REC-1234` or `orqen analyze REC-1234 --analyst "<name>"`. A human analyst leads the analysis.
2. Read the issue, comments, and repository, then interview the analyst using the `orqen:grilling` skill. Use Jira MCP for read-only access or `orqen search`. Record questions only the customer can answer and wait for their response.
3. Summarize the scope, acceptance criteria, and risks. Obtain the analyst's explicit approval and ask them to confirm the lane.

   | Lane | When | Output |
   | --- | --- | --- |
   | `direct` | One component, roughly four hours or less, low risk, no contract change | Plan and acceptance criteria |
   | `light` | One or two capabilities, roughly two days or less | OpenSpec proposal, spec deltas, a short design, and tasks |
   | `full` | Broader changes involving architecture, data, integrations, security, or billing | Full OpenSpec proposal, specs, design, and tasks |

   With `light` or `full`, `orqen lane <KEY> <lane>` prepares a branch and change. Write the spec with the analyst under `openspec/changes/`.
4. Run `orqen complete <KEY> <output.json>`. Once validation passes, orqen creates the SIS in `SIS_PROJECT`, links it to the REC, and writes the record under `orqen/work/<KEY>/`. The REC tracks the customer conversation and the SIS tracks implementation through `SIS_TRANSITIONS`. Rejected customer acceptance starts a new analysis round and a new SIS.

### Operational work

For a data correction, restart, configuration change, or other work without code changes, set `route: operational` and `lane: direct`. The workflow is:

```text
ANALYSIS → EXECUTION → EXECUTION_APPROVAL → APPLICATION → VERIFICATION → ACCEPTANCE → CLOSED
```

Propose the steps, rollback, and read-only verification. A person authorized by `APPROVERS_EXECUTION` approves and applies the change. Never execute SQL that modifies data or change services yourself. If verification identifies a code defect, the REC returns to analysis. Operational work still creates a SIS; it skips the spec, branch, tests, and PR.

### Work on a stage

- `orqen pending` lists work for analysts and agents.
- `orqen take <KEY>` claims an agent stage and prints its instructions, issue context, feedback, and JSON output schema. Use `orqen analyze` for analysis.
- Run `orqen complete <KEY> <output.json>` when the output is ready. Correct validation errors and retry until the command reports success. Stop after completing the stage.
- If you cannot proceed, run `orqen block <KEY> "<specific reason>"`. Human reviewers use `/approve` or `/reject <reason>` in Jira.
- orqen writes `state.json`, `log.md`, and `round-N/analysis.md` and `.json` under `orqen/work/<KEY>/`. Operational rounds also record execution details under `execution/`. The authoritative workflow state is stored under `orqen/state/` or `cli/.state/`, depending on how the project is configured.

### Integration PR and code review

- `TESTING` opens no PR. The only PR is the integration PR to `DEVEL_BRANCH`, opened with `/orqen:pr` (`orqen pr <KEY> <explanation.md>`) from the request branch. orqen commits pending changes, pushes, and opens or updates it.
- The senior reviews that PR in `CODE_REVIEW`, supported by `/orqen:code-review <KEY>`: review the PR diff read-only against the analysis, spec or plan, and acceptance criteria, and give a verdict plus each finding with its severity, `file:line`, impact, and possible solutions. When the senior accepts the report, record it with `orqen review <KEY> <report.md> --verdict <approve|minor|reject>`. It does not change the stage: the senior still comments `/approve` or `/reject <reason>` in Jira.

### Rules

- Use Jira for read-only access. orqen handles issue writes, Git commits, branch changes, pushes, and OpenSpec archiving. Do not run `git commit/push/checkout/reset/rebase` or `openspec archive`.
- Do not edit `orqen/state/`, `orqen/work/`, or orqen configuration as part of a REC.
- Obtain explicit analyst approval before closing analysis, including approval of the selected lane.
- Record unanswered questions and label assumptions. Read `openspec/specs/` for current behavior before proposing changes.
- Write in clear, professional English. Follow OpenSpec's structural headings and use SHALL/MUST where required.
- Use network access only as required by the stage, such as installing project dependencies for tests.

### Environments and tests

`orqen/config.yaml` defines how each part of the project starts under `entornos.procesos` (its command, such as
`npm run dev` or `npm start`, its directory, and its port). There is no Docker in between unless the team configured a
process that uses it. **orqen manages them on its own; never ask a person to open a terminal or start anything:**

- During `DEVELOPMENT`, `orqen take` installs dependencies, starts the `cuando: siempre` processes (backend, workers…),
  waits until they respond, and runs migrations and seed commands. Read `environment` in the agent context for status,
  variables, and test commands.
- `orqen complete` stops them when development ends.
- During `TESTING`, orqen starts every process (including `cuando: e2e` ones such as the frontend), runs the full test suite,
  and stops them.

```sh
orqen env test [unitarios|integracion|e2e|visual]
orqen env status   # what is running and where each process log is
orqen env up --all # only when development also needs the frontend (e2e / visual)
```

If a process does not start, `environment.output` has the end of its log (also in `orqen/state/logs/<process>.log`).
Fix it if it is a code problem; if it is the environment (a missing database, a busy port), **ask the person** how to proceed.

Stack detected during initialization:

{{RESUMEN_STACK}}
