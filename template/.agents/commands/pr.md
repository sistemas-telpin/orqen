---
description: Manda la rama del SIS a la rama de desarrollo (devel) con un pull request que explica los cambios realizados
argument-hint: SIS-32
allowed-tools: Bash(./cli/bin/orqen:*), Bash(git diff:*), Bash(git log:*), Bash(git status:*), Bash(git branch:*), Bash(git show:*), Read, Grep, Glob, Write
---

Vas a **redactar la explicación de los cambios del SIS `$ARGUMENTS`** y a pedirle a `orqen` que abra el **pull request de su rama hacia la rama de desarrollo** (`DEVEL_BRANCH`, por defecto `desarrollo`). Seguí `AGENTS.md` ("Proceso REC"). Estás parado en la raíz del repo.

El PR a desarrollo es distinto del PR del code review que abre `orqen` al aprobar TESTING: este es la integración de lo ya implementado. La explicación es lo que va a leer quien revise e integre: tiene que servirle sin abrir Jira.

## Reglas que no se negocian

- **El commit, el push y el PR los hace `orqen pr`**, no vos. Prohibido `git commit/push/checkout/reset/rebase`, `gh pr`, cambiar de rama, `openspec archive`, escribir en Jira (tampoco por MCP) y editar `cli/.state/`, `orqen/work/` o los scripts de `cli/`.
- **Describí lo que hay realmente**, no lo que dice el análisis: la fuente es el diff. Si el diff se aparta de la spec o del plan, decilo. Nada inventado ni resultados de tests que no viste.
- Español rioplatense, claro y profesional. Encabezados estructurales de OpenSpec y SHALL/MUST en inglés.

## Pasos

1. Validá que el argumento tenga forma `SIS-<número>` (o el prefijo del proyecto SIS configurado); si no, pedilo y cortá. También se acepta la key del REC.
2. Consultá a dónde va y si se puede (no toma ni cambia nada):
   ```sh
   ./cli/bin/orqen pr <SIS>
   ```
   Imprime `branch`, `base`, `lane`, `sis`, la ruta del `analysis` y el `change` de OpenSpec, y si ya hay un PR (`existing`). Si falla (aún en desarrollo, carril operativo, desconocido), explicale el motivo al usuario y cortá.
3. Confirmá que estás en esa rama (`git branch --show-current`). Si no, pedile al usuario que cambie (vos no podés) y cortá. Si hay cambios sin commitear (por ejemplo ajustes manuales de e2e), avisá: `orqen pr` los va a commitear en la rama antes de empujar.
4. **Reuní los hechos**:
   - `git log <base>..HEAD --oneline` y `git diff <base>...HEAD --stat`, y leé los cambios que importan (`git diff <base>...HEAD -- <ruta>`); `<base>` es el `base` del paso 2 (si no existe local, `origin/<base>`).
   - El análisis (`analysis`): resumen, criterios de aceptación, decisiones del grilling, riesgos.
   - Con change de OpenSpec: `proposal.md`, y los deltas de `specs/`; en carril `direct`, el `plan`.
   - Los tests agregados y, si existen, los e2e. Corré los tests solo si hace falta para afirmar un resultado.
5. **Escribí la explicación** en un archivo temporal (por ejemplo `/tmp/<KEY>-pr.md`), en Markdown, con estas secciones (omití las que no apliquen):
   - **Resumen**: qué pidió el cliente y qué hace el cambio, en 2–4 líneas (REC y SIS).
   - **Cambios realizados**: por componente o capacidad, no archivo por archivo.
   - **Decisiones y desvíos**: decisiones del grilling que condicionan el código, y diferencias entre lo implementado y la spec o el plan.
   - **Tests**: qué se agregó y cómo se mapea a los escenarios / criterios de aceptación.
   - **Cómo verificarlo**: pasos concretos para quien revisa.
   - **Riesgos y pendientes**: migraciones, configuración nueva, compatibilidad, lo que quedó afuera.
   El título lo arma `orqen` a partir del análisis; si querés uno mejor, pasalo con `--title "<≤ 80 caracteres>"`.
6. **Abrilo**:
   ```sh
   ./cli/bin/orqen pr <SIS> /tmp/<KEY>-pr.md [--title "<título>"] --agent pr
   ```
   `orqen` guarda la explicación en `orqen/work/<KEY>/round-N/devel-pr.md`, commitea lo pendiente de la rama, empuja, abre el PR hacia la base y lo comenta en el REC y el SIS. Si el PR ya existía, solo actualiza la rama. Si falla (sin `gh`, sin remoto, explicación corta), corregí lo que corresponda y repetí.
7. Cerrá contándole al usuario, en pocas líneas: la URL del PR, la rama y la base, y lo más importante de la explicación (desvíos o riesgos). Una etapa por vez: no sigas con ninguna otra.
