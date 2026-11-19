import assert from "node:assert/strict";
import { test } from "node:test";
import { suggestTransitions } from "../src/lib/transitions-suggest.ts";

test("transitions are proposed from the columns of the project, in English and Spanish", () => {
  const gh = ["Backlog", "Ready", "In progress", "In review", "Done"];
  assert.deepEqual(suggestTransitions("requests", gh), { ANALYSIS: "In progress", ACCEPTANCE: "In review", CLOSED: "Done", CANCELLED: "Done" });
  assert.deepEqual(suggestTransitions("issues", gh), {
    DEVELOPMENT: "In progress", TESTING: "In progress", QA_REVIEW: "In review", CODE_REVIEW: "In review", CLOSED: "Done", CANCELLED: "Done",
  });
  assert.deepEqual(suggestTransitions("requests", ["Por hacer", "En curso", "En revisión", "Hecho"]), { ANALYSIS: "En curso", ACCEPTANCE: "En revisión", CLOSED: "Hecho", CANCELLED: "Hecho" });
  // only what has a clear match; nothing when no column fits
  assert.deepEqual(suggestTransitions("requests", ["Todo", "Done"]), { CLOSED: "Done", CANCELLED: "Done" });
  assert.deepEqual(suggestTransitions("issues", ["Alpha", "Beta"]), {});
  // "Done" must be a whole name: "Done soon" or "Undone" are not the closing column
  assert.deepEqual(suggestTransitions("requests", ["Done soon", "Undone"]), {});
});
