---
description: Analiza un REC con vos (grilling), propone el carril, genera la spec si corresponde y crea el SIS en Jira
argument-hint: REC-1234 [nombre del analista]
allowed-tools: Bash(./cli/bin/rec:*), Read, Grep, Glob, Write, Edit, Skill
---

Vas a conducir el **análisis del REC `$ARGUMENTS`** junto con el analista que te invocó (el primer argumento es la key; si hay más texto, es el nombre del analista; si no, preguntáselo una vez y recordalo).
Seguí el proceso de `AGENTS.md` ("Proceso REC"). Estás parado en la raíz del repo.

## Reglas que no se negocian

- **Jira es de solo lectura para vos.** Si tenés el MCP de Jira/Atlassian, usalo únicamente para leer (issue, comentarios, vinculados, búsquedas de REC parecidos). Crear el SIS, vincularlo y comentar lo hace `./cli/bin/rec`, nunca el MCP.
- Nada de `git commit/push/checkout/reset`, `openspec archive`, ni editar `cli/.estado/` o `factory/`: lo hace `rec`.
- No avanzás sin el **OK explícito del analista** al análisis y al carril. Si dudás de que lo haya dado, preguntá.
- No inventes información del cliente: lo que falte es una pregunta o un supuesto marcado.

## Pasos

1. Validá que la key tenga forma `REC-<número>`; si no, pedila y cortá.
2. Abrí el análisis (reserva el REC, crea `factory/<KEY>/` e imprime las instrucciones, el contexto completo y el esquema de salida):
   ```sh
   ./cli/bin/rec analizar <KEY> --analista "<nombre>" --agente analista
   ```
   Si falla (REC ya analizado, esperando al cliente, sin credenciales de Jira), explicale al analista el motivo y frená.
3. Cargá el skill **`orqen:grilling`** y entrevistá al analista como indica. Antes de preguntar, leé el REC (MCP de Jira si está, o el contexto de `rec analizar`) y el repo (`openspec/specs`, código, historial): no preguntes lo que podés averiguar.
4. Con el OK del analista, **proponé el carril** (`operativa`, `directo`, `liviano` o `completo`) con la tabla de criterios de la guía impresa en el paso 2, y pedí confirmación.
5. Carril `liviano` o `completo`: corré `./cli/bin/rec carril <KEY> <carril> --agente analista` y escribí la spec con el analista siguiendo lo que imprime. Carril `directo` u `operativa`: sin spec.
6. Escribí la salida JSON y cerrá:
   ```sh
   ./cli/bin/rec completar <KEY> <archivo.json> --agente analista
   ```
   Si lista errores, corregilos (la salida o la spec) y repetí hasta ver `✔`.
7. Cerrá contándole al analista, en pocas líneas: carril elegido, el SIS creado y vinculado al REC (key), la ruta `factory/<KEY>/`, y la etapa que sigue. Una etapa por vez: no sigas con el desarrollo.

Si no se puede avanzar: `./cli/bin/rec bloquear <KEY> "motivo concreto"`.
