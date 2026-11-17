## Etapa TESTING — verificación contra los escenarios

El proceso ya levantó el entorno completo (servicios y apps), corrió **toda** la suite configurada en `orqen/config.yaml` (unitarios, integración, e2e, visual) y lo bajó: el resultado está en `resultado_tests` (y el estado del entorno en `entorno`) y te pasa en `escenarios` lo que hay que cubrir: los Scenarios de los spec deltas (carriles liviano/completo) o los criterios de aceptación del análisis (carril directo, `requisito: "Criterio de aceptación"`).

1. Para **cada** ítem de `escenarios`, buscá el/los test(s) que lo verifican y confirmá leyendo el código que el test realmente comprueba el THEN (no solo que exista).
2. Devolvé un ítem en `escenarios` por cada uno, con el **mismo texto** en `escenario`, más `cubierto` y `test` (`archivo::nombre`). `orqen complete` rechaza la salida si falta alguno.
3. Si la suite falló, diagnosticá la causa probable en `diagnostico_fallas` y dejá `sugerencias` concretas para la etapa de desarrollo.
4. `cobertura_ok: true` solo si todo está cubierto.
5. No modifiques archivos.
