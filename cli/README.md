# orqen CLI

```sh
pnpm add -g orqen         # or: npm i -g orqen
orqen init               # Run from the repository you want to initialize
```

## Initialize a repository

`orqen init [dir]` runs the following setup:

1. Displays the ORQEN logo and checks Node (20.12 or later), Git, a package manager, and optional Docker. The animation needs a terminal with at least 92 columns and 23 rows. Press Enter to continue. Non-interactive terminals, CI, `--yes`, and `--no-animation` use the static logo.
2. Detects components and services from manifests such as `package.json`, `pom.xml`, and `pyproject.toml`, as well as Dockerfiles, existing Compose files, Prisma, and `.env.example`.
3. Uses an installed AI agent to review a short repository summary in the background. It validates the proposal with Zod. Use `--deep` to let the agent explore the repository or `--no-ai` to use automatic detection only.
4. Lets you confirm or edit components, services, tests, migrations, and seed commands.
5. Finds a compatible OpenSpec installation (version 2.x), installs it if needed, and runs `openspec init` for the selected tools with English artifact output.
6. Collects Jira connection settings, REC and SIS projects, and approvers in the ignored `orqen/.env`. With `--yes`, it uses example values for a new file.
7. Writes the environment configuration, Compose file, agent instructions, plugin, stage guides, and manifest. It merges the OpenSpec workflow rules with the repository's existing configuration.

Other options include `--agent "<command>"`, `--tools claude,codex`, and `--no-openspec`. Non-interactive runs use the defaults. If a managed file conflicts, `--yes` writes the proposed version alongside the original.

## Update an installation

`orqen update [dir]` checks for a newer CLI, a compatible OpenSpec update, and kit changes. The kit updates files that still match the manifest. For edited files, you can keep the existing version, replace it, or write a copy with the `.orqen-new` suffix.

Use `--no-cli`, `--no-openspec`, or `--no-kit` to skip a step. Run `orqen init` again when you need to detect the stack or regenerate the environment.

## Work with an environment

```sh
orqen env setup
orqen env up [--apps]
orqen env test [unitarios|integracion|e2e|visual]
orqen env status
orqen env down
```

`up` waits for services, then runs migrations and seed commands. The test commands receive variables from `entornos.variables` in `orqen/config.yaml`. The values `unitarios` and `integracion` select unit and integration tests.

## Process a request

```sh
orqen pending
orqen analyze REC-1234
orqen status SIS-442
orqen take SIS-442
orqen complete SIS-442 output.json
orqen cycle --loop
```

`orqen take` in `DEVELOPMENT` prepares the branch, dependencies, and services. The agent context includes connection variables and test commands under `environment`. If preparation fails, see `environment.detail` or `environment.output`. `orqen complete` stops the environment after development.

In `TESTING`, taking the stage starts the full environment, runs the configured suite, and shuts everything down. `orqen cycle --loop` dispatches eligible requests using `AGENT_CMD`. Analysis always requires an analyst.

Use `/orqen:e2e-review <KEY>` for a human-led visual review. Run `orqen pr <KEY>` to inspect the integration target or add an explanation file to open the PR to `DEVEL_BRANCH`.

For an existing checkout, the CLI also reads `cli/.env` and its local state under `cli/.state/`. Use `template/env.example` as the starting point for that configuration.

## Develop locally

From this directory:

```sh
npm ci
npm run dev -- --help
npm test
npm run typecheck
npm run build
npm run link:local  # Build and link the local CLI as orqen
```
