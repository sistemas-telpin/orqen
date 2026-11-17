## Testing (`TESTING`)

orqen already started the complete environment, ran the configured unit, integration, end-to-end, and visual tests, and shut it down. See `test_result` and `environment`. The `scenarios` field lists the OpenSpec scenarios or, for the direct lane, the analysis acceptance criteria.

1. For each entry in `scenarios`, find the corresponding test and read its assertions to confirm the THEN behavior is covered.
2. Return one entry per item with the same `scenario` text, plus `covered` and `test` (`file::name`). `orqen complete` rejects missing entries.
3. If the suite failed, describe the probable cause in `failure_diagnosis` and give the developer actionable `suggestions`.
4. Set `coverage_ok: true` only when every scenario is covered.
5. Leave repository files as they are.
