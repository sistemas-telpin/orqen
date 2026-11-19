# Prueba guiada del flujo de orqen

Guía para probar el flujo a mano, con comandos para Git Bash. Recorre dos pedidos contra `sistemas-telpin/superov` (project 4):

- **Flujo A (GH-7):** un pedido directo, de punta a punta hasta `CODE_REVIEW`.
- **Flujo B (GH-8):** soporte, ida y vuelta con el cliente y derivación a análisis, hasta `CODE_REVIEW`.

Los números GH-7 y GH-8 son los que seguían a la última prueba. Si GitHub te asigna otros, reemplazalos en todos los comandos.
Para qué sirve cada paso y cómo se relaciona con las skills `/orqen:*`, ver [flujo-paso-a-paso.md](flujo-paso-a-paso.md).

## 0. Antes de empezar

- Tenés que haber configurado el token con `orqen connectors setup`; queda en `~/.orqen/credentials.env`.
- Los comentarios del cliente los escribís vos en GitHub, en cada issue. Si el comentario es un comando, tiene que empezar con
  `/reject` o `/approve`.
- En cada pedido, usá el **mismo `--agent`** en todos los comandos de una etapa (`analyst`, `implementer`, `tester`, `support`).
  Si cambia entre `analyze` y `complete`, orqen responde `is taken by "…"`.
- El estado de los pedidos queda en el **clon principal** (`<clon de superov>/orqen/state/`), no en el worktree.
- Si el `orqen` de tu máquina viene de `npm link`, corré `npm run build` en `cli/` después de cambiar código.

## 1. Preparar un repo de prueba

```sh
cd /c/Users/enzo-sives/Documents/superov
git fetch origin
git worktree add -b prueba-orqen-3 ../superov-prueba origin/main     # no toca tu clon ni main
cd ../superov-prueba
git config user.name "Tu Nombre" && git config user.email "tu@mail"

orqen init --yes --no-ai --no-openspec --no-connectors --commit     # instala orqen y commitea solo esos archivos
git log --oneline -1                                                # debería decir: Install orqen
```

Configurá los conectores sin `transitions`, para ver que se propongan solas:

```sh
echo '{"conectores":{"requests":{"tipo":"github","repo":"sistemas-telpin/superov","proyecto":4,"campo":"Status","filtro":"is:open"}},"env":{}}' | orqen connectors set -
orqen connectors          # debe decir ✔ repo sistemas-telpin/superov, project 4 (Backlog, Ready, In progress, In review, Done)
```

En `orqen/config.yaml`, verificá que `connectors.requests` tenga `transitions` (`ANALYSIS: In progress`, `ACCEPTANCE: In review`,
`CLOSED: Done`, `CANCELLED: Done`).

Ahora dos ajustes **a mano**, para que la prueba sea liviana (la suite real de superov falla en `main`):

1. En `orqen/config.yaml`, cambiá `project.base_branch` a `prueba-orqen-3`.
2. En `orqen/environment.yaml`, dejá `processes: []`, `prepare: []` y `tests: { unit: node --test scripts/orqen-prueba-7.test.cjs }`.

```sh
git add -A && git commit -m "Config de prueba (local)"
```

## 2. Crear los pedidos

En GitHub, en `sistemas-telpin/superov` → **Issues → New issue**:

- **A:** título `Prueba 3 de orqen: agregar docs/prueba-orqen-7.md`. Descripción: "Agregar el archivo `docs/prueba-orqen-7.md` con el
  título `# Prueba 3 de orqen` y una línea que mencione a orqen."
- **B:** título `Prueba 3 de orqen (soporte): cargar destinatarios de una campaña`. Descripción: "Soy nueva en el equipo y no encuentro cómo
  se carga la lista de destinatarios de una campaña en el admin. ¿Me explican?"
- En cada uno, en la barra lateral, **Projects → project 4**. Si no están en el project, orqen no los ve.

Esperá unos segundos (la búsqueda de GitHub tarda en indexar) y corré:

