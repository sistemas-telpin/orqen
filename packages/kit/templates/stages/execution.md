## Operational preparation (`EJECUCION`)

This request can be resolved through SQL, data cleanup, a restart, or a configuration change. Prepare the proposal for a person to authorize and apply. Do not modify data or services.

1. Read the issue, conversation, and `etapas_previas.ANALISIS`. Address feedback from `feedback_humano` or a previous `etapas_previas.VERIFICACION` first.
2. Use read-only queries to understand the problem and estimate the number of affected rows in `filas_estimadas`.
3. Provide the applicable output fields:
   - `script_sql` with the smallest complete script. Use a specific WHERE clause for each UPDATE or DELETE. DROP and TRUNCATE are prohibited. Prefer an explicit transaction and an affected-row check.
   - `pasos_manuales` with ordered steps for non-SQL work.
   - `rollback` explaining how to reverse the change. Include a script or backup where possible and explain any irreversible steps.
   - `verificacion` with a read-only check that confirms the change worked.
   - `impacto`, `sistema`, and `riesgos` describing impact, affected systems, and risks.
4. `orqen complete` rejects unsafe SQL or an output with missing rollback or verification.
5. If the cause is a code defect, run `orqen block` and explain why the request needs a development lane.
