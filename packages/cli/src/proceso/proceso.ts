/**
 * Núcleo del proceso REC. Lo usan la CLI (`orqen ...`) y los tests.
 *
 *  - revisar():   avanza todo lo que NO necesita agente (gates, desbloqueos) y lista el trabajo pendiente.
 *  - analizar():  abre el análisis conducido por un analista (grilling) y devuelve el contexto.
 *  - carril():    registra el carril elegido; para liviano/completo crea rama + change de OpenSpec.
 *  - tomar():     reserva un REC en una etapa de agente, prepara rama/tests/OpenSpec y devuelve el contexto.
 *  - completar(): valida la salida (esquema + OpenSpec), publica en Jira/git/factory y mueve el estado.
 *                 Al cerrar el ANALISIS con el OK del analista crea el SIS y lo vincula al REC.
 */
import type { Config } from "./config.ts";
import { ESQUEMAS } from "./esquemas.ts";
import {
  CARRILES, type Carril, type Estado, type EstadoAgente, GATES, esEstadoAgente, esGate, siguienteTrasEtapa,
} from "./estados.ts";
import { Factory } from "./factory.ts";
import { BOT_MARCA, type Comentario, type JiraApi } from "./jira.ts";
import { type Escenario, type OpenSpecApi, type Tarea, horasDe } from "./openspec.ts";
import { revisarSql } from "./sql.ts";
import { type Rec, Store, recNuevo } from "./store.ts";
import type { EstadoEntorno, Workspace } from "./workspace.ts";

/** Comandos en comentarios de Jira: /approve y /reject (se aceptan también /aprobar y /rechazar). */
const CMD = /^\s*\/(approve|reject|aprobar|rechazar)\b\s*([\s\S]*)/i;
const accionDe = (palabra: string) => (/^(approve|aprobar)$/i.test(palabra) ? "aprobar" : "rechazar");

/** `para` indica quién tiene que actuar: el analista (NUEVO/ANALISIS) o un agente desatendido. */
export interface Pendiente { key: string; estado: EstadoAgente | "NUEVO"; para: "analista" | "agente"; tomadoPor?: string }
export type ResultadoCompletar = { ok: true; siguiente: Estado } | { ok: false; errores: string[] };

export class Proceso {
  private fac: Factory;
  constructor(
    private cfg: Config, private jira: JiraApi, private store: Store,
    private ws: Workspace, private os: OpenSpecApi,
  ) { this.fac = new Factory(cfg.factoryDir); }