```sh
orqen list requests        # GH-7 y GH-8 deben aparecer como NEW, con /orqen:analyze al lado
```

## 3. Flujo A: directo hasta CODE_REVIEW (GH-7)

### 3.1 Análisis

```sh
orqen analyze GH-7 --agent analyst --analyst "Tu Nombre"   # reserva el pedido (ANALYSIS) y muestra el contexto
orqen lane GH-7 direct --agent analyst                     # registra el carril: directo, sin spec
orqen schema ANALYSIS                                      # forma del JSON que sigue
cat > /tmp/a-analysis.json <<'EOF'
{ "summary": "Agregar docs/prueba-orqen-7.md con un título y una línea que indique que lo generó orqen.",
  "type": "change",
  "acceptance_criteria": ["Dado el repositorio, cuando se abre docs/prueba-orqen-7.md, entonces existe y su primera línea es '# Prueba 3 de orqen'.", "Dado el archivo, cuando se lee, entonces menciona a orqen."],
  "affected_capabilities": [], "open_questions": [], "risks": [],
  "ready": true, "analyst_ok": true, "route": "development", "lane": "direct",
  "lane_rationale": "Un solo archivo de documentación.",
  "plan": ["Crear docs/prueba-orqen-7.md.", "Agregar scripts/orqen-prueba-7.test.cjs que lo verifique."],
  "estimated_hours": 0.5 }
EOF
orqen complete GH-7 /tmp/a-analysis.json --agent analyst   # valida, comenta en el issue, pasa a DEVELOPMENT
```

Deberías ver `✔ GH-7 → DEVELOPMENT`. En GitHub: un comentario con **negrita** y lista (no títulos grandes), la etiqueta
`orqen-state-development` y la columna In progress.

### 3.2 Desarrollo

```sh
orqen take GH-7 --agent implementer     # crea la rama orqen/gh-7 y prepara el entorno
git branch --show-current               # orqen/gh-7
printf '# Prueba 3 de orqen\n\nEste archivo lo generó el flujo de orqen.\n' > docs/prueba-orqen-7.md
cat > scripts/orqen-prueba-7.test.cjs <<'EOF'
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const file = path.join(__dirname, '..', 'docs', 'prueba-orqen-7.md');
test('existe y su primera línea es el título', () => {
  assert.equal(fs.readFileSync(file, 'utf8').split(/\r?\n/)[0], '# Prueba 3 de orqen');
});
test('menciona a orqen', () => { assert.match(fs.readFileSync(file, 'utf8'), /orqen/i); });
EOF
orqen env test unit                     # corre solo el test de este cambio
cat > /tmp/a-dev.json <<'EOF'
{ "completed": true, "changes_summary": "Se agregó docs/prueba-orqen-7.md y su test.", "modified_files": ["docs/prueba-orqen-7.md", "scripts/orqen-prueba-7.test.cjs"], "added_tests": ["scripts/orqen-prueba-7.test.cjs"] }
EOF
orqen complete GH-7 /tmp/a-dev.json --agent implementer   # commitea la rama y pasa a TESTING
```

### 3.3 Testing

```sh
orqen take GH-7 --agent tester          # orqen corre toda la suite configurada y la muestra (test_result)
cat > /tmp/a-testing.json <<'EOF'
{ "scenarios": [
    { "requirement": "Acceptance criterion", "scenario": "Dado el repositorio, cuando se abre docs/prueba-orqen-7.md, entonces existe y su primera línea es '# Prueba 3 de orqen'.", "covered": true, "test": "scripts/orqen-prueba-7.test.cjs::existe y su primera línea es el título" },
    { "requirement": "Acceptance criterion", "scenario": "Dado el archivo, cuando se lee, entonces menciona a orqen.", "covered": true, "test": "scripts/orqen-prueba-7.test.cjs::menciona a orqen" } ],
  "failure_diagnosis": "", "suggestions": [], "coverage_ok": true }
EOF
orqen complete GH-7 /tmp/a-testing.json --agent tester     # → CODE_REVIEW
orqen pr GH-7                           # solo informa: rama orqen/gh-7, base, carril
orqen status GH-7                       # estado e historial
```

