# orqen CLI

```sh
pnpm add -g orqen         # or: npm i -g orqen
orqen init               # Run from the repository you want to initialize
```

## Initialize a repository

`orqen init [dir]` runs the following setup:

1. Displays the ORQEN logo and checks Node (20.12 or later), Git, and a package manager. The animation needs a terminal with at least 92 columns and 23 rows. Press Enter to continue. Non-interactive terminals, CI, `--yes`, and `--no-animation` use the static logo.
2. Detects components and services from manifests such as `package.json`, `pom.xml`, and `pyproject.toml`, as well as Prisma and `.env.example`, including the command that starts each part (`npm run dev`, `npm start`…).
3. Uses an installed AI agent to review a short repository summary in the background. It validates the proposal with Zod. Use `--deep` to let the agent explore the repository or `--no-ai` to use automatic detection only.
4. Lets you confirm or edit components, the command that starts each part, tests, migrations, and seed commands.
5. Finds a compatible OpenSpec installation (version 2.x), installs it if needed, and runs `openspec init` for the selected tools with English artifact output.
6. Asks where the tickets live (`conectores` in `orqen/config.yaml`: the external ticket the client sees and an optional internal one, each in Jira, GitHub or Asana) and the approvers; tokens go to the ignored `orqen/.env`. With `--yes`, it keeps what is already configured. `orqen connectors` checks them.
7. Writes the environment configuration (no Docker in between), agent instructions, plugin, stage guides, and manifest. It merges the OpenSpec workflow rules with the repository's existing configuration.

`init` configures an existing project without requesting, cloning or reading the external stack catalog. It reuses any database scripts already installed in the project; new service scripts come from `bootstrap`.


Other options include `--agent "<command>"`, `--tools claude,codex`, and `--no-openspec`. Non-interactive runs use the defaults. If a managed file conflicts, `--yes` writes the proposed version alongside the original.

## Create a new project

```sh
orqen bootstrap "Payments Platform" [--tools-repo @company/tools] [--stack <id>] [--dir ./payments] [--yes]
orqen bootstrap --list
```

Asks the name, folder and stack; checks the stack requirements and asks its parameters (ports, Java package); creates the
folder and Git repository; generates the code (official generators plus the stack skeleton); copies the environment scripts
to `orqen/tools/` (e.g. `orqen/tools/db.mjs`, the database in Docker); runs `orqen init` with the stack and environments already known;
and offers the initial commit.

On first use, `bootstrap` asks for your GitHub stack repository (for example `@company/stacks`); its name can be anything. Git clones it into `cli/tools/` beside this CLI installation using your own HTTPS credential helper or SSH key. You need access to that repository. The clone is reused, ignored by Git and excluded from the npm package; no catalog is bundled. Each stack has `<id>/tool.yaml` and its scaffold, with shared scripts in `_shared/`.

For non-interactive first use of `bootstrap`, pass `--tools-repo @company/tools` or set `ORQEN_TOOLS_REPO`. HTTPS and SSH GitHub URLs are also accepted. To refresh it, use `git -C tools pull --ff-only` from the CLI installation directory. To select a different repository, move the existing clone aside first.

## Update an installation

`orqen update [dir]` checks for a newer CLI, a compatible OpenSpec update, and kit changes. The kit updates files that still match the manifest. For edited files, you can keep the existing version, replace it, or write a copy with the `.orqen-new` suffix.

Use `--no-cli`, `--no-openspec`, or `--no-kit` to skip a step. Run `orqen init` again when you need to detect the stack or regenerate the environment.

## Work with an environment

```sh
orqen env setup
orqen env up [--all]
orqen env test [unitarios|integracion|e2e|visual]
orqen env status
orqen env down
```

`up` starts the processes in `entornos.procesos` in the background (`--all` includes the `cuando: e2e` ones, such as the frontend), waits until each one responds on its port, URL, or log line, then runs migrations and seed commands. `down` stops what orqen started; `status` shows what is running and where each log is (`orqen/state/logs/`). The test commands receive variables from `entornos.variables` in `orqen/config.yaml`. The values `unitarios` and `integracion` select unit and integration tests.

## Split a task across a swarm of agents

```sh
orqen swarm "Add CSV export to the payments list, with date filters and tests"
orqen swarm --file task.md --parallel 6 --plan-only   # write the plan only
orqen swarm --plan orqen/state/swarm/<run>/plan.json  # run a reviewed plan
```

A planner model (default Opus) splits the task into a dependency graph of small subtasks, each with the files it touches and a fast test. After the person confirms, subtasks run in parallel in separate git worktrees: the small model (default Haiku) gets two attempts, then the subtask escalates to the large model (default Sonnet) with the failure output. Each passing subtask is committed and merged into `orqen/swarm-<run>`; dependents start on top of merged code. Finally the plan's `finalTest` runs on the integration branch, and the large model fixes it if needed. The report and every attempt's log are in `orqen/state/swarm/<run>/`. Run `orqen swarm --help` for all options.

## Process a request

```sh
orqen pending
orqen analyze SOP-1234
orqen status DEV-442
orqen take DEV-442
orqen complete DEV-442 output.json
orqen cycle --loop
```

`orqen take` in `DEVELOPMENT` prepares the branch, dependencies, and services. The agent context includes connection variables and test commands under `environment`. If preparation fails, see `environment.detail` or `environment.output`. `orqen complete` stops the environment after development.

In `TESTING`, taking the stage starts the full environment, runs the configured suite, and shuts everything down. `orqen cycle --loop` dispatches eligible requests using `AGENT_CMD`. Analysis always requires an analyst.

Use `/orqen:e2e-review <KEY>` for a human-led visual review. Run `orqen pr <KEY>` to inspect the integration target or add an explanation file to open the PR to `DEVEL_BRANCH`; testing opens no PR, so this is the PR the senior reviews. In `CODE_REVIEW`, the senior runs `/orqen:code-review <KEY>`, and `orqen review <KEY> <report.md> --verdict <approve|minor|reject>` records the report under `orqen/work/<KEY>/round-N/` and comments it on the internal ticket (or the external one) without changing the stage.

For an existing checkout, the CLI also reads `cli/.env` and its local state under `cli/.state/`. Use `template/env.example` as the starting point for that configuration.

## Develop locally

From this directory:

```sh
npm ci
npm run dev -- --help
npm run test:e2e # Complete CLI journeys through CLOSED; local external-service fixtures
npm test
npm run typecheck
npm run build
npm run setup  # Build and link the local CLI as orqen
```
