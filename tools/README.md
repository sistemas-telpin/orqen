# tools — catálogo de stacks

Cada carpeta es un stack que `orqen create project` sabe crear y levantar. `_shared/` tiene scripts que usan varios stacks.

| Stack | Qué crea |
|---|---|
| `vue-node-postgres` | Front Vue 3 (generador oficial `create-vue`: Vite, TypeScript, Vitest, Playwright), API Node + Express con migraciones SQL, PostgreSQL en Docker |
| `java-tomcat-sqlserver` | App web Java 17 (WAR, Jakarta Servlet) en Tomcat 10 levantado por Maven (Cargo), migraciones Flyway, SQL Server en Docker |

## Cómo está hecho un stack

```
tools/<id>/
├── tool.yaml     qué pide, qué genera y cómo se levanta
└── scaffold/     esqueleto del proyecto: se copia tal cual, reemplazando {{VARIABLES}} en contenidos y rutas
```

`tool.yaml`:

| Clave | Para qué |
|---|---|
| `requisitos` | Comandos que necesita (`node`, `mvn`, `docker`…) con versión mínima. Si falta uno que usan los pasos de `scaffold`, no se crea el proyecto; si falta otro (ej. Docker), solo avisa |
| `parametros` | Preguntas extra (puertos, paquete Java…). Los puertos ocupados se reemplazan solos por el siguiente libre |
| `scaffold` | Pasos en orden: `copiar: scaffold`, `correr: <comando>` (generadores oficiales, `npm install`; `en:` carpeta), `archivo: <ruta>` + `contenido` |
| `tools` | Scripts que se copian a `orqen/tools/` del proyecto (ej. `_shared/db.mjs`) |
| `db` | Motor, puerto, base, usuario y contraseña → `orqen/tools/db.json` del proyecto |
| `stack`, `entornos` | Lo que va a `orqen/config.yaml`: componentes, procesos que lo levantan, variables, migraciones y tests |

Variables disponibles: `{{PROYECTO}}` (nombre), `{{PROYECTO_ID}}` (`plataforma-pagos`), `{{PROYECTO_JAVA}}` (`plataformapagos`),
`{{DB_PASSWORD}}` (aleatoria, cumple las reglas de SQL Server) y las de `parametros` (`{{PAQUETE}}` → también `{{PAQUETE_RUTA}}`).

Los archivos `.gitignore` y `.npmrc` del esqueleto se guardan sin el punto (`gitignore`, `npmrc`) porque npm no los publica;
orqen les pone el punto al copiarlos.

## La base de datos

`_shared/db.mjs` levanta la base en Docker (solo la base: las apps corren con sus comandos normales). En cada proyecto queda
como `orqen/tools/db.mjs` + `orqen/tools/db.json`, y en `orqen/config.yaml` como un proceso más:

```yaml
- nombre: db
  comando: node orqen/tools/db.mjs up       # crea o arranca el contenedor, espera que acepte conexiones y crea la base
  detener: node orqen/tools/db.mjs down     # orqen lo corre antes de cortar el proceso (si no, el contenedor quedaría prendido)
  listo_si: "orqen-db: ready"
```

Los datos quedan en un volumen de Docker entre `down` y `up`; `node orqen/tools/db.mjs reset` los borra. Motores: `postgres`, `sqlserver`.

## Agregar un stack

1. Copiá la carpeta del stack más parecido y cambiá `id`, `nombre` y `descripcion`.
2. Ajustá `scaffold/` y los pasos de `scaffold` en `tool.yaml`.
3. Definí cómo se levanta cada parte en `entornos.procesos` y los comandos de `tests`.
4. Corré `npm test` en `cli/` (valida que todos los `tool.yaml` del catálogo sean correctos) y probalo con
   `orqen create project prueba --stack <id>`.
