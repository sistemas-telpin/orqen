/**
 * Customer request state machine. Agents provide output for each stage.
 *
 *
 * An analyst leads analysis using /orqen:analyze.
 * When it closes, the lane, any spec, and the implementation issue are recorded.
 */
export const Estado = {
  NUEVO: "NUEVO",
  ANALISIS: "ANALISIS",               // Analyst interview, lane selection, optional spec, and SIS creation
  ESPERA_CLIENTE: "ESPERA_CLIENTE",   // Wait for customer replies.
  DESARROLLO: "DESARROLLO",           // Agent implements the spec or direct-lane plan.
  TESTING: "TESTING",                 // The CLI runs tests and the agent verifies coverage.
  REVISION_CODIGO: "REVISION_CODIGO", // A senior engineer reviews the pull request.
  ENTREGA: "ENTREGA",                 // The CLI archives the spec and the agent writes delivery notes.
  // --- Operational work: SQL, restart, or runbook without code changes or OpenSpec.
  EJECUCION: "EJECUCION",             // Agent prepares steps, rollback, and verification.
  APROBACION_EJECUCION: "APROBACION_EJECUCION", // An authorized operator approves the change.
  APLICACION: "APLICACION",           // A person applies the change and reports the result.
  VERIFICACION: "VERIFICACION",       // Agent verifies the result with read-only checks.
  CONFORMIDAD: "CONFORMIDAD",         // Customer accepts the result.
  CERRADO: "CERRADO",
  BLOQUEADO: "BLOQUEADO",
} as const;
export type Estado = (typeof Estado)[keyof typeof Estado];

export type EstadoAgente = "ANALISIS" | "DESARROLLO" | "TESTING" | "ENTREGA" | "EJECUCION" | "VERIFICACION";
export const ESTADOS_AGENTE: readonly Estado[] = ["ANALISIS", "DESARROLLO", "TESTING", "ENTREGA", "EJECUCION", "VERIFICACION"];

/** Whether the request needs development or operational work. */
export type Via = "desarrollo" | "operativa";

/**
 * Amount of specification for development, confirmed by the analyst.
 *  - directo:  No OpenSpec. The analysis and SIS carry the plan and acceptance criteria.
 *  - liviano:  Compact OpenSpec proposal, deltas, tasks, and design.
 *  - completo: Full OpenSpec proposal, specs, design, and tasks.
 */
export type Carril = "directo" | "liviano" | "completo";
export const CARRILES: readonly Carril[] = ["directo", "liviano", "completo"];

export const esEstadoAgente = (e: Estado): e is EstadoAgente => ESTADOS_AGENTE.includes(e);

export type Gate = "ESPERA_CLIENTE" | "REVISION_CODIGO" | "CONFORMIDAD" | "APROBACION_EJECUCION" | "APLICACION";
export const GATES: Record<Gate, { tipo: "respuesta" | "aprobacion"; aprobar: Estado; rechazar: Estado }> = {
  ESPERA_CLIENTE: { tipo: "respuesta", aprobar: "ANALISIS", rechazar: "ANALISIS" },
  REVISION_CODIGO: { tipo: "aprobacion", aprobar: "ENTREGA", rechazar: "DESARROLLO" },
  CONFORMIDAD: { tipo: "aprobacion", aprobar: "CERRADO", rechazar: "ANALISIS" },
  APROBACION_EJECUCION: { tipo: "aprobacion", aprobar: "APLICACION", rechazar: "EJECUCION" },
  APLICACION: { tipo: "aprobacion", aprobar: "VERIFICACION", rechazar: "EJECUCION" },
};
export const esGate = (e: Estado): e is Gate => e in GATES;

export const MAX_INTENTOS_TESTING = 3;
export const MAX_RONDAS_PREGUNTAS = 3;

/** Select the next state from the validated stage output. */
export function siguienteTrasEtapa(
  estado: EstadoAgente,
  salida: Record<string, any>,
  c: { intentosTesting: number; rondasPreguntas: number },
): Estado {
  switch (estado) {
    case "ANALISIS":
      if (salida.preguntas_abiertas?.length && !salida.listo)
        return c.rondasPreguntas >= MAX_RONDAS_PREGUNTAS ? "BLOQUEADO" : "ESPERA_CLIENTE";
      // After analyst approval, the selected route determines the next stage.
      return salida.via === "operativa" ? "EJECUCION" : "DESARROLLO";
    case "DESARROLLO":
      return salida.completado ? "TESTING" : "BLOQUEADO";
    case "TESTING":
      if (salida.aprobado) return "REVISION_CODIGO";
      return c.intentosTesting >= MAX_INTENTOS_TESTING ? "BLOQUEADO" : "DESARROLLO";
    case "ENTREGA":
      return "CONFORMIDAD";
    case "EJECUCION":
      return "APROBACION_EJECUCION";
    case "VERIFICACION":
      if (salida.verificado) return "CONFORMIDAD";
      if (salida.requiere_desarrollo) return "ANALISIS";   // The analyst chooses a development lane after escalation.
      return c.intentosTesting >= MAX_INTENTOS_TESTING ? "BLOQUEADO" : "EJECUCION";
  }
}
