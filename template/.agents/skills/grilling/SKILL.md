---
name: grilling
description: Entrevista (grilling) a un analista sobre un requerimiento hasta tener un entendimiento compartido y verificable, explorando antes el repo y Jira para no preguntar lo que ya se sabe. Usar al analizar un REC (/orqen:analyze) o cuando haya que estresar un plan o diseño antes de especificar.
---

# Grilling de un requerimiento

Objetivo: salir con un entendimiento compartido, sin ambigüedades que cambien el diseño, y con criterios de aceptación que se puedan testear. El analista es quien decide; vos hacés las preguntas que él no se hizo todavía.

## Método

1. **Investigá primero.** Antes de la primera pregunta leé: el issue y sus comentarios, REC parecidos o vinculados, `openspec/specs` de las capacidades probables, y el código involucrado (solo lectura). Cada pregunta que se contesta leyendo no se hace.
2. **Una pregunta por vez.** Máximo tres si son inseparables. Esperá la respuesta antes de seguir.
3. **Siempre con tu recomendación.** Formato: la pregunta, "Yo haría X porque Y", y lo que cambia si la respuesta es otra. El analista confirma, corrige o descarta.
4. **Recorré el árbol de decisiones en profundidad.** Si una respuesta abre otra duda, seguí por esa rama hasta cerrarla antes de pasar de tema. Orden sugerido:
   - Objetivo y valor de negocio: qué problema tiene el cliente y cómo se mide que quedó resuelto.
   - Alcance y **fuera de alcance** explícito.
   - Quién lo usa, con qué permisos, en qué pantallas/procesos.
   - Comportamiento actual (lo que encontraste en specs y código) vs. deseado: señalá contradicciones.
   - Casos borde y errores: vacíos, duplicados, concurrencia, datos viejos, montos/fechas límite.
   - Datos, migraciones e integraciones afectadas.
   - No funcionales: rendimiento, auditoría, seguridad.
   - **¿Se resuelve sin tocar código?** (script, dato, configuración). Si sí, es vía operativa.
   - Riesgos y cómo revertir.
5. **Separá lo que es del cliente.** Si solo el cliente puede contestarlo y bloquea el diseño, anotalo como pregunta abierta (máx. 5); no lo inventes ni se lo preguntes al analista como si lo supiera.
6. **Llevá el registro.** Anotá cada decisión como `pregunta → respuesta`; va a `decisiones` de la salida y a `factory/<KEY>/`.
7. **Cerrá con un resumen y pedí el OK.** Qué se hace, criterios de aceptación en Dado/Cuando/Entonces (observables y testeables), fuera de alcance, supuestos y riesgos. Sin OK explícito no hay carril ni SIS.

## Estilo

- Español rioplatense, claro y directo; sin relleno ni elogios.
- Preguntas cerradas siempre que se pueda (opciones con tu recomendada marcada).
- Si el analista dice "lo que te parezca", tomá tu recomendación y dejala registrada como supuesto.
- No avances a la propuesta de carril mientras queden ramas de decisión abiertas.

## Después del OK

Proponé el carril según la tabla de la etapa ANALISIS (`./cli/bin/rec analizar` la imprime), justificá en términos de tamaño, riesgo y alcance, y pedí confirmación. Ante la duda entre dos carriles, el de más rigor.
