## Testing (`TESTING`)

> If `human_present` is `true`, tell the person what you are about to do, wait for their OK at each important step, and ask them about any doubt (see "Working with the person" in AGENTS.md). If it is `false`, run `orqen block` for any doubt that changes the outcome.

orqen already started the complete environment, ran every configured test type (unit, integration, the full end-to-end regression, and visual), and shut it down. This is the only stage that runs the whole regression: development ran only the unit tests and the e2e of this change. See `test_result` and `environment`. The `scenarios` field lists the OpenSpec scenarios or, for the direct lane, the analysis acceptance criteria.

1. For each entry in `scenarios`, find the corresponding test and read its assertions to confirm the THEN behavior is covered.
2. Return one entry per item with the same `scenario` text, plus `covered` and `test` (`file::name`). `orqen complete` rejects missing entries.
3. If the suite failed, describe the probable cause in `failure_diagnosis` and give the developer actionable `suggestions`. Say whether each failure is in a test of this change or a regression in an unrelated test, and whether it looks flaky.
4. Set `coverage_ok: true` only when every scenario is covered.
5. Leave repository files as they are.
