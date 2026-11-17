## OpenSpec change specification ([liviano|completo])

`orqen lane` created the branch and change. Work with the analyst to complete the artifacts. You are still in `ANALISIS`. Once the spec passes validation, produce the analysis output with `especificacion`, `listo`, and `analista_ok`.

1. Use `openspec-propose` or `/opsx:propose` if available. Otherwise, use `openspec status --change <change> --json` for the artifact order. For each ready artifact, run `openspec instructions <artifact> --change <change> --json` and write to `resolvedOutputPath` following the template, instructions, and rules. Produce the proposal, spec deltas, design, and tasks.
2. Follow the approved lane:
   [liviano] - **Lightweight**: Keep the proposal, deltas, and task list focused. Include a short design with Context, Decisions, and Risks.
   [completo] - **Full**: Document design decisions and alternatives, migrations, risks, and rollout. Include one spec delta per affected capability.
3. Cover every acceptance criterion with at least one `#### Scenario:` using WHEN and THEN. For existing capabilities, use their exact path from `openspec list --specs` and the `## MODIFIED Requirements` heading.
4. End each task with its estimate in hours, for example `- [ ] 1.1 Add an export endpoint (4h)`. Include testing and documentation tasks. Reference the REC key in the proposal's Why section.
5. Run `openspec validate <change> --strict` and fix validation errors. If `feedback_humano[].rechazo` or an earlier round contains feedback, update the existing artifacts.
6. Leave implementation for development. orqen commits the spec when analysis closes.