Camino recorrido: `NEW → ANALYSIS → DEVELOPMENT → TESTING → CODE_REVIEW`. Verificá en el project que el item siga en In progress.

## 4. Flujo B: soporte, ida y vuelta con el cliente, análisis (GH-8)

### 4.1 Soporte responde

```sh
orqen support GH-8 --agent support --person "Tu Nombre"
cat > /tmp/b-support.json <<'EOF'
{ "summary": "Una persona nueva no encuentra cómo se carga la lista de destinatarios de una campaña en el admin.",
  "checked": ["El pedido y sus comentarios", "admin/src/pages/CampaignsPage.vue: acepta .csv, .xlsx y .txt de hasta 5 MB y usa la primera hoja"],
  "outcome": "resolved",
  "client_response": "Hola. En el admin, entrá a Campañas, abrí la campaña y cargá el archivo de destinatarios: acepta CSV, TXT o Excel (.xlsx), hasta 5 MB. ¿Te sirve? Respondé /approve o /reject y contanos qué te falta.",
  "escalation_summary": "", "support_ok": true }
EOF
orqen complete GH-8 /tmp/b-support.json --agent support    # publica la respuesta; pasa a ACCEPTANCE (columna In review)
```

### 4.2 El cliente rechaza (lo hacés vos, en GitHub)

En el issue GH-8, comentá: `/reject Gracias, pero necesito una guía por escrito dentro del repositorio para pasársela al equipo.`

```sh
orqen list requests          # lee el comentario: GH-8 pasa solo a ANALYSIS
orqen status GH-8            # round: 2, y feedback con el rechazo
```

### 4.3 Análisis con preguntas al cliente

```sh
orqen analyze GH-8 --agent analyst --analyst "Tu Nombre"   # el contexto incluye el resumen de soporte y el rechazo
cat > /tmp/b-q.json <<'EOF'
{ "summary": "La persona necesita una guía escrita en el repositorio para cargar destinatarios de una campaña.",
  "type": "change", "acceptance_criteria": ["Pendiente de confirmar idioma y detalle con el cliente."],
  "affected_capabilities": [], "open_questions": ["¿La guía debe estar en español?", "¿Incluimos los errores más comunes?"],
  "risks": [], "ready": false, "analyst_ok": false }
EOF
orqen complete GH-8 /tmp/b-q.json --agent analyst          # publica las preguntas; pasa a WAITING_CLIENT
orqen analyze GH-8 --agent analyst                         # debe negarse: "is waiting for client answers"
```

En GitHub, la lista de preguntas debe verse numerada.

### 4.4 El cliente contesta (en GitHub)

Comentá en GH-8: `Sí, en español, y con los errores más comunes.`

```sh
orqen list requests          # GH-8 vuelve a ANALYSIS con tu respuesta como feedback
orqen analyze GH-8 --agent analyst --analyst "Tu Nombre"
orqen lane GH-8 direct --agent analyst
cat > /tmp/b-ok.json <<'EOF'
{ "summary": "Guía en español para cargar destinatarios de una campaña, con pasos, formatos y errores comunes.",
  "type": "change",
  "acceptance_criteria": ["Dado el repositorio, cuando se abre docs/prueba-orqen-8.md, entonces existe y su primera línea es '# Cargar destinatarios de una campaña'.", "Dado la guía, cuando se lee, entonces indica CSV, TXT, .xlsx y el límite de 5 MB."],
  "affected_capabilities": [], "open_questions": [], "risks": [],
  "ready": true, "analyst_ok": true, "route": "development", "lane": "direct",
  "lane_rationale": "Un solo documento nuevo.",
  "plan": ["Crear docs/prueba-orqen-8.md.", "Agregar scripts/orqen-prueba-8.test.cjs."], "estimated_hours": 1 }
EOF
orqen complete GH-8 /tmp/b-ok.json --agent analyst         # → DEVELOPMENT
```

