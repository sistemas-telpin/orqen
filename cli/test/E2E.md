# End-to-end verification

Run from `cli/`:

```sh
npm run test:e2e
npm test
npm run typecheck
```

Both test scripts build the CLI first. The dedicated E2E script runs the workflow journeys, existing CLI and bootstrap tests, personal catalog tests, swarm integration tests and real environment lifecycle tests. `npm test` includes the complete regression suite.

`workflow-cli.e2e.test.ts` launches a fresh `node dist/index.js` process for each command. It uses the installed kit, real Git repositories and local bare remotes, the real OpenSpec CLI, actual application tests, and the real HTTP Jira client. Each journey reaches `CLOSED`.

| Journey | Checks |
| --- | --- |
| Support resolves | Initialization, bootstrap, update, help, version, language, tutorial, search, status, schemas, locks, output validation, client authorization, configurable customer project prefixes, closure without a SIS |
| Direct development | Support escalation, client questions, release, block/unblock, analyst approval and readiness validation, failed Jira link and idempotent retry, SIS resolution, failing tests returning to development, swarm planning and application, all environment commands, PR creation and update, review rejection, client rejection, a new SIS for round two, final closure |
| Light development | Real OpenSpec change creation, invalid artifacts and missing estimates rejected before creating a SIS, implementation, incomplete tasks rejected, tests, PR, review, archiving and closure |
| Full development | Full planning artifacts, the same validation gates, implementation, tests, PR, review, archived specs and closure |
| Operational work | Unsafe SQL rejection, authorization, rejected application, failed read-only verification, a new proposal and successful closure; no SQL execution or development branch |
| Unattended cycle | A configured agent takes and completes development, receives `human_present: false`, releases the lock, and the remaining workflow closes normally |
| GitHub review gate | Stale approvals, unauthorized reviewers and Jira approval comments cannot advance the stage; current changes requested return to development; a current authorized approval enables delivery and closure |

Jira is an in-memory `FakeJira` exposed through a local HTTP server, including the Cloud and Server search routes, comments, issue creation, links, labels and transitions. GitHub reviews and PR creation use local fixtures. Planner and worker processes are deterministic Node scripts: these tests do not invoke paid models, contact live Jira/GitHub, apply operational scripts or publish changes.

These tests verify the command chain behind the slash commands. They do not run Claude Code or prove that a live language model follows the Markdown instructions; model behavior and external service permissions require a separate integration environment.

Each workflow test prints its temporary fixture directory and the number of CLI commands executed. That directory contains `commands.jsonl` (arguments, exit code, stdout and stderr), the repository, bare remote, workflow history, generated artifacts and swarm reports. Fixtures are retained for inspection when a test fails. Services started by ORQEN are stopped and the local Jira HTTP server is closed after each test.
