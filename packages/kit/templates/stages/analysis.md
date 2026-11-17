## Analysis (`ANALISIS`)

A human analyst leads this stage. Use the `orqen:grilling` skill when available, or interview the analyst as described below. Obtain their explicit approval before advancing.

### 1. Read the context

- Read the issue and the full conversation. Comments with `es_del_agente: true` come from previous rounds. Look in `feedback_humano` for customer answers or the rejection that started this round.
- Use Jira MCP only to read issues, comments, links, and similar requests. If it is unavailable, use `orqen search '<JQL>'`. orqen handles Jira writes.
- Read the current specs using `openspec list --specs` and `openspec show <capability>`. Read the implementation where necessary. Ask the analyst only about information you cannot obtain from the repository or Jira.

### 2. Interview the analyst

- Ask one question at a time, or up to three if inseparable. Include your recommended answer and reasoning so the analyst can confirm or correct it.
- Cover business goals, scope and exclusions, roles and permissions, current and desired behavior, edge cases, data and integrations, non-functional requirements, operational alternatives, and risks.
- Follow up on decisions that affect the design. Record assumptions explicitly.
- Put up to five questions only the customer can answer in `preguntas_abiertas` and set `listo: false`. The request moves to `ESPERA_CLIENTE` until the customer responds.
- Record each decision in `decisiones` as a question and answer.

### 3. Confirm the analysis and lane

Summarize the proposed work, out-of-scope items, risks, and observable acceptance criteria in Given/When/Then form. Ask for explicit approval of the analysis, then propose a lane and ask the analyst to confirm it.

| Lane | When | Output |
| --- | --- | --- |
| Operational (`via: operativa`) | A data correction, SQL script, restart, or configuration change | No branch or spec. A person approves and applies the steps, followed by verification |
| Direct (`directo`) | One component, roughly four hours or less, low risk, no contract change | An ordered plan and acceptance criteria |
| Lightweight (`liviano`) | One or two capabilities, roughly two days or less, no architectural decisions | A proposal, spec deltas, a short design, and tasks |
| Full (`completo`) | Broader scope, migrations, integrations, security, billing, or architectural risk | A complete proposal, specs, design, and tasks |

When unsure, recommend the more rigorous lane and explain why. Once the analyst confirms, set `analista_ok: true`.

### 4. Produce the output

- For `liviano` or `completo`, run `orqen lane <KEY> <lane>` and write the OpenSpec artifacts with the analyst. orqen prepares the branch and commits the spec.
- Include `resumen`, `tipo`, `criterios_aceptacion`, `capacidades_afectadas`, `decisiones`, `riesgos`, and `preguntas_abiertas` as required by the JSON schema.
- Set `listo: true` and `analista_ok: true` and provide `via`, `carril`, and `justificacion_carril` once confirmed. For operational work, use `carril: "directo"`.
- For direct development, include the ordered `plan` and `estimacion_horas`. For a spec change, include `especificacion` with its assigned `cambio`, `resumen`, and `supuestos`.

`orqen complete` validates the JSON and any spec and task estimates, then creates and links the SIS, records the analysis in `orqen/work/<KEY>/`, and advances the request. Leave `orqen/state/` and Git operations to orqen.
