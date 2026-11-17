## Etapa TESTING — verificación contra los escenarios

El proceso ya corrió la suite (`test_result` en el contexto) y te pasa en `scenarios` lo que hay que cubrir: los Scenarios de los spec deltas (carriles liviano/completo) o los criterios de aceptación del análisis (carril directo, `requirement: "Acceptance criterion"`).

1. Para **cada** ítem de `scenarios`, buscá el/los test(s) que lo verifican y confirmá leyendo el código que el test realmente comprueba el THEN (no solo que exista).
2. Devolvé un ítem en `scenarios` por cada uno, con el **mismo texto** en `scenario`, más `covered` y `test` (`archivo::nombre`). `orqen complete` rechaza la salida si falta alguno.
3. Si la suite falló, diagnosticá la causa probable en `failure_diagnosis` y dejá `suggestions` concretas para la etapa de desarrollo.
4. `coverage_ok: true` solo si todo está cubierto.
5. No modifiques archivos.
