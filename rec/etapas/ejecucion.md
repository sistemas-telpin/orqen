## Etapa EJECUCION — carril rápido (sin desarrollo)

Este REC se resuelve **sin cambiar código**: script SQL, reinicio, limpieza de datos, configuración. No hay rama ni OpenSpec.
Vos **proponés**; nunca ejecutás nada que modifique datos o servicios. Una persona lo autoriza y lo aplica.

1. Leé el issue, la conversación y `etapas_previas.ANALISIS`. Si hay rechazo o resultado de una aplicación anterior en `feedback_humano` (o `etapas_previas.VERIFICACION`), corregí eso primero.
2. Entendé el problema con consultas **solo lectura** (SELECT). Con eso obtenés la cantidad de filas que el script va a tocar (`filas_estimadas`).
3. Producí:
   - `script_sql`: completo y mínimo. Todo `UPDATE`/`DELETE` lleva `WHERE` específico. Prohibido `DROP`/`TRUNCATE`. Preferí transacción explícita con chequeo de filas afectadas.
   - `pasos_manuales`: para lo que no es SQL (reinicio de servicio, comandos, configuración), en orden.
   - `rollback`: cómo se deshace (idealmente un script, o un backup/`SELECT INTO` previo). Si no hay vuelta atrás, decilo y justificá.
   - `verificacion`: un SELECT o chequeo de solo lectura que confirma que quedó resuelto.
   - `impacto`, `sistema`, `riesgos`.
4. `rec completar` rechaza la salida si el SQL no pasa las guardas (DROP/TRUNCATE, UPDATE/DELETE sin WHERE, WHERE trivial), o si falta rollback o verificación.
5. Si descubrís que la causa es un bug de código y no se arregla operativamente, no inventes un parche de datos: `rec bloquear` explicando que corresponde el carril de desarrollo.
