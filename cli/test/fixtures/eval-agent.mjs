// Fake agent for orqen eval tests: does each step the right way through the real CLI.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
const prompt = readFileSync(0, "utf8");
const bad = process.env.BAD_AGENT === "1";
const orqen = (args, input) => execFileSync("orqen", args, { input, encoding: "utf8", shell: process.platform === "win32" });
const step = prompt.match(/\/orqen:(\w+) REQ-1/)[1];
const ctx = orqen([step, "REQ-1"]);
if (process.env.EVAL_ECHO_CONTEXT) console.log(ctx);
let out;
if (step === "support") {
  const csv = ctx.includes("CSV");
  out = csv && !bad
    ? { summary: "Accounting asks for a CSV export of the month's invoices.", checked: ["The ticket", "src/invoices.js"], outcome: "escalate", escalation_summary: "There is no CSV export today; it needs development and an analyst.", support_ok: true }
    : csv
    ? { summary: "Accounting asks for a CSV export of the month's invoices.", checked: ["The ticket"], outcome: "resolved", client_response: "The CSV export is already available and we will finish it by tomorrow.", support_ok: true }
    : { summary: "The client cannot find how to reset the password.", checked: ["docs/help.md"], outcome: "resolved", client_response: "Open Settings › Security and press \"Send reset link\"; the link arrives by email.", support_ok: true };
} else {
  out = { summary: "The client says a report is slow, without details.", type: "performance", acceptance_criteria: ["To be defined with the client"], affected_capabilities: [], open_questions: ["Which report and for what date range?"], risks: [], ready: false };
}
orqen(["complete", "REQ-1", "-"], JSON.stringify(out));
console.log(JSON.stringify({ type: "result", total_cost_usd: 0.02 }));
