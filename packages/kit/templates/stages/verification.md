## Operational verification (`VERIFICACION`)

A person applied the approved change. Their report is in `feedback_humano`.

1. Run the read-only checks from `etapas_previas.EJECUCION.verificacion`. Do not modify data or services.
2. Compare the results with the expected state and acceptance criteria in `etapas_previas.ANALISIS`.
3. Record concrete evidence in `evidencia`, such as counts, rows, or service status.
4. Set `verificado: true` only if the evidence confirms the fix. Provide a customer-facing `mensaje_cliente` and clear `pasos_validacion`.
5. If the issue persists, set `verificado: false` and explain the results. The request returns to `EJECUCION`. If you verify that a code defect will cause recurrence, also set `requiere_desarrollo: true` so the analyst can reassess and open a new SIS.
