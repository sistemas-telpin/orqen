/**
 * Customer request workflow shared by the CLI and tests.
 *
 * Polling advances human gates and lists pending work.
 * Analysis is analyst-led and selects a development lane or operational route.
 * Taking an agent stage prepares its branch, environment, and instructions.
 * Completing a stage validates its output, publishes results, and advances the workflow.
 * Completing analysis creates and links the implementation issue.
 *
 */
import { relative } from "node:path";
import type { Config } from "./config.ts";
import { ESQUEMAS } from "./schemas.ts";
import {
  CARRILES, type Carril, type Estado, type EstadoAgente, GATES, esEstadoAgente, esGate, siguienteTrasEtapa,
} from "./states.ts";
import { Factory } from "./factory.ts";
import { BOT_MARCA, type Comentario, type JiraApi } from "./jira.ts";
import { type Escenario, type OpenSpecApi, type Tarea, horasDe } from "./openspec.ts";
import { revisarSql } from "./sql.ts";
import { type Rec, Store, recNuevo } from "./store.ts";
import type { EstadoEntorno, Workspace } from "./workspace.ts";

/** Jira comment commands. Older Spanish aliases remain supported. */
const CMD = /^\s*\/(approve|reject|aprobar|rechazar)\b\s*([\s\S]*)/i;
const accionDe = (palabra: string) => (/^(approve|aprobar)$/i.test(palabra) ? "aprobar" : "rechazar");

/** The para field identifies whether an analyst or an unattended agent acts next. */
export interface Pendiente { key: string; estado: EstadoAgente | "NUEVO"; para: "analista" | "agente"; tomadoPor?: string }
export type ResultadoCompletar = { ok: true; siguiente: Estado } | { ok: false; errores: string[] };

export class Proceso {
  private fac: Factory;
  constructor(
    private cfg: Config, private jira: JiraApi, private store: Store,
    private ws: Workspace, private os: OpenSpecApi,
  ) { this.fac = new Factory(cfg.factoryDir); }

  private workPath(rec: Rec, artifact?: string): string {
    const path = artifact ? this.fac.artifactPath(rec, artifact) : this.fac.roundDir(rec);
    return relative(this.cfg.repoPath, path).replaceAll("\\", "/");
  }

  // Poll for pending work.
  async revisar(): Promise<Pendiente[]> {
    const pendientes: Pendiente[] = [];
    for (const key of await this.jira.buscarKeys(this.cfg.jql)) {
      try {
        const rec = this.store.get(key) ?? recNuevo(key);
        if (esGate(rec.estado)) await this.revisarGate(rec as Rec & { estado: keyof typeof GATES });
        else if (rec.estado === "BLOQUEADO") await this.revisarDesbloqueo(rec);
        if (rec.estado === "NUEVO") pendientes.push({ key, estado: "NUEVO", para: "analista" });
        else if (esEstadoAgente(rec.estado)) {
          const lock = this.lockVigente(rec);
          pendientes.push({ key, estado: rec.estado, para: rec.estado === "ANALISIS" ? "analista" : "agente", tomadoPor: lock?.agente });
        }
      } catch (e) {
        await this.bloquear(key, `Error reviewing the request: ${(e as Error).message}`, "proceso");
      }
    }
    return pendientes;
  }

  // Analysis
  /** Start or resume an analyst-led review. */
  async analizar(key: string, agente = "agente", analista = agente) {
    const rec = this.store.get(key) ?? recNuevo(key);
    if (rec.estado === "ESPERA_CLIENTE")
      throw new Error(`${key} is waiting for a customer reply in Jira. A reply returns it to ANALISIS (\`orqen pending\`).`);
    if (rec.estado !== "NUEVO" && rec.estado !== "ANALISIS")
      throw new Error(`${key} has already completed analysis (stage: ${rec.estado}). A rejection or escalation can return it to ANALISIS.`);
    if (rec.estado === "NUEVO") {
      rec.analista = analista;
      await this.jira.comentar(key, `${analista} started analyzing this request.`);
      await this.mover(rec, "ANALISIS", "Analysis started by analyst", agente);
    }
    rec.analista = analista;
    this.store.save(rec);
    return this.tomar(key, agente, true);
  }