  // ================================================================ revisar
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
        await this.bloquear(key, `Error revisando el REC: ${(e as Error).message}`, "proceso");
      }
    }
    return pendientes;
  }

  // ================================================================ analizar
  /** Abre (o retoma) el análisis de un REC. Lo conduce un analista; el agente hace el grilling con él. */
  async analizar(key: string, agente = "agente", analista = agente) {
    const rec = this.store.get(key) ?? recNuevo(key);
    if (rec.estado === "ESPERA_CLIENTE")
      throw new Error(`${key} está esperando respuestas del cliente en Jira. Cuando respondan vuelve a ANALISIS (\`orqen pending\`).`);
    if (rec.estado !== "NUEVO" && rec.estado !== "ANALISIS")
      throw new Error(`${key} ya pasó el análisis (estado: ${rec.estado}). Si hay que rehacerlo, el rechazo o la escalada lo devuelven a ANALISIS.`);
    if (rec.estado === "NUEVO") {
      rec.analista = analista;
      await this.jira.comentar(key, `${analista} inició el análisis de este REC.`);
      await this.mover(rec, "ANALISIS", "alta por analista", agente);
    }
    rec.analista = analista;
    this.store.save(rec);
    return this.tomar(key, agente, true);
  }

  /** Registra el carril. Liviano/completo: prepara rama + change de OpenSpec para que el agente escriba la spec. */
  async carril(key: string, carril: string, agente = "agente") {
    const rec = this.store.get(key);
    if (!rec || rec.estado !== "ANALISIS") throw new Error(`${key} no está en ANALISIS (estado: ${rec?.estado ?? "desconocido"}).`);
    const lock = this.lockVigente(rec) ?? (rec.lock?.agente === agente ? rec.lock : undefined);
    if (!lock || lock.agente !== agente) throw new Error(`Primero corré \`orqen analyze ${key}\``);
    if (!CARRILES.includes(carril as Carril)) throw new Error(`Carril inválido "${carril}". Opciones: ${CARRILES.join(", ")}`);
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

  // ================================================================ tomar
  async tomar(key: string, agente = "agente", desdeAnalizar = false) {
    const rec = this.store.get(key);
    if (!rec || !esEstadoAgente(rec.estado))
      throw new Error(`${key} no tiene trabajo para el agente (estado: ${rec?.estado ?? "desconocido"}). Corré \`orqen pending\`.`);
    if (rec.estado === "ANALISIS" && !desdeAnalizar)
      throw new Error(`El análisis de ${key} lo conduce un analista: usá /orqen:analyze ${key} (o \`orqen analyze ${key}\`).`);
    const lock = this.lockVigente(rec);
    if (lock && lock.agente !== agente) throw new Error(`${key} ya lo tomó "${lock.agente}" desde ${lock.desde}.`);
    rec.lock = { agente, desde: new Date().toISOString() };
    this.store.save(rec);

    const issue = await this.jira.issue(key);
    const estado = rec.estado;

    // ANALISIS (liviano/completo la crea `orqen lane`) y el carril rápido (EJECUCION/VERIFICACION) no preparan rama acá
    if (["DESARROLLO", "TESTING", "ENTREGA"].includes(estado)) rec.rama = this.ws.prepararRama(key);
    // Entornos (orqen/config.yaml): el proceso los levanta solo, sin que nadie abra una terminal.
    //  - DESARROLLO: dependencias + servicios (DB, colas...) + migraciones, para que el agente pueda correr tests mientras implementa.
    //  - TESTING: además las apps (e2e / visual); corre toda la suite y baja el entorno.
    let entorno: EstadoEntorno | undefined;
    if (estado === "DESARROLLO") entorno = this.ws.levantarEntorno?.(false);
    if (estado === "TESTING") {
      entorno = this.ws.levantarEntorno?.(true);
      rec.artefactos.resultado_tests = this.ws.correrTests();
      this.intentar(() => this.ws.bajarEntorno?.());
    }
    if (estado === "ENTREGA" && rec.cambio && !rec.artefactos.archivo) {
      rec.artefactos.archivo = this.os.archivar(rec.cambio);
      this.ws.commit(key, `archiva change OpenSpec ${rec.cambio}`);
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
        analista: rec.analista, carril: rec.carril, factory: `orqen/work/${key}/ronda-${rec.ronda}`,
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

  // ================================================================ completar
  async completar(key: string, bruto: unknown, agente = "agente"): Promise<ResultadoCompletar> {
    const rec = this.store.get(key);
    if (!rec || !esEstadoAgente(rec.estado)) return { ok: false, errores: [`${key} no está en una etapa de agente`] };
    // un lock vencido sigue siendo válido mientras nadie más haya tomado el REC (el grilling puede durar más que REC_LOCK_MIN)
    const lock = this.lockVigente(rec) ?? (rec.lock?.agente === agente ? rec.lock : undefined);
    if (!lock) return { ok: false, errores: [`Primero corré \`orqen ${rec.estado === "ANALISIS" ? "analizar" : "tomar"} ${key}\``] };
    if (lock.agente !== agente) return { ok: false, errores: [`${key} lo tiene tomado "${lock.agente}"`] };

    const estado = rec.estado;
    const parsed = ESQUEMAS[estado].safeParse(bruto);
    if (!parsed.success)
      return { ok: false, errores: parsed.error.issues.map((i) => `${i.path.join(".") || "(raíz)"}: ${i.message}`) };
    const s: Record<string, any> = parsed.data;

    // --- validaciones contra OpenSpec / repo (el agente corrige y vuelve a completar)
    const errores = this.validarContraOpenSpec(rec, estado, s);
    if (errores.length) return { ok: false, errores };

    // --- contadores y decisión
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
    if (estado === "VERIFICACION" && siguiente === "ANALISIS") {  // escalada: el análisis nuevo crea un SIS de desarrollo
      rec.via = "desarrollo"; delete rec.carril; delete rec.artefactos.sis_vinculado;
      if (rec.sis) { (rec.artefactos.sis_previos ??= []).push(rec.sis); delete rec.sis; }
    }
    if (estado === "VERIFICACION" && siguiente !== "EJECUCION") rec.intentosTesting = 0;

    if (estado === "ANALISIS" && s.listo) await this.cerrarAnalisis(rec, s);
    await this.publicar(rec, estado, s, siguiente);
    rec.feedback = [];
    await this.mover(rec, siguiente, `etapa ${estado} completada`, agente);
    return { ok: true, siguiente };
  }

  private validarContraOpenSpec(rec: Rec, estado: EstadoAgente, s: Record<string, any>): string[] {
    const err: string[] = [];
    if (estado === "ANALISIS" && s.listo && s.via === "desarrollo" && s.carril !== "directo") {
      if (rec.carril !== s.carril) err.push(`El carril del análisis ("${s.carril}") no coincide con el registrado (${rec.carril ?? "ninguno"}): corré \`orqen lane ${rec.key} ${s.carril}\` y escribí la spec`);
      else if (!rec.cambio) err.push(`Falta el change: corré \`orqen lane ${rec.key} ${s.carril}\``);
      else {
        if (s.especificacion.cambio !== rec.cambio) err.push(`especificacion.cambio debe ser "${rec.cambio}"`);
        const v = this.os.validar(rec.cambio);
        if (!v.ok) err.push("openspec validate --strict falló:", ...v.problemas.map((p) => "  " + p));
        if (!this.os.planificacionCompleta(rec.cambio)) err.push("Faltan artefactos del change (ver `openspec status --change " + rec.cambio + "`)");
        const tareas = this.os.tareas(rec.cambio);
        if (!tareas.length) err.push("tasks.md no tiene tareas");
        const sinHoras = tareas.filter((t) => t.horas === undefined);
        if (sinHoras.length) err.push(`Cada tarea debe terminar con su estimación, ej. "(4h)". Sin estimar: ${sinHoras.map((t) => t.descripcion).join(" | ")}`);
      }
    }
    if (estado === "ANALISIS" && s.listo && s.carril === "directo" && rec.carril && rec.carril !== "directo" && rec.cambio)
      err.push(`Registraste el carril ${rec.carril} y ya hay un change (${rec.cambio}); elegí uno u otro (si cambió la decisión corré \`orqen lane ${rec.key} directo\` y no uses el change).`);
    if (estado === "DESARROLLO" && s.completado && rec.cambio) {
      const pendientes = this.os.tareas(rec.cambio).filter((t) => !t.hecha);
      if (pendientes.length) err.push(`Quedan tareas sin tildar en tasks.md: ${pendientes.map((t) => t.descripcion).join(" | ")}`);
    }
    if (estado === "EJECUCION") {
      err.push(...revisarSql(s.script_sql ?? "", "script_sql"), ...revisarSql(s.rollback, "rollback"));
    }
    if (estado === "TESTING") {
      const reportados = new Set(s.escenarios.map((e: any) => norm(e.escenario)));
      const faltan = this.escenariosDe(rec).filter((e) => !reportados.has(norm(e.escenario)));
      if (faltan.length) err.push(`Faltan evaluar escenarios: ${faltan.map((e) => `${e.requisito} › ${e.escenario}`).join(" | ")}`);
    }
    return err;
  }

  /** Tareas del REC: las de tasks.md (liviano/completo) o el plan del análisis (directo). */
  private tareasDe(rec: Rec): Tarea[] {
    if (rec.cambio) return this.os.tareas(rec.cambio);
    return ((rec.artefactos.ANALISIS?.plan ?? []) as string[]).map((p) => ({ descripcion: p, hecha: false, horas: horasDe(p) }));
  }

  /** Lo que testing debe cubrir: Scenarios de los spec deltas, o los criterios de aceptación en el carril directo. */
  private escenariosDe(rec: Rec): Escenario[] {
    if (rec.cambio) return this.os.escenarios(rec.cambio);
    return ((rec.artefactos.ANALISIS?.criterios_aceptacion ?? []) as string[])
      .map((c) => ({ capacidad: "-", requisito: "Criterio de aceptación", escenario: c }));
  }

  // ================================================================ cierre del análisis
  /** Con el OK del analista: estimación, registro en factory/, commit de la spec (si hay) y SIS vinculado al REC. */
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
    this.fac.escribir(rec, "analisis.json", JSON.stringify(s, null, 2) + "\n");
    this.fac.escribir(rec, "analisis.md",
      `# ${rec.key} — análisis (ronda ${rec.ronda})\n\n` +
      `- **Analista:** ${rec.analista ?? "?"}\n- **Vía:** ${s.via}\n- **Carril:** ${s.carril}\n- **Justificación del carril:** ${s.justificacion_carril}\n` +
      `- **SIS:** ${rec.sis ?? "—"}\n` + (rec.cambio ? `- **OpenSpec change:** openspec/changes/${rec.cambio}/\n` : "") +
      (rec.artefactos.estimacion_horas !== undefined ? `- **Estimación:** ${rec.artefactos.estimacion_horas} h\n` : "") +
      `\n## Resumen\n\n${s.resumen}\n\n` +
      md("Criterios de aceptación", s.criterios_aceptacion) +
      (s.plan?.length ? `## Plan (carril directo)\n\n${s.plan.map((x: string, i: number) => `${i + 1}. ${x}`).join("\n")}\n\n` : "") +
      (s.decisiones.length ? `## Decisiones del grilling\n\n${s.decisiones.map((d: any) => `- **${d.pregunta}** → ${d.respuesta}`).join("\n")}\n\n` : "") +
      md("Capacidades afectadas", s.capacidades_afectadas) + md("Riesgos", s.riesgos) +
      (s.especificacion ? md("Supuestos de la spec", s.especificacion.supuestos) : ""));
  }

  // ================================================================ publicar
  private async publicar(rec: Rec, estado: EstadoAgente, s: Record<string, any>, siguiente: Estado) {
    const k = rec.key;
    switch (estado) {
      case "ANALISIS": {
        let t = `*Análisis*${rec.analista ? ` (analista: ${rec.analista})` : ""}\n${s.resumen}\n\n*Tipo:* ${s.tipo}\n\n*Criterios de aceptación:*\n${lista(s.criterios_aceptacion)}`;
        if (s.riesgos.length) t += `\n\n*Riesgos:*\n${lista(s.riesgos)}`;
        if (s.listo) {
          t += `\n\n*Carril:* ${s.via === "operativa" ? "operativo (sin código)" : s.carril} — ${s.justificacion_carril}`;
          if (rec.cambio) {
            const esc = this.os.escenarios(rec.cambio);
            t += `\n*Spec:* OpenSpec change \`${rec.cambio}\` (rama \`${rec.rama}\`), ${esc.length} escenario(s), ${rec.artefactos.estimacion_horas} h estimadas.`;
          } else if (s.via === "desarrollo") t += `\n*Plan:*\n${lista(s.plan ?? [], true)}` + (s.estimacion_horas !== undefined ? `\n*Estimación:* ${s.estimacion_horas} h` : "");
          t += `\n*SIS:* ${rec.sis}`;
        }
        if (siguiente === "ESPERA_CLIENTE") t += `\n\n*Necesito que me confirmes lo siguiente para poder especificar:*\n${lista(s.preguntas_abiertas, true)}`;
        if (siguiente === "BLOQUEADO") t += "\n\nSe agotaron las rondas de preguntas; derivo a una persona del equipo.";
        return this.jira.comentar(k, t);
      }
      case "DESARROLLO":
        if (s.completado) {
          this.ws.commit(k, s.resumen_cambios.slice(0, 200));
          return this.comentarConSis(rec, `Desarrollo listo en la rama \`${rec.rama}\`.\n${s.resumen_cambios}\n\nTests agregados:\n${lista(s.tests_agregados)}\nPaso a testing.`);
        }
        return this.comentarConSis(rec, `No pude completar el desarrollo: ${s.bloqueo}`);
      case "TESTING": {
        const rt = rec.artefactos.resultado_tests;
        const tabla = s.escenarios.map((e: any) => `- ${e.cubierto ? "✔" : "✘"} ${e.requisito} › ${e.escenario}${e.test ? ` (${e.test})` : ""}`).join("\n");
        if (s.aprobado) {
          if (!rec.artefactos.pr) {
            this.intentar(() => this.ws.push(rec.rama));
            rec.artefactos.pr = this.intentar(() => this.ws.abrirPr({
              key: k, rama: rec.rama, cambio: rec.cambio, cambio_dir: rec.cambio ? `openspec/changes/${rec.cambio}` : `orqen/work/${k}/ronda-${rec.ronda}`,
              cuerpo: rec.cambio ? `openspec/changes/${rec.cambio}/proposal.md` : `orqen/work/${k}/ronda-${rec.ronda}/analisis.md`,
              titulo: rec.artefactos.ANALISIS?.resumen?.slice(0, 80) ?? rec.cambio,
            })) ?? "";
          }
          return this.comentarConSis(rec, `Tests OK y todos los escenarios cubiertos:\n${tabla}\n\nPR: ${rec.artefactos.pr || rec.rama}\nRevisión de código: comentá */approve* o */reject <motivo>*.`);
        }
        return this.comentarConSis(rec, `Testing no aprobado (intento ${rec.intentosTesting}). Suite: ${rt?.ok ? "OK" : "FALLA"}\n${tabla}\n\nDiagnóstico: ${s.diagnostico_fallas}` +
          (siguiente === "BLOQUEADO" ? "\nSe agotaron los intentos; derivo a una persona." : "\nVuelvo a desarrollo."));
      }
      case "EJECUCION": {
        this.fac.escribir(rec, "ejecucion/resumen.md", `# Propuesta operativa\n\n${s.resumen}\n\n- Sistema: ${s.sistema}\n- Impacto: ${s.impacto}\n`);
        if (s.script_sql) this.fac.escribir(rec, "ejecucion/script.sql", s.script_sql);
        if (s.pasos_manuales?.length) this.fac.escribir(rec, "ejecucion/pasos.md", lista(s.pasos_manuales, true));
        this.fac.escribir(rec, "ejecucion/rollback.txt", s.rollback);
        this.fac.escribir(rec, "ejecucion/verificacion.txt", s.verificacion);
        const t = `*Propuesta operativa (carril rápido, sin desarrollo)*\n${s.resumen}\n\n*Sistema:* ${s.sistema}\n*Impacto:* ${s.impacto}` +
          (s.filas_estimadas !== undefined ? `\n*Filas estimadas:* ${s.filas_estimadas}` : "") +
          (s.script_sql ? `\n\n*Script SQL:*\n{code:sql}\n${s.script_sql}\n{code}` : "") +
          (s.pasos_manuales?.length ? `\n\n*Pasos manuales:*\n${lista(s.pasos_manuales, true)}` : "") +
          `\n\n*Rollback:*\n{code}\n${s.rollback}\n{code}\n\n*Verificación:*\n{code}\n${s.verificacion}\n{code}` +
          (s.riesgos.length ? `\n\n*Riesgos:*\n${lista(s.riesgos)}` : "") +
          `\n\nPara autorizar la ejecución comentá */approve*, o */reject <motivo>* para que lo rehaga.`;
        return this.comentarConSis(rec, t);
      }
      case "VERIFICACION": {
        const t = `*Verificación*\n${s.evidencia}\n\n`;
        if (siguiente === "CONFORMIDAD")
          return this.comentarConSis(rec, t + `${s.mensaje_cliente}\n\n*Cómo validarlo:*\n${lista(s.pasos_validacion, true)}\n\n` +
            `Para dar conformidad comentá */approve*, o */reject <motivo>* si algo no está bien.`);
        if (siguiente === "ANALISIS")
          return this.jira.comentar(k, t + "Se comprobó que la causa requiere un cambio de código: vuelve a análisis para que el analista elija el carril de desarrollo.");
        return this.jira.comentar(k, t + (siguiente === "BLOQUEADO"
          ? "No quedó resuelto y se agotaron los intentos; derivo a una persona."
          : "No quedó resuelto; preparo una nueva propuesta."));
      }
      case "ENTREGA":
        return this.jira.comentar(k, `${s.mensaje_cliente}\n\n*Cómo validarlo:*\n${lista(s.pasos_validacion, true)}\n\n` +
          `Para dar conformidad comentá */approve*, o */reject <motivo>* si algo no está bien.`);
    }
  }

  // ================================================================ gates
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
        return this.mover(rec, gate.aprobar, "respuesta del cliente");
      }
      return this.store.save(rec);
    }
    const autorizados = this.aprobadores(rec.estado);
    for (const c of nuevos) {
      const m = c.cuerpo.match(CMD);
      if (!m) { rec.feedback.push({ de: c.autorNombre, texto: c.cuerpo }); continue; }
      if (autorizados.length && !autorizados.includes(c.autor)) {
        await this.jira.comentar(rec.key, `${c.autorNombre}: no estás habilitado para /${m[1]} en esta etapa.`);
        continue;
      }
      const accion = accionDe(m[1]), motivo = m[2].trim();
      if (accion === "rechazar") rec.feedback.push({ de: c.autorNombre, rechazo: motivo });
      if (accion === "aprobar" && motivo && rec.estado === "APLICACION")
        rec.feedback.push({ de: c.autorNombre, texto: motivo });  // resultado de la aplicación
      if (rec.estado === "REVISION_CODIGO" && accion === "rechazar") rec.intentosTesting = 0;
      if (rec.estado === "APROBACION_EJECUCION" && accion === "aprobar")
        await this.jira.comentar(rec.key, "Ejecución autorizada. Quien lo aplique, que lo haga tal como está propuesto y comente */approve <resultado>* si salió bien, o */reject <motivo>* si falló.");
      if (rec.estado === "CONFORMIDAD" && accion === "rechazar") {
        // nueva ronda: el change anterior ya está archivado → el analista re-analiza (nuevo carril, change y SIS)
        rec.ronda++; rec.cambio = ""; rec.rondasPreguntas = 0; rec.intentosTesting = 0; delete rec.carril;
        delete rec.artefactos.archivo; delete rec.artefactos.pr; delete rec.artefactos.sis_vinculado;
        if (rec.sis) { (rec.artefactos.sis_previos ??= []).push(rec.sis); delete rec.sis; }  // la ronda nueva tendrá su propio SIS
      }
      return this.mover(rec, gate[accion], `/${accion} por ${c.autorNombre} ${motivo}`.trim());
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
        return this.mover(rec, rec.estadoPrevioBloqueo ?? "ANALISIS", `desbloqueado por ${c.autorNombre}`);
      }
      rec.feedback.push({ de: c.autorNombre, texto: c.cuerpo });
    }
    this.store.save(rec);
  }

  // ================================================================ SIS
  /**
   * Al cerrar el análisis: crea el SIS (otro proyecto de Jira), lo vincula al REC y avisa en ambos.
   * Idempotente y reanudable: si falla a medias (ej. el vínculo), al reintentar `complete` retoma donde quedó.
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
          ? `Resolución operativa del requerimiento ${rec.key} (sin desarrollo).\n\n*Resumen:* ${a.resumen}\n*Justificación:* ${a.justificacion_carril}\n\n` +
            `*Criterios de aceptación:*\n${lista(a.criterios_aceptacion ?? [])}\n\nEl script, el rollback y la verificación los propone la etapa EJECUCION y se publican en el REC.`
          : `Desarrollo del requerimiento ${rec.key}. *Carril:* ${a.carril} — ${a.justificacion_carril}\n\n` +
            `*Resumen:* ${rec.artefactos.ANALISIS?.especificacion?.resumen ?? a.resumen}\n\n` +
            `*Rama:* rec/${rec.key.toLowerCase()}\n` + (rec.cambio ? `*OpenSpec change:* openspec/changes/${rec.cambio}/\n` : `*Sin spec (carril directo):* orqen/work/${rec.key}/ronda-${rec.ronda}/analisis.md\n`) +
            `*Estimación:* ${rec.artefactos.estimacion_horas ?? "?"} h\n\n` +
            `*${rec.cambio ? "Tareas" : "Plan"}:*\n${lista(tareas.map((t) => t.descripcion))}\n\n` +
            `*${rec.cambio ? "Escenarios de aceptación" : "Criterios de aceptación"}:*\n${lista(esc.map((e) => rec.cambio ? `${e.requisito} › ${e.escenario}` : e.escenario))}`,
      });
      rec.sis = sis;
      this.store.save(rec);
    }
    if (!rec.artefactos.sis_vinculado) {
      await this.jira.vincular(rec.sis, rec.key, this.cfg.sis.link);
      await this.jira.comentar(rec.key, `Análisis cerrado${rec.analista ? ` con ${rec.analista}` : ""}. Creé ${rec.sis} (carril ${operativo ? "operativo" : a.carril}) para el seguimiento; el seguimiento técnico va por ahí y acá sigo informando los hitos.`);
      await this.jira.comentar(rec.sis, `Creado a partir de ${rec.key} al cerrarse el análisis. Registro: orqen/work/${rec.key}/.`);
      rec.artefactos.sis_vinculado = true;
      this.store.save(rec);
    }
  }

  /** Comenta en el REC y, si ya existe, espeja en el SIS. */
  private async comentarConSis(rec: Rec, texto: string) {
    await this.jira.comentar(rec.key, texto);
    if (rec.sis) await this.intentarAsync(() => this.jira.comentar(rec.sis!, texto));
  }

  // ================================================================ utilidades
  async bloquear(key: string, motivo: string, agente = "agente") {
    const rec = this.store.get(key) ?? recNuevo(key);
    if (rec.estado === "BLOQUEADO") return;
    await this.jira.comentar(key, `Necesito intervención humana: ${motivo}\nCuando esté resuelto, comentá /approve <indicaciones> para reintentar.`);
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
    try { await fn(); } catch (e) { console.error(`[orqen] aviso: ${(e as Error).message}`); }
  }

  private intentar<T>(fn: () => T): T | undefined {
    try { return fn(); } catch (e) { console.error(`[orqen] aviso: ${(e as Error).message}`); return undefined; }
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
    if (rec.rama) this.intentar(() => this.ws.commit(rec.key, `registro ${desde} → ${hacia}`, { ruta: this.cfg.factoryDir, rama: rec.rama }));
    try {
      await this.jira.setLabelEstado(rec.key, hacia);
      const t = this.cfg.transicionesJira[hacia];
      if (t) await this.jira.transicionar(rec.key, t);
      if (rec.sis) {
        const ts = this.cfg.sis.transiciones[hacia];
        if (ts) await this.jira.transicionar(rec.sis, ts);
      }
    } catch (e) {
      console.error(`[orqen] no pude actualizar label/transición en Jira: ${(e as Error).message}`);
    }
  }
}

export function nombreCambio(key: string, titulo: string, ronda: number) {
  const slug = titulo.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter((w) => w.length > 2).slice(0, 4).join("-");
  return [key.toLowerCase(), slug, ronda > 1 ? `r${ronda}` : ""].filter(Boolean).join("-");
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
const lista = (xs: string[], num = false) => xs.map((x) => `${num ? "#" : "*"} ${x}`).join("\n") || "_(ninguno)_";
