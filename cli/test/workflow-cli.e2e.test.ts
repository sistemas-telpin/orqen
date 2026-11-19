/** Complete journeys through separate compiled CLI processes; no live tickets or paid agents. */
import assert from "node:assert/strict";
import { escribirConfig, leerConfig } from "../src/lib/config.ts";
import { copyFileSync, existsSync, linkSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { describe, test } from "node:test";
import { analysis, CLI, delivery, development, implementWithSwarm, implementation, supportEscalation, testAndReview, workflowFixture, type WorkflowFixture } from "./workflow-cli-fixture.ts";

const testing = (scenario: string) => ({ scenarios: [{ requirement: "Acceptance criterion", scenario, covered: true, test: "test.mjs" }], failure_diagnosis: "", suggestions: [], coverage_ok: true });
async function finish(f: WorkflowFixture) {
  // without gh orqen cannot see the merge: the person who merged the PR by hand confirms it
  await f.command(["take", f.record().issue!], { exit: 1 }); f.state("DELIVERY");
  await f.command(["merged", f.record().issue!]);
  assert.ok(f.record().artifacts.devel_pr_merged);
  await f.command(["take", f.record().issue!]);
  f.state("DELIVERY");
  await f.complete(f.record().issue!, delivery); f.state("ACCEPTANCE");
  await f.human("client", "/approve"); f.state("CLOSED");
  assert.ok(f.jira.issues["REQ-7"].labels?.includes("orqen-state-closed"));
  assert.ok(f.jira.transitions["REQ-7"].includes("Done"));
  assert.ok(f.jira.transitions[f.record().issue!].includes("Done"));
  assert.deepEqual(JSON.parse(await f.command(["pending", "--json"])), []);
  const status = await f.command(["status", f.record().issue!]); assert.match(status, /"state": "CLOSED"/);
}

describe("Compiled workflow journeys", { concurrency: 3 }, () => {

test("CLI: support resolves and the authorized client closes the request without an issue", { timeout: 180_000 }, async (t) => {
  const f = await workflowFixture(t);
  await f.command(["--help"]); await f.command(["--version"]);
  assert.equal((await f.command(["lang"])).trim(), "en");
  await f.command(["tutorial", "--json"]);
  await f.command(["bootstrap", "--list"]);
  const created = join(f.root, "created-project");
  await f.command(["bootstrap", "Example", "--stack", "example", "--dir", created, "--yes", "--no-openspec"]);
  assert.ok(existsSync(join(created, "orqen/config.yaml")));
  await f.command(["update", "--yes", "--no-cli", "--no-openspec"]);
  const found = JSON.parse(await f.command(["search", "project = REQ"])); assert.equal(found[0].key, "REQ-7");
  await f.command(["status"]);
  for (const stage of ["SUPPORT", "ANALYSIS", "DEVELOPMENT", "TESTING", "DELIVERY", "EXECUTION", "VERIFICATION"]) {
    assert.equal(JSON.parse(await f.command(["schema", stage])).type, "object");
  }
  await f.command(["schema", "INVALID"], { exit: 1 });
  await f.command(["support", "REQ-7", "--person", "Support Person"]); f.state("SUPPORT");
  await f.command(["support", "REQ-7", "--agent", "other"], { exit: 1 });
  assert.equal(f.record().supporter, "Support Person", "A denied claim must not replace the support person");
  assert.equal(f.record().lock?.agent, "e2e");
  await f.command(["take", "REQ-7"], { exit: 1 });
  const output = { summary: "The export is already available in the accounting menu.", checked: ["Current behavior and documentation"], outcome: "resolved", client_response: "Open Accounting, select Invoices, then choose Export CSV.", support_ok: true };
  await f.complete("REQ-7", { ...output, support_ok: false }, 1); f.state("SUPPORT");
  await f.command(["complete", "REQ-7", "-"], { input: "{broken", exit: 1 });
  await f.complete("REQ-7", output); f.state("ACCEPTANCE");
  await f.human("outsider", "/approve"); f.state("ACCEPTANCE");
  await f.human("client", "/approve"); f.state("CLOSED");
  assert.equal(f.jira.created.length, 0);
  assert.equal(f.git("branch", "--show-current"), "main");
  assert.match(readFileSync(join(f.repo, "orqen/worqs/REQ-7/round-1/support.md"), "utf8"), /Export CSV/);
  // the worq: open ones by default, closed ones with --all; one worq shows its state and the files of its record
  assert.doesNotMatch(await f.command(["worqs"]), /REQ-7/);
  assert.match(await f.command(["worqs", "--all"]), /REQ-7\s+CLOSED[\s\S]*orqen\/worqs\/REQ-7/);
  const worq = JSON.parse(await f.command(["worq", "REQ-7", "--json"]));
  assert.deepEqual([worq.key, worq.state, worq.dir], ["REQ-7", "CLOSED", "orqen/worqs/REQ-7"]);
  assert.ok(worq.files.includes("round-1/support.md") && worq.files.includes("state.json") && worq.files.includes("log.md"));
  assert.match(await f.command(["worq", "REQ-7"]), /Worq REQ-7[\s\S]*State:\s+CLOSED[\s\S]*Folder:\s+orqen\/worqs\/REQ-7\/[\s\S]*round-1\/support\.md/);
  await f.command(["worq", "NOPE-1"], { exit: 1 });
  // Initialization supports customer projects other than the default one; every command must resolve them too.
  const cfg = leerConfig(f.repo); cfg.conectores!.requests.filtro = "project = HELP"; escribirConfig(f.repo, cfg);
  f.jira.issues["HELP-8"] = { title: "Find the invoice export" }; f.jira.coms["HELP-8"] = [];
  await f.command(["support", "HELP-8", "--person", "Support Person"]);
  await f.command(["status", "help-8"]);
  await f.complete("HELP-8", output);
  f.jira.human("HELP-8", "client", "/approve");
  await f.command(["pending", "--json"]);
  assert.match(await f.command(["status", "HELP-8"]), /"state": "CLOSED"/);
});

test("CLI: support to direct development, failed tests, swarm, PR rejection, client rejection and final closure", { timeout: 300_000 }, async (t) => {
  const f = await workflowFixture(t);
  await supportEscalation(f);
  await f.command(["analyze", "REQ-7", "--agent", "other", "--analyst", "Replacement"], { exit: 1 });
  assert.equal(f.record().analyst, "Analyst");
  await f.complete("REQ-7", analysis({ ready: false, analyst_ok: false, open_questions: ["Which columns are required?"] })); f.state("WAITING_CLIENT");
  await f.command(["analyze", "REQ-7"], { exit: 1 });
  await f.human("client", "Only the invoice number is needed."); f.state("ANALYSIS");
  await f.command(["analyze", "REQ-7", "--analyst", "Analyst"]);
  await f.command(["release", "REQ-7"]);
  await f.complete("REQ-7", analysis(), 1);
  await f.command(["analyze", "REQ-7", "--analyst", "Analyst"]);
  await f.command(["block", "REQ-7", "Need confirmation of the export format"]); f.state("BLOCKED");
  await f.human("outsider", "/approve"); f.state("BLOCKED");
  await f.human("analyst", "/approve Use CSV with a header"); f.state("ANALYSIS");
  await f.command(["analyze", "REQ-7", "--analyst", "Analyst"]);
  await f.command(["lane", "REQ-7", "direct"]);
  await f.complete("REQ-7", analysis({ analyst_ok: false }), 1);
  await f.complete("REQ-7", analysis({ ready: false, analyst_ok: false }), 1);
  await f.complete("REQ-7", analysis({ open_questions: ["Unanswered question"] }), 1);
  f.state("ANALYSIS");
  f.failNextLink();
  await f.complete("REQ-7", analysis(), 1); f.state("ANALYSIS");
  assert.equal(f.jira.created.length, 1, "A failed link must not duplicate the issue on retry");
  await f.complete("REQ-7", analysis()); f.state("DEVELOPMENT");
  assert.equal(f.jira.created.length, 1); assert.equal(f.jira.links.length, 1);
  const sis = f.record().issue!;
  await f.command(["take", sis]);
  await f.complete(sis, development); f.state("TESTING");
  const failed = f.context(await f.command(["take", sis]));
  assert.equal(failed.test_result.ok, false, "The fixture starts with a genuinely broken export");
  await f.complete(sis, testing(analysis().acceptance_criteria[0])); f.state("DEVELOPMENT");
  await implementWithSwarm(f);
  await f.command(["env", "setup"]); await f.command(["env", "up", "--all"]);
  await f.command(["env", "status"]); await f.command(["env", "test", "unitarios"]); await f.command(["env", "down"]);
  await testAndReview(f);
  await f.human("outsider", "/approve"); f.state("CODE_REVIEW");
  await f.human("senior", "/reject Add an empty-list regression test"); f.state("DEVELOPMENT");
  const redo = f.context(await f.command(["take", sis])); assert.match(JSON.stringify(redo.human_feedback), /empty-list/);
  f.file("test.mjs", readFileSync(join(f.repo, "test.mjs"), "utf8") + "assert.equal(exportCsv([]), 'n');\n");
  await testAndReview(f);
  assert.equal(f.record().artifacts.code_reviews.length, 2);
  await f.human("senior", "/approve"); f.state("DELIVERY");
  await f.command(["merged", sis]);
  await f.command(["take", sis]); await f.complete(sis, delivery); f.state("ACCEPTANCE");
  await f.human("client", "/reject Please explicitly document empty exports"); f.state("ANALYSIS");
  assert.equal(f.record().round, 2); assert.equal(f.record().issue, undefined);
  await f.command(["take", sis], { exit: 1 });
  await f.command(["analyze", "REQ-7", "--analyst", "Analyst"]);
  await f.complete("REQ-7", analysis());
  assert.notEqual(f.record().issue, sis); assert.equal(f.jira.created.length, 2);
  await f.command(["take", f.record().issue!]);
  f.file("README.md", readFileSync(join(f.repo, "README.md"), "utf8") + "\nEmpty exports contain only the CSV header.\n");
  await testAndReview(f); await f.human("senior", "/approve");
  await finish(f);
  assert.deepEqual(f.record().artifacts.previous_issues, [sis]);
  assert.equal(f.git("status", "--porcelain", "--untracked-files=no"), "");
});

for (const lane of ["light", "full"] as const) {
  test(`CLI: ${lane} lane completes real OpenSpec validation, implementation and archiving through CLOSED`, { timeout: 240_000 }, async (t) => {
    const f = await workflowFixture(t, "cloud");
    await supportEscalation(f);
    await f.command(["lane", "REQ-7", lane]);
    const change = f.record().change, dir = `openspec/changes/${change}`;
    const output = analysis({ lane, spec: { change, summary: "Add the approved invoice CSV export capability.", assumptions: [] } });
    await f.complete("REQ-7", output, 1);
    assert.equal(f.jira.created.length, 0);
    f.file(`${dir}/proposal.md`, "# Proposal\n\n## Why\n\nAccounting needs invoice exports for reconciliation.\n\n## What Changes\n\nAdd CSV exports with an invoice number header.\n\n## Capabilities\n\n### New Capabilities\n- `invoice-export`: export invoice numbers as CSV\n\n### Modified Capabilities\n\n## Impact\n\nexport.mjs and test.mjs\n");
    f.file(`${dir}/specs/invoice-export/spec.md`, "# Invoice export\n\n## Purpose\n\nAllow accounting to reconcile invoice numbers using CSV files.\n\n## ADDED Requirements\n\n### Requirement: Export invoices\nThe system SHALL export invoice numbers with a header.\n\n#### Scenario: Invoice CSV\n- **WHEN** an invoice is exported\n- **THEN** the CSV contains its header and invoice number\n");
    f.file(`${dir}/design.md`, "# Design\n\n## Context\nA pure function in one module.\n\n## Goals / Non-Goals\nCSV only; other formats are excluded.\n\n## Decisions\nReuse the existing module without dependencies.\n\n## Risks / Trade-offs\nNo additional external services are needed.\n");
    f.file(`${dir}/tasks.md`, "# Tasks\n\n## 1. CSV export\n- [ ] 1.1 Implement CSV export\n- [ ] 1.2 Cover the scenario (1h)\n");
    await f.complete("REQ-7", output, 1);
    assert.equal(f.jira.created.length, 0);
    f.file(`${dir}/tasks.md`, readFileSync(join(f.repo, dir, "tasks.md"), "utf8").replace("Implement CSV export", "Implement CSV export (1h)"));
    await f.complete("REQ-7", output); f.state("DEVELOPMENT");
    await implementWithSwarm(f);
    await f.complete(f.record().issue!, development, 1); f.state("DEVELOPMENT");
    f.file(`${dir}/tasks.md`, readFileSync(join(f.repo, dir, "tasks.md"), "utf8").replaceAll("- [ ]", "- [x]"));
    await testAndReview(f);
    if (lane === "full") {
      // step 7 already ran in QA_REVIEW (testAndReview): the senior's queue shows QA as approved
      const listed = JSON.parse(await f.command(["list", "prs", "--json"]));
      assert.deepEqual([listed[0].qa, listed[0].role], ["approved", "senior"]);
    }
    await f.human("senior", "/approve");
    await finish(f);
    assert.ok(existsSync(join(f.repo, "openspec/specs/invoice-export/spec.md")));
    assert.equal(existsSync(join(f.repo, dir)), false);
    assert.ok(f.record().artifacts.archive.archivedAs);
    assert.match(f.git("ls-remote", "origin", "refs/heads/orqen/req-7"), /orqen\/req-7/);
    assert.ok(f.requests.includes("GET /rest/api/3/search/jql"));
  });
}

test("CLI: operational approval, rejected application, failed verification, retry and closure without executing SQL", { timeout: 240_000 }, async (t) => {
  const f = await workflowFixture(t);
  await supportEscalation(f);
  await f.complete("REQ-7", analysis({ route: "operational" })); f.state("EXECUTION");
  const sis = f.record().issue!;
  const proposal = { summary: "Correct the affected invoice status after checking its identifier.", system: "Fixture database", impact: "Only invoice 7 is affected by this proposed update.", estimated_rows: 1, sql_script: "UPDATE invoices SET status = 'ready' WHERE id = 7;", rollback: "UPDATE invoices SET status = 'pending' WHERE id = 7;", verification: "SELECT status FROM invoices WHERE id = 7;", risks: [] };
  await f.command(["take", sis]);
  await f.complete(sis, { ...proposal, sql_script: "DELETE FROM invoices;" }, 1); f.state("EXECUTION");
  async function proposeAndApprove() {
    await f.complete(sis, proposal); f.state("EXECUTION_APPROVAL");
    await f.human("outsider", "/approve"); f.state("EXECUTION_APPROVAL");
    await f.human("dba", "/approve"); f.state("APPLICATION");
  }
  await proposeAndApprove();
  await f.human("dba", "/reject Maintenance window not available"); f.state("EXECUTION");
  await f.command(["take", sis]); await proposeAndApprove();
  await f.human("dba", "/approve Applied one row in the fixture"); f.state("VERIFICATION");
  const ctx = f.context(await f.command(["take", sis])); assert.match(JSON.stringify(ctx.human_feedback), /Applied one row/);
  await f.complete(sis, { verified: false, evidence: "Read-only verification still shows pending status" }); f.state("EXECUTION");
  await f.command(["take", sis]); await proposeAndApprove();
  await f.human("dba", "/approve Corrected the selected invoice");
  await f.command(["take", sis]);
  await f.complete(sis, { verified: true, evidence: "Read-only verification confirms invoice 7 is ready", client_message: "The selected invoice now has the expected status.", validation_steps: ["Check invoice 7 in the invoice list"] }); f.state("ACCEPTANCE");
  await f.human("client", "/approve"); f.state("CLOSED");
  assert.equal(f.git("branch", "--show-current"), "main");
  assert.equal(f.git("branch", "--list", "rec/*"), "");
  assert.equal(readFileSync(join(f.repo, "export.mjs"), "utf8"), "export const exportCsv = () => '';\n");
  assert.equal(readFileSync(join(f.repo, "orqen/worqs/REQ-7/round-1/execution/script.sql"), "utf8"), proposal.sql_script);
  await f.command(["pr", sis], { exit: 1 });
});

test("CLI: unattended cycle consumes the approved development stage and the request still closes", { timeout: 180_000 }, async (t) => {
  const f = await workflowFixture(t);
  await supportEscalation(f); await f.complete("REQ-7", analysis());
  const agent = join(f.root, "cycle-agent.mjs"), contextPath = join(f.root, "cycle-context.json"), outputPath = join(f.root, "development.json");
  writeFileSync(outputPath, JSON.stringify(development));
  writeFileSync(agent, `import {execFileSync} from 'node:child_process'; import {readFileSync,writeFileSync} from 'node:fs'; readFileSync(0,'utf8'); const cli=${JSON.stringify(CLI)}; const out=execFileSync(process.execPath,[cli,'take','REQ-7','--agent','cycle'],{encoding:'utf8'}); const ctx=JSON.parse(out.match(/## Context\\s+\x60\x60\x60json\\s+([\\s\\S]*?)\x60\x60\x60/)[1]); writeFileSync(${JSON.stringify(contextPath)},JSON.stringify(ctx)); writeFileSync('export.mjs',${JSON.stringify(implementation)}); execFileSync(process.execPath,[cli,'complete','REQ-7',${JSON.stringify(outputPath)},'--agent','cycle'],{stdio:'inherit'});`);
  f.env.AGENT_CMD = `node "${agent}"`;
  await f.command(["cycle"]); f.state("TESTING");
  assert.equal(JSON.parse(readFileSync(contextPath, "utf8")).human_present, false);
  assert.equal(f.record().lock, undefined);
  await testAndReview(f, false); await f.human("senior", "/approve"); await finish(f);
});

test("CLI: default GitHub gate ignores stale and unauthorized approvals, handles rejection and closes after a current review", { timeout: 240_000 }, async (t) => {
  const f = await workflowFixture(t);
  const bin = join(f.root, "bin"); mkdirSync(bin);
  const gh = join(bin, process.platform === "win32" ? "gh.exe" : "gh");
  try { linkSync(process.execPath, gh); } catch { copyFileSync(process.execPath, gh); }
  const snapshot = join(f.root, "github-review.json"), preload = join(f.root, "gh-preload.cjs");
  writeFileSync(preload, `if(require('node:path').basename(process.argv[1]||'')==='pr'&&process.argv[2]==='view'){process.stdout.write(require('node:fs').readFileSync(${JSON.stringify(snapshot)},'utf8'));process.exit(0);}`);
  const pathKey = Object.keys(f.env).find((key) => key.toLowerCase() === "path") ?? "PATH";
  f.env[pathKey] = bin + delimiter + (f.env[pathKey] ?? "");
  f.env.NODE_OPTIONS = `--require "${preload.replaceAll("\\", "/")}"`;
  f.env.CODE_REVIEW_GATE = "github";
  const review = (id: string, author: string, state: string, commit: string) => writeFileSync(snapshot, JSON.stringify({ headRefOid: "current-head", reviews: [{ id, author: { login: author }, state, body: "Review feedback for the CSV implementation", commit: { oid: commit } }] }));
  review("old", "senior", "APPROVED", "old-head");
  await supportEscalation(f); await f.complete("REQ-7", analysis()); await implementWithSwarm(f); await testAndReview(f);
  await f.human("senior", "/approve"); f.state("CODE_REVIEW");
  review("unauthorized", "outsider", "APPROVED", "current-head");
  await f.command(["pending", "--json"]); f.state("CODE_REVIEW");
  review("reject", "senior", "CHANGES_REQUESTED", "current-head");
  await f.command(["pending", "--json"]); f.state("DEVELOPMENT");
  await f.command(["take", f.record().issue!]); await testAndReview(f);
  review("approved", "senior", "APPROVED", "current-head");
  await f.command(["pending", "--json"]); f.state("DELIVERY");
  // the PR is still open: delivery waits; once merged by hand on GitHub, orqen detects it on its own
  await f.command(["take", f.record().issue!], { exit: 1 });
  const snap = JSON.parse(readFileSync(snapshot, "utf8"));
  writeFileSync(snapshot, JSON.stringify({ ...snap, state: "MERGED", mergedAt: "2026-11-18T12:00:00Z", mergedBy: { login: "integrator" } }));
  await f.command(["list", "prs", "--json"]);
  assert.equal(f.record().artifacts.devel_pr_merged.by, "integrator");
  await f.command(["take", f.record().issue!]); await f.complete(f.record().issue!, delivery); f.state("ACCEPTANCE");
  await f.human("client", "/approve"); f.state("CLOSED");
});

});
