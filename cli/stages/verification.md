## Etapa VERIFICATION — carril rápido

Una persona ya aplicó lo autorizado (su resultado está en `human_feedback`). Tu trabajo es comprobar que el problema quedó resuelto.

1. Corré la `verification` propuesta en `previous_stages.EXECUTION` (solo lectura: SELECT o chequeos). No modifiques datos ni servicios.
2. Comparala con el estado esperado y con los criterios de `previous_stages.ANALYSIS`.
3. Producí:
   - `evidence`: el resultado concreto (conteos, filas, estado del servicio).
   - `verified: true` solo si la evidencia confirma la solución. Entonces completá `client_message` (lenguaje de negocio) y `validation_steps` para que el cliente confirme.
   - `verified: false` si no se resolvió: explicalo en `evidence`; se vuelve a EXECUTION con tu diagnóstico.
   - `requires_development: true` (con `verified: false`) si comprobaste que la causa es de código y volverá a ocurrir: el REC vuelve a ANALYSIS: el analista re-analiza y elige el carril de desarrollo (y nace un SIS nuevo).