### 4.5 Desarrollo y testing de GH-8

Es igual que 3.2 y 3.3, cambiando la clave y los archivos:

```sh
orqen take GH-8 --agent implementer                        # crea orqen/gh-8
# en orqen/environment.yaml: tests: { unit: node --test scripts/orqen-prueba-8.test.cjs }
# crear docs/prueba-orqen-8.md (título '# Cargar destinatarios de una campaña', con CSV, TXT, .xlsx y 5 MB) y su test
orqen env test unit
orqen complete GH-8 /tmp/b-dev.json --agent implementer    # mismo formato que a-dev.json
orqen take GH-8 --agent tester
orqen complete GH-8 /tmp/b-testing.json --agent tester     # mismo formato que a-testing.json
```

## 5. Verificaciones extra

**Recuperar el estado en otra máquina.** Simulá que otro clon no tiene registro de GH-7:

```sh
mkdir -p /tmp/respaldo
mv /c/Users/enzo-sives/Documents/superov/orqen/state/GH-7.json /c/Users/enzo-sives/Documents/superov/orqen/state/GH-7.log.jsonl /tmp/respaldo/
orqen list requests          # GH-7 reaparece en CODE_REVIEW, recuperado de la foto de la rama
orqen status GH-7            # el último evento dice: record recovered from …/state.json
```

Para ver el caso "solo por la etiqueta", borrá además la rama (`git branch -D orqen/gh-7`) y la carpeta `orqen/worqs/GH-7` del árbol:
`list` mostrará el estado con la nota `← state read from the ticket`.

**Cancelar un pedido.** Con GH-8 sirve como último paso:

```sh
orqen cancel GH-8 --reason "Cierre de la prueba"           # comenta, pasa a CANCELLED, columna Done y cierra el issue
```

## 6. Si querés seguir hasta el PR (no probado)

1. Instalá `gh` y autenticá: `winget install GitHub.cli`, abrí una terminal nueva y `gh auth login`.
2. La rama de integración `desarrollo` no existe en superov: en `orqen/config.yaml` poné `workflow.devel_branch: main` y commiteá.
3. Escribí una explicación en `/tmp/pr.md` y corré `orqen pr GH-7 /tmp/pr.md --agent pr`. Esto **empuja la rama `orqen/gh-7` y abre un PR real
   contra `main`**, que no hay que mergear.
4. `orqen list prs` muestra el CI y los conflictos del PR.
5. Para decidir como senior: `orqen approve GH-7 --agent senior` (o `--changes comentario.md`). GitHub no deja que quien abrió el PR lo
   apruebe; si probás solo, poné `workflow.code_review.gate: ticket`.
6. Merge a mano en GitHub (orqen nunca mergea), o `orqen merged GH-7`. Después `orqen take GH-7 --agent delivery`; la forma del JSON está
   en `orqen schema DELIVERY`, y `orqen complete GH-7 entrega.json --agent delivery` lo publica.
7. El cliente cierra con `/approve` en el issue, y `orqen list requests` lo pasa a `CLOSED`.

## 7. Limpieza

```sh
cd /c/Users/enzo-sives/Documents/superov
git worktree remove --force ../superov-prueba && git branch -D prueba-orqen-3 orqen/gh-7 orqen/gh-8
rm -f orqen/state/GH-7.* orqen/state/GH-8.*       # si no queda nada más, borrá la carpeta orqen/ de tu clon
```

En GitHub, cerrá GH-7 y GH-8 (o `orqen cancel`), y movelos a Done si no lo hizo orqen.

## Tropiezos conocidos

- `orqen list requests` tarda unos segundos en ver un issue recién creado.
- Un pedido que **no está en el project 4** no aparece.
- Si `take` dice "uncommitted changes", commiteá lo pendiente. La carpeta `orqen/worqs/` no cuenta como cambio.
- Con `orqen pr`, el error "base branch not found" significa que `devel_branch` apunta a una rama que no existe.
