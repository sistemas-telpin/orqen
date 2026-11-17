## Etapa VERIFICACION — carril rápido

Una persona ya aplicó lo autorizado (su resultado está en `feedback_humano`). Tu trabajo es comprobar que el problema quedó resuelto.

1. Corré la `verificacion` propuesta en `etapas_previas.EJECUCION` (solo lectura: SELECT o chequeos). No modifiques datos ni servicios.
2. Comparala con el estado esperado y con los criterios de `etapas_previas.ANALISIS`.
3. Producí:
   - `evidencia`: el resultado concreto (conteos, filas, estado del servicio).
   - `verificado: true` solo si la evidencia confirma la solución. Entonces completá `mensaje_cliente` (lenguaje de negocio) y `pasos_validacion` para que el cliente confirme.
   - `verificado: false` si no se resolvió: explicalo en `evidencia`; se vuelve a EJECUCION con tu diagnóstico.
   - `requiere_desarrollo: true` (con `verificado: false`) si comprobaste que la causa es de código y volverá a ocurrir: el REC vuelve a ANALISIS: el analista re-analiza y elige el carril de desarrollo (y nace un SIS nuevo).
