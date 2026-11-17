## Customer request workflow (REC)

```text
ANALYSIS ⇄ WAITING_CLIENT → DEVELOPMENT ⇄ TESTING
  → CODE_REVIEW → DELIVERY → ACCEPTANCE → CLOSED
  Issues that require intervention → BLOCKED
```

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
- The senior reviews that PR in `CODE_REVIEW`, supported by `/orqen:code-review <KEY>`: review the PR diff read-only against the analysis, spec or plan, and acceptance criteria, and give a verdict plus each finding with its severity, `file:line`, impact, and possible solutions. When the senior accepts the report, record it with `orqen review <KEY> <report.md> --verdict <approve|minor|reject>`. It does not change the stage. With the default `CODE_REVIEW_GATE=github`, the senior decides with a review on the PR in GitHub (limited to `GITHUB_REVIEWERS` when set): orqen reads it, moves to `DELIVERY` on approval, and returns to `DEVELOPMENT` on "changes requested" (the review text becomes feedback for the agent). Only reviews on the PR's current head count, so a later push needs a new review. With `CODE_REVIEW_GATE=jira`, the senior comments `/approve` or `/reject <reason>` in Jira instead.

### Rules

- Use Jira for read-only access. orqen handles issue writes, Git commits, branch changes, pushes, and OpenSpec archiving. Do not run `git commit/push/checkout/reset/rebase` or `openspec archive`.
- Do not edit `orqen/state/`, `orqen/work/`, or orqen configuration as part of a REC.
- Obtain explicit analyst approval before closing analysis, including approval of the selected lane.
- Record unanswered questions and label assumptions. Read `openspec/specs/` for current behavior before proposing changes.
- Write in clear, professional English. Follow OpenSpec's structural headings and use SHALL/MUST where required.
- Use network access only as required by the stage, such as installing project dependencies for tests.

### Environments and tests

`orqen/config.yaml` defines the environments under `entornos`. The CLI uses `docker-compose.orqen.yml` to start configured services.

- During `DEVELOPMENT`, `orqen take` installs dependencies, waits for service health checks, and runs migrations and seed commands. Read `environment` in the agent context for status, connection variables, and test commands.
- `orqen complete` shuts down the development environment.
- During `TESTING`, orqen starts services and apps, runs the full test suite, and shuts them down.

```sh
orqen env test [unitarios|integracion|e2e|visual]
orqen env status
orqen env up --apps  # Use when development tests also need the apps
```

Stack detected during initialization:

{{RESUMEN_STACK}}