  /** Record the lane and prepare a branch and OpenSpec change when needed. */
  async carril(key: string, carril: string, agente = "agente") {
    const rec = this.store.get(key);
    if (!rec || rec.estado !== "ANALISIS") throw new Error(`${key} is not in ANALISIS (stage: ${rec?.estado ?? "unknown"}).`);
    const lock = this.lockVigente(rec) ?? (rec.lock?.agente === agente ? rec.lock : undefined);
    if (!lock || lock.agente !== agente) throw new Error(`First run \`orqen analyze ${key}\``);
    if (!CARRILES.includes(carril as Carril)) throw new Error(`Invalid lane "${carril}". Options: ${CARRILES.join(", ")}`);
    rec.carril = carril as Carril;
    if (rec.carril === "directo") {
      this.store.save(rec);
      return { carril: rec.carril, openspec: undefined as undefined | { cambio: string; dir: string }, rama: undefined as string | undefined };
    }
    const issue = await this.jira.issue(key);
    rec.rama = this.ws.prepararRama(key);
    if (!rec.cambio || !this.os.existe(rec.cambio)) {
      rec.cambio = nombreCambio(key, issue.titulo, rec.ronda);
      this.os.nuevoCambio(rec.cambio, `${key}: ${issue.titulo}`);
    }
    this.store.save(rec);
    return { carril: rec.carril, rama: rec.rama, openspec: { cambio: rec.cambio, dir: `openspec/changes/${rec.cambio}` } };
  }

  // Agent stage
  async tomar(key: string, agente = "agente", desdeAnalizar = false) {
    const rec = this.store.get(key);
    if (!rec || !esEstadoAgente(rec.estado))
      throw new Error(`${key} has no work for an agent (stage: ${rec?.estado ?? "unknown"}). Run \`orqen pending\`.`);
    if (rec.estado === "ANALISIS" && !desdeAnalizar)
      throw new Error(`Analysis of ${key} requires an analyst. Use /orqen:analyze ${key} (or \`orqen analyze ${key}\`).`);
    const lock = this.lockVigente(rec);
    if (lock && lock.agente !== agente) throw new Error(`${key} is already claimed by "${lock.agente}" since ${lock.desde}.`);
    rec.lock = { agente, desde: new Date().toISOString() };
    this.store.save(rec);

    const issue = await this.jira.issue(key);
    const estado = rec.estado;

    // Analysis and operational work do not prepare a branch here.
    if (["DESARROLLO", "TESTING", "ENTREGA"].includes(estado)) rec.rama = this.ws.prepararRama(key);
    // Start the configured environment automatically.
    // Development starts services and runs migrations.
    // Testing includes apps, runs the suite, and stops the environment.
    let entorno: EstadoEntorno | undefined;
    if (estado === "DESARROLLO") entorno = this.ws.levantarEntorno?.(false);
    if (estado === "TESTING") {
      entorno = this.ws.levantarEntorno?.(true);
      rec.artefactos.resultado_tests = this.ws.correrTests();
      this.intentar(() => this.ws.bajarEntorno?.());
    }
    if (estado === "ENTREGA" && rec.cambio && !rec.artefactos.archivo) {
      rec.artefactos.archivo = this.os.archivar(rec.cambio);
      this.ws.commit(key, `Archive OpenSpec change ${rec.cambio}`);
      this.intentar(() => this.ws.push(rec.rama));
    }
    this.store.save(rec);

    const comentarios = (await this.jira.comentarios(key)).map((c) => ({
      autor: c.autorNombre, fecha: c.creado, texto: c.cuerpo, es_del_agente: c.cuerpo.startsWith(BOT_MARCA),
    }));
    const openspec = rec.cambio ? {
      cambio: rec.cambio,
      dir: rec.artefactos.archivo ? `openspec/changes/archive/${rec.artefactos.archivo.archivadoComo}` : `openspec/changes/${rec.cambio}`,
    } : undefined;

    return {
      rec,
      contexto: {
        key, estado, ronda: rec.ronda, rama: rec.rama || undefined,
        analista: rec.analista, carril: rec.carril, factory: this.workPath(rec),
        issue, sis: rec.sis, comentarios,
        openspec,
        ...(["DESARROLLO", "TESTING"].includes(estado) ? { tareas: this.tareasDe(rec) } : {}),
        ...(estado === "TESTING" ? { escenarios: this.escenariosDe(rec) } : {}),
        resultado_tests: estado === "TESTING" ? rec.artefactos.resultado_tests : undefined,
        entorno,
        etapas_previas: Object.fromEntries(Object.entries(rec.artefactos).filter(([k]) => ESQUEMAS[k as EstadoAgente])),
        feedback_humano: rec.feedback,
      },
    };
  }

