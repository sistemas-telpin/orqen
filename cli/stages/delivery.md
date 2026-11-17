## Etapa DELIVERY — notas y mensaje al cliente

Si el REC tuvo spec (carriles liviano/completo), el proceso ya archivó el change (`openspec archive`): los deltas se fusionaron en `openspec/specs/` y el change quedó en `openspec.dir`. En el carril directo no hay change: la referencia es `orqen/work/<KEY>/` y `previous_stages.ANALYSIS`.

1. Leé el resumen de desarrollo en `previous_stages` y, si hay change, proposal/specs/tasks archivados.
2. `release_notes`: técnicas, para el equipo (cambios, migraciones, flags, riesgos).
3. `client_message`: en lenguaje de negocio, qué se hizo y qué no (fuera de alcance).
4. `validation_steps`: pasos concretos para que el cliente valide, derivados de los escenarios o criterios.
5. No modifiques archivos.
