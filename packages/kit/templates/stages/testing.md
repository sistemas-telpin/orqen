## Testing (`TESTING`)

orqen already started the complete environment, ran the configured unit, integration, end-to-end, and visual tests, and shut it down. See `resultado_tests` and `entorno`. The `escenarios` field lists the OpenSpec scenarios or, for the direct lane, the analysis acceptance criteria.

1. For each entry in `escenarios`, find the corresponding test and read its assertions to confirm the THEN behavior is covered.
2. Return one entry per item with the same `escenario` text, plus `cubierto` and `test` (`file::name`). `orqen complete` rejects missing entries.
3. If the suite failed, describe the probable cause in `diagnostico_fallas` and give the developer actionable `sugerencias`.
4. Set `cobertura_ok: true` only when every scenario is covered.
5. Leave repository files as they are.