  // Stage completion
  async completar(key: string, bruto: unknown, agente = "agente"): Promise<ResultadoCompletar> {
    const rec = this.store.get(key);
    if (!rec || !esEstadoAgente(rec.estado)) return { ok: false, errores: [`${key} is not in an agent stage`] };
    // An expired lock remains valid until another agent claims the request.
    const lock = this.lockVigente(rec) ?? (rec.lock?.agente === agente ? rec.lock : undefined);
    if (!lock) return { ok: false, errores: [`First run \`orqen ${rec.estado === "ANALISIS" ? "analyze" : "take"} ${key}\``] };
    if (lock.agente !== agente) return { ok: false, errores: [`${key} is claimed by "${lock.agente}"`] };

    const estado = rec.estado;
    const parsed = ESQUEMAS[estado].safeParse(bruto);
    if (!parsed.success)
      return { ok: false, errores: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`) };
    const s: Record<string, any> = parsed.data;

    // Validate the spec and repository artifacts before advancing.
    const errores = this.validarContraOpenSpec(rec, estado, s);
    if (errores.length) return { ok: false, errores };

    // Update retry counters and determine the next stage.
    if (estado === "ANALISIS") {
      rec.via = s.via;
      if (s.listo) rec.carril = s.carril;
      if (s.preguntas_abiertas.length && !s.listo) rec.rondasPreguntas++;
    }
    if (estado === "VERIFICACION") rec.intentosTesting++;
    if (estado === "TESTING") {
      rec.intentosTesting++;
      s.aprobado = rec.artefactos.resultado_tests?.ok === true && s.cobertura_ok && s.escenarios.every((e: any) => e.cubierto);
    }
    rec.artefactos[estado] = s;
    const siguiente = siguienteTrasEtapa(estado, s, rec);
    if (estado === "VERIFICACION" && siguiente === "ANALISIS") { // The next analysis creates a development SIS.
      rec.via = "desarrollo"; delete rec.carril; delete rec.artefactos.sis_vinculado;
      if (rec.sis) { (rec.artefactos.sis_previos ??= []).push(rec.sis); delete rec.sis; }
    }
    if (estado === "VERIFICACION" && siguiente !== "EJECUCION") rec.intentosTesting = 0;

    if (estado === "ANALISIS" && s.listo) await this.cerrarAnalisis(rec, s);
    await this.publicar(rec, estado, s, siguiente);
    rec.feedback = [];
    await this.mover(rec, siguiente, `Completed stage ${estado}`, agente);
    return { ok: true, siguiente };
  }

  private validarContraOpenSpec(rec: Rec, estado: EstadoAgente, s: Record<string, any>): string[] {
    const err: string[] = [];
    if (estado === "ANALISIS" && s.listo && s.via === "desarrollo" && s.carril !== "directo") {
      if (rec.carril !== s.carril) err.push(`The analysis lane ("${s.carril}") differs from the recorded lane (${rec.carril ?? "none"}). Run \`orqen lane ${rec.key} ${s.carril}\` and write the spec`);
      else if (!rec.cambio) err.push(`The change is missing. Run \`orqen lane ${rec.key} ${s.carril}\``);
      else {
        if (s.especificacion.cambio !== rec.cambio) err.push(`especificacion.cambio must be "${rec.cambio}"`);
        const v = this.os.validar(rec.cambio);
        if (!v.ok) err.push("openspec validate --strict failed:", ...v.problemas.map((p) => "  " + p));
        if (!this.os.planificacionCompleta(rec.cambio)) err.push("The change is missing artifacts (see `openspec status --change " + rec.cambio + "`)");
        const tareas = this.os.tareas(rec.cambio);
        if (!tareas.length) err.push("tasks.md contains no tasks");
        const sinHoras = tareas.filter((t) => t.horas === undefined);
        if (sinHoras.length) err.push(`End every task with an estimate such as "(4h)". Missing estimates: ${sinHoras.map((t) => t.descripcion).join(" | ")}`);
      }
    }
    if (estado === "ANALISIS" && s.listo && s.carril === "directo" && rec.carril && rec.carril !== "directo" && rec.cambio)
      err.push(`Lane ${rec.carril} already has a change (${rec.cambio}). If the analyst selected the direct lane, run \`orqen lane ${rec.key} directo\` and leave the change unused.`);
    if (estado === "DESARROLLO" && s.completado && rec.cambio) {
      const pendientes = this.os.tareas(rec.cambio).filter((t) => !t.hecha);
      if (pendientes.length) err.push(`Unchecked tasks in tasks.md: ${pendientes.map((t) => t.descripcion).join(" | ")}`);
    }
    if (estado === "EJECUCION") {
      err.push(...revisarSql(s.script_sql ?? "", "script_sql"), ...revisarSql(s.rollback, "rollback"));
    }
    if (estado === "TESTING") {
      const reportados = new Set(s.escenarios.map((e: any) => norm(e.escenario)));
      const faltan = this.escenariosDe(rec).filter((e) => !reportados.has(norm(e.escenario)));
      if (faltan.length) err.push(`Scenarios still need coverage checks: ${faltan.map((e) => `${e.requisito} › ${e.escenario}`).join(" | ")}`);
    }
    return err;
  }

  /** Read tasks.md for spec changes or the direct lane's analysis plan. */
  private tareasDe(rec: Rec): Tarea[] {
    if (rec.cambio) return this.os.tareas(rec.cambio);
    return ((rec.artefactos.ANALISIS?.plan ?? []) as string[]).map((p) => ({ descripcion: p, hecha: false, horas: horasDe(p) }));
  }

  /** Use spec delta scenarios or direct-lane acceptance criteria as the coverage checklist. */
  private escenariosDe(rec: Rec): Escenario[] {
    if (rec.cambio) return this.os.escenarios(rec.cambio);
    return ((rec.artefactos.ANALISIS?.criterios_aceptacion ?? []) as string[])
      .map((c) => ({ capacidad: "-", requisito: "Acceptance criterion", escenario: c }));
  }

  // Close analysis
  /** Record the analysis, commit the spec when present, and link the SIS. */
  private async cerrarAnalisis(rec: Rec, s: Record<string, any>) {
    rec.artefactos.estimacion_horas = rec.cambio
      ? this.os.tareas(rec.cambio).reduce((a, t) => a + (t.horas ?? 0), 0)
      : s.estimacion_horas;
    await this.crearSis(rec);
    this.registrarAnalisis(rec, s);
    if (rec.cambio) this.ws.commit(rec.key, `spec OpenSpec ${rec.cambio}`);
  }

  private registrarAnalisis(rec: Rec, s: Record<string, any>) {
    const md = (t: string, xs: string[]) => xs.length ? `## ${t}\n\n${xs.map((x) => `- ${x}`).join("\n")}\n\n` : "";
    this.fac.escribir(rec, "analysis.json", JSON.stringify(s, null, 2) + "\n");
    this.fac.escribir(rec, "analysis.md",
      `# ${rec.key} — analysis (round ${rec.ronda})\n\n` +
      `- **Analyst:** ${rec.analista ?? "?"}\n- **Workflow:** ${s.via}\n- **Lane:** ${s.carril}\n- **Lane rationale:** ${s.justificacion_carril}\n` +
      `- **SIS:** ${rec.sis ?? "—"}\n` + (rec.cambio ? `- **OpenSpec change:** openspec/changes/${rec.cambio}/\n` : "") +
      (rec.artefactos.estimacion_horas !== undefined ? `- **Estimate:** ${rec.artefactos.estimacion_horas} h\n` : "") +
      `\n## Summary\n\n${s.resumen}\n\n` +
      md("Acceptance criteria", s.criterios_aceptacion) +
      (s.plan?.length ? `## Plan (carril directo)\n\n${s.plan.map((x: string, i: number) => `${i + 1}. ${x}`).join("\n")}\n\n` : "") +
      (s.decisiones.length ? `## Analyst decisions\n\n${s.decisiones.map((d: any) => `- **${d.pregunta}** → ${d.respuesta}`).join("\n")}\n\n` : "") +
      md("Affected capabilities", s.capacidades_afectadas) + md("Risks", s.riesgos) +
      (s.especificacion ? md("Specification assumptions", s.especificacion.supuestos) : ""));
  }

  // Publish the stage result.
  private async publicar(rec: Rec, estado: EstadoAgente, s: Record<string, any>, siguiente: Estado) {
    const k = rec.key;
    switch (estado) {
      case "ANALISIS": {
        let t = `*Analysis*${rec.analista ? ` (analyst: ${rec.analista})` : ""}\n${s.resumen}\n\n*Type:* ${s.tipo}\n\n*Acceptance criteria:*\n${lista(s.criterios_aceptacion)}`;
        if (s.riesgos.length) t += `\n\n*Risks:*\n${lista(s.riesgos)}`;
        if (s.listo) {
          t += `\n\n*Lane:* ${s.via === "operativa" ? "operational (no code changes)" : s.carril} — ${s.justificacion_carril}`;
          if (rec.cambio) {
            const esc = this.os.escenarios(rec.cambio);
            t += `\n*Spec:* OpenSpec change \`${rec.cambio}\` (branch \`${rec.rama}\`), ${esc.length} scenario(s), ${rec.artefactos.estimacion_horas} estimated hours.`;
          } else if (s.via === "desarrollo") t += `\n*Plan:*\n${lista(s.plan ?? [], true)}` + (s.estimacion_horas !== undefined ? `\n*Estimate:* ${s.estimacion_horas} h` : "");
          t += `\n*SIS:* ${rec.sis}`;
        }
        if (siguiente === "ESPERA_CLIENTE") t += `\n\n*Please confirm the following so we can specify the request:*\n${lista(s.preguntas_abiertas, true)}`;
        if (siguiente === "BLOQUEADO") t += "\n\nThe request reached the customer question limit and needs human review.";
        return this.jira.comentar(k, t);
      }
      case "DESARROLLO":
        if (s.completado) {
          this.ws.commit(k, s.resumen_cambios.slice(0, 200));
          return this.comentarConSis(rec, `Development complete on branch \`${rec.rama}\`.\n${s.resumen_cambios}\n\nTests added:\n${lista(s.tests_agregados)}\nMoving to testing.`);
        }
        return this.comentarConSis(rec, `Development could not be completed: ${s.bloqueo}`);
      case "TESTING": {
        const rt = rec.artefactos.resultado_tests;
        const tabla = s.escenarios.map((e: any) => `- ${e.cubierto ? "✔" : "✘"} ${e.requisito} › ${e.escenario}${e.test ? ` (${e.test})` : ""}`).join("\n");
        if (s.aprobado) {
          if (!rec.artefactos.pr) {
            this.intentar(() => this.ws.push(rec.rama));
            rec.artefactos.pr = this.intentar(() => this.ws.abrirPr({
              key: k, rama: rec.rama, cambio: rec.cambio, cambio_dir: rec.cambio ? `openspec/changes/${rec.cambio}` : this.workPath(rec),
              cuerpo: rec.cambio ? `openspec/changes/${rec.cambio}/proposal.md` : this.workPath(rec, "analysis.md"),
              titulo: rec.artefactos.ANALISIS?.resumen?.slice(0, 80) ?? rec.cambio,
            })) ?? "";
          }
          return this.comentarConSis(rec, `Tests passed and all scenarios are covered:\n${tabla}\n\nPR: ${rec.artefactos.pr || rec.rama}\nCode review: comment */approve* or */reject <reason>*.`);
        }
        return this.comentarConSis(rec, `Testing failed (attempt ${rec.intentosTesting}). Suite: ${rt?.ok ? "OK" : "FAILED"}\n${tabla}\n\nDiagnosis: ${s.diagnostico_fallas}` +
          (siguiente === "BLOQUEADO" ? "\nRetries are exhausted. Human review is needed." : "\nReturning to development."));
      }
      case "EJECUCION": {
        this.fac.escribir(rec, "execution/summary.md", `# Operational proposal\n\n${s.resumen}\n\n- System: ${s.sistema}\n- Impact: ${s.impacto}\n`);
        if (s.script_sql) this.fac.escribir(rec, "execution/script.sql", s.script_sql);
        if (s.pasos_manuales?.length) this.fac.escribir(rec, "execution/steps.md", lista(s.pasos_manuales, true));
        this.fac.escribir(rec, "execution/rollback.txt", s.rollback);
        this.fac.escribir(rec, "execution/verification.txt", s.verificacion);
        const t = `*Operational proposal (no code changes)*\n${s.resumen}\n\n*System:* ${s.sistema}\n*Impact:* ${s.impacto}` +
          (s.filas_estimadas !== undefined ? `\n*Estimated rows:* ${s.filas_estimadas}` : "") +
          (s.script_sql ? `\n\n*Script SQL:*\n{code:sql}\n${s.script_sql}\n{code}` : "") +
          (s.pasos_manuales?.length ? `\n\n*Manual steps:*\n${lista(s.pasos_manuales, true)}` : "") +
          `\n\n*Rollback:*\n{code}\n${s.rollback}\n{code}\n\n*Verification:*\n{code}\n${s.verificacion}\n{code}` +
          (s.riesgos.length ? `\n\n*Risks:*\n${lista(s.riesgos)}` : "") +
          `\n\nTo authorize the change, comment */approve*. To request revisions, comment */reject <reason>*.`;
        return this.comentarConSis(rec, t);
      }
      case "VERIFICACION": {
        const t = `*Verification*\n${s.evidencia}\n\n`;
        if (siguiente === "CONFORMIDAD")
          return this.comentarConSis(rec, t + `${s.mensaje_cliente}\n\n*How to verify:*\n${lista(s.pasos_validacion, true)}\n\n` +
            `To accept the result, comment */approve*. To report a problem, comment */reject <reason>*.`);
        if (siguiente === "ANALISIS")
          return this.jira.comentar(k, t + "Verification shows that a code change is required. Returning to analysis so the analyst can choose a development lane.");
        return this.jira.comentar(k, t + (siguiente === "BLOQUEADO"
          ? "The issue persists and retries are exhausted. Human review is needed."
          : "The issue persists. Returning to operational preparation."));
      }
      case "ENTREGA":
        return this.jira.comentar(k, `${s.mensaje_cliente}\n\n*How to verify:*\n${lista(s.pasos_validacion, true)}\n\n` +
          `To accept the result, comment */approve*. To report a problem, comment */reject <reason>*.`);
    }
  }

  // Human approval gates
  private async nuevosHumanos(rec: Rec): Promise<Comentario[]> {
    const cs = await this.jira.comentarios(rec.key);
    const i = cs.findIndex((c) => c.id === rec.ultimoComentarioVisto);
    if (cs.length) rec.ultimoComentarioVisto = cs[cs.length - 1].id;
    return cs.slice(i + 1).filter((c) => !c.cuerpo.startsWith(BOT_MARCA));
  }

  private aprobadores(e: Estado): string[] {
    const a = this.cfg.aprobadores;
    return ({ REVISION_CODIGO: a.codigo, CONFORMIDAD: a.cliente, APROBACION_EJECUCION: a.ejecucion ?? [], APLICACION: a.ejecucion ?? [], BLOQUEADO: [...(a.analisis ?? []), ...a.codigo] } as Record<string, string[]>)[e] ?? [];
  }

  private async revisarGate(rec: Rec & { estado: keyof typeof GATES }) {
    const gate = GATES[rec.estado];
    const nuevos = await this.nuevosHumanos(rec);
    if (gate.tipo === "respuesta") {
      if (nuevos.length) {
        rec.feedback.push(...nuevos.map((c) => ({ de: c.autorNombre, texto: c.cuerpo })));
        return this.mover(rec, gate.aprobar, "Customer reply");
      }
      return this.store.save(rec);
    }
    const autorizados = this.aprobadores(rec.estado);
    for (const c of nuevos) {
      const m = c.cuerpo.match(CMD);
      if (!m) { rec.feedback.push({ de: c.autorNombre, texto: c.cuerpo }); continue; }
      if (autorizados.length && !autorizados.includes(c.autor)) {
        await this.jira.comentar(rec.key, `${c.autorNombre}: you are not authorized to use /${m[1]} at this stage.`);
        continue;
      }
      const accion = accionDe(m[1]), motivo = m[2].trim();
      if (accion === "rechazar") rec.feedback.push({ de: c.autorNombre, rechazo: motivo });
      if (accion === "aprobar" && motivo && rec.estado === "APLICACION")
        rec.feedback.push({ de: c.autorNombre, texto: motivo });  // application result
      if (rec.estado === "REVISION_CODIGO" && accion === "rechazar") rec.intentosTesting = 0;
      if (rec.estado === "APROBACION_EJECUCION" && accion === "aprobar")
        await this.jira.comentar(rec.key, "Operational change approved. Apply the proposal as written and comment */approve <result>* on success or */reject <reason>* on failure.");
      if (rec.estado === "CONFORMIDAD" && accion === "rechazar") {
        // Start a new round with a new lane, change, and SIS.
        rec.ronda++; rec.cambio = ""; rec.rondasPreguntas = 0; rec.intentosTesting = 0; delete rec.carril;
        delete rec.artefactos.archivo; delete rec.artefactos.pr; delete rec.artefactos.sis_vinculado;
        if (rec.sis) { (rec.artefactos.sis_previos ??= []).push(rec.sis); delete rec.sis; }  // The new round gets its own SIS.
      }
      return this.mover(rec, gate[accion], `/${accion === "aprobar" ? "approve" : "reject"} by ${c.autorNombre} ${motivo}`.trim());
    }
    this.store.save(rec);
  }

  private async revisarDesbloqueo(rec: Rec) {
    const autorizados = this.aprobadores("BLOQUEADO");
    for (const c of await this.nuevosHumanos(rec)) {
      const m = c.cuerpo.match(CMD);
      if (m && accionDe(m[1]) === "aprobar" && (!autorizados.length || autorizados.includes(c.autor))) {
        rec.intentosTesting = 0; rec.rondasPreguntas = 0;
        if (m[2].trim()) rec.feedback.push({ de: c.autorNombre, texto: m[2].trim() });
        return this.mover(rec, rec.estadoPrevioBloqueo ?? "ANALISIS", `Unblocked by ${c.autorNombre}`);
      }
      rec.feedback.push({ de: c.autorNombre, texto: c.cuerpo });
    }
    this.store.save(rec);
  }

  // ================================================================ SIS
  /**
   * Closing analysis creates and links the SIS and posts on both Jira issues.
   * Repeating completion resumes after partial failures without creating a duplicate SIS.
   */
  private async crearSis(rec: Rec) {
    const a = rec.artefactos.ANALISIS ?? {};
    const operativo = rec.via === "operativa";
    if (!rec.sis) {
      const issue = await this.jira.issue(rec.key);
      const tareas = operativo ? [] : this.tareasDe(rec);
      const esc = operativo ? [] : this.escenariosDe(rec);
      const sis = await this.jira.crearIssue({
        proyecto: this.cfg.sis.proyecto, tipo: operativo ? this.cfg.sis.tipoOperativo : this.cfg.sis.tipo,
        titulo: `[${rec.key}] ${issue.titulo}`, labels: [`origen-${rec.key.toLowerCase()}`, `carril-${operativo ? "operativo" : a.carril}`],
        descripcion: operativo
          ? `Operational resolution for request ${rec.key} (no code changes).\n\n*Summary:* ${a.resumen}\n*Rationale:* ${a.justificacion_carril}\n\n` +
            `*Acceptance criteria:*\n${lista(a.criterios_aceptacion ?? [])}\n\nThe EJECUCION stage proposes the script, rollback, and verification and posts them on the request.`
          : `Development for request ${rec.key}. *Lane:* ${a.carril} — ${a.justificacion_carril}\n\n` +
            `*Summary:* ${rec.artefactos.ANALISIS?.especificacion?.resumen ?? a.resumen}\n\n` +
            `*Branch:* rec/${rec.key.toLowerCase()}\n` + (rec.cambio ? `*OpenSpec change:* openspec/changes/${rec.cambio}/\n` : `*Direct-lane analysis:* ${this.workPath(rec, "analysis.md")}\n`) +
            `*Estimate:* ${rec.artefactos.estimacion_horas ?? "?"} h\n\n` +
            `*${rec.cambio ? "Tasks" : "Plan"}:*\n${lista(tareas.map((t) => t.descripcion))}\n\n` +
            `*${rec.cambio ? "Acceptance scenarios" : "Acceptance criteria"}:*\n${lista(esc.map((e) => rec.cambio ? `${e.requisito} › ${e.escenario}` : e.escenario))}`,
      });
      rec.sis = sis;
      this.store.save(rec);
    }
    if (!rec.artefactos.sis_vinculado) {
      await this.jira.vincular(rec.sis, rec.key, this.cfg.sis.link);
      await this.jira.comentar(rec.key, `Analysis complete${rec.analista ? ` with ${rec.analista}` : ""}. Track implementation in ${rec.sis} (${operativo ? "operational" : a.carril} lane). Milestones will also be posted on this request.`);
      await this.jira.comentar(rec.sis, `Created from ${rec.key} after analysis. Request record: orqen/work/${rec.key}/.`);
      rec.artefactos.sis_vinculado = true;
      this.store.save(rec);
    }
  }

  /** Post on the request and mirror the comment to its SIS when present. */
  private async comentarConSis(rec: Rec, texto: string) {
    await this.jira.comentar(rec.key, texto);
    if (rec.sis) await this.intentarAsync(() => this.jira.comentar(rec.sis!, texto));
  }

  // Utilities
  async bloquear(key: string, motivo: string, agente = "agente") {
    const rec = this.store.get(key) ?? recNuevo(key);
    if (rec.estado === "BLOQUEADO") return;
    await this.jira.comentar(key, `Human intervention needed: ${motivo}\nWhen resolved, comment /approve <instructions> to retry.`);
    await this.mover(rec, "BLOQUEADO", motivo, agente);
  }

  liberar(key: string) {
    const rec = this.store.get(key);
    if (rec) { delete rec.lock; this.store.save(rec); }
  }

  private lockVigente(rec: Rec) {
    if (!rec.lock) return undefined;
    const vencido = Date.now() - Date.parse(rec.lock.desde) > this.cfg.lockMinutos * 60_000;
    return vencido ? undefined : rec.lock;
  }

  private async intentarAsync(fn: () => Promise<unknown>) {
    try { await fn(); } catch (e) { console.error(`[orqen] warning: ${(e as Error).message}`); }
  }

  private intentar<T>(fn: () => T): T | undefined {
    try { return fn(); } catch (e) { console.error(`[orqen] warning: ${(e as Error).message}`); return undefined; }
  }

  private async mover(rec: Rec, hacia: Estado, detalle: string, agente?: string) {
    const desde = rec.estado;
    if (hacia === "BLOQUEADO" && desde !== "BLOQUEADO") rec.estadoPrevioBloqueo = desde;
    rec.estado = hacia;
    delete rec.lock;
    if (esGate(hacia) || hacia === "BLOQUEADO") {  // al entrar a un gate, ignorar comentarios anteriores
      const cs = await this.jira.comentarios(rec.key);
      rec.ultimoComentarioVisto = cs.at(-1)?.id ?? "";
    }
    this.store.save(rec);
    if (desde === "DESARROLLO" && hacia !== "DESARROLLO") this.intentar(() => this.ws.bajarEntorno?.());   // al salir de DESARROLLO se baja el entorno
    this.store.log(rec.key, { ts: new Date().toISOString(), desde, hacia, detalle, agente });
    this.fac.registrar(rec, desde, hacia, detalle, agente);
    if (rec.rama) this.intentar(() => this.ws.commit(rec.key, `Record ${desde} → ${hacia}`, { ruta: this.cfg.factoryDir, rama: rec.rama }));
    try {
      await this.jira.setLabelEstado(rec.key, hacia);
      const t = this.cfg.transicionesJira[hacia];
      if (t) await this.jira.transicionar(rec.key, t);
      if (rec.sis) {
        const ts = this.cfg.sis.transiciones[hacia];
        if (ts) await this.jira.transicionar(rec.sis, ts);
      }
    } catch (e) {
      console.error(`[orqen] could not update the Jira label or transition: ${(e as Error).message}`);
    }
  }
}

export function nombreCambio(key: string, titulo: string, ronda: number) {
  const slug = titulo.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter((w) => w.length > 2).slice(0, 4).join("-");
  return [key.toLowerCase(), slug, ronda > 1 ? `r${ronda}` : ""].filter(Boolean).join("-");
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
const lista = (xs: string[], num = false) => xs.map((x) => `${num ? "#" : "*"} ${x}`).join("\n") || "_(none)_";
