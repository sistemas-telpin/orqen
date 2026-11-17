# {{PROYECTO}}

Created with `orqen create project` (tool `java-tomcat-sqlserver`).

| Part | Where | Runs with |
|---|---|---|
| Web app (Java 17, Jakarta Servlet, WAR) | `src/main/java/{{PAQUETE_RUTA}}` | `mvn package cargo:run` → http://localhost:{{PUERTO_APP}} (Tomcat 10, downloaded by Maven) |
| SQL Server 2022 | Docker | `node orqen/tools/db.mjs up` → localhost:{{PUERTO_DB}}, database `{{PROYECTO_JAVA}}` |
| Migrations | `src/main/resources/db/migration` | `mvn flyway:migrate` (reads `FLYWAY_URL`, `FLYWAY_USER`, `FLYWAY_PASSWORD`) |

You do not need to start anything by hand: `orqen env up` starts SQL Server and Tomcat and runs the migrations;
`orqen env down` stops everything. Tests: `orqen env test` (`mvn test` = unit, `mvn verify -Dskip.unit=true` = integration, `*IT.java`).

The app reads `DB_URL`, `DB_USER` and `DB_PASSWORD` from the environment (orqen passes them from `orqen/config.yaml`).
The SQL Server password is for the local development container only. Empty database: `node orqen/tools/db.mjs reset`.
