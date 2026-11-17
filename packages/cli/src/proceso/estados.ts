/**
 * Máquina de estados del REC. El FLUJO lo decide este código; el agente (cualquiera:
 * Claude Code, Codex, Cursor, Copilot...) solo produce contenido en cada etapa.
 *
 * El ANALISIS es el único tramo conducido por una persona (el analista, vía `/orqen:analyze`): al cerrarse
 * con el OK del analista ya están decididos el carril, la spec (si corresponde) y el SIS.
 */
export const Estado = {
  NUEVO: "NUEVO",
  ANALISIS: "ANALISIS",               // analista + agente (grilling): entender, elegir carril, spec si corresponde, crear el SIS
  ESPERA_CLIENTE: "ESPERA_CLIENTE",   // gate: el cliente responde preguntas
  DESARROLLO: "DESARROLLO",           // agente: implementa (openspec apply, o el plan del carril directo)
  TESTING: "TESTING",                 // script corre tests; agente verifica escenarios/criterios
  REVISION_CODIGO: "REVISION_CODIGO", // gate: senior revisa el PR
  ENTREGA: "ENTREGA",                 // script: openspec archive (si hubo spec); agente: notas + mensaje
  // --- carril rápido (via=operativa): script SQL / reinicio / runbook, sin código ni OpenSpec
  EJECUCION: "EJECUCION",             // agente: prepara script/pasos + rollback + verificación
  APROBACION_EJECUCION: "APROBACION_EJECUCION", // gate: DBA/infra autoriza lo que se va a ejecutar
  APLICACION: "APLICACION",           // gate: una persona lo aplica y reporta el resultado
  VERIFICACION: "VERIFICACION",       // agente: verifica (solo lectura) que el problema se resolvió
  CONFORMIDAD: "CONFORMIDAD",         // gate: cliente da conformidad
  CERRADO: "CERRADO",
  BLOQUEADO: "BLOQUEADO",
} as const;
export type Estado = (typeof Estado)[keyof typeof Estado];

export type EstadoAgente = "ANALISIS" | "DESARROLLO" | "TESTING" | "ENTREGA" | "EJECUCION" | "VERIFICACION";
export const ESTADOS_AGENTE: readonly Estado[] = ["ANALISIS", "DESARROLLO", "TESTING", "ENTREGA", "EJECUCION", "VERIFICACION"];

/** Cómo se resuelve un REC: desarrollo (código) u operativa (carril rápido: SQL, reinicios...). */
export type Via = "desarrollo" | "operativa";

/**
 * Cuánta especificación lleva un REC de desarrollo (lo propone el agente y lo confirma el analista):
 *  - directo:  sin OpenSpec. El plan y los criterios de aceptación viven en el análisis y en el SIS.
 *  - liviano:  change de OpenSpec compacto (proposal + deltas + tasks; design mínimo).
 *  - completo: change de OpenSpec completo (proposal + specs + design + tasks).
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

/** Próximo estado a partir de la salida (ya validada) de una etapa. */
export function siguienteTrasEtapa(
  estado: EstadoAgente,
  salida: Record<string, any>,
  c: { intentosTesting: number; rondasPreguntas: number },
): Estado {
  switch (estado) {
    case "ANALISIS":
      if (salida.preguntas_abiertas?.length && !salida.listo)
        return c.rondasPreguntas >= MAX_RONDAS_PREGUNTAS ? "BLOQUEADO" : "ESPERA_CLIENTE";
      // listo = el analista dio el OK: la vía decide el camino (no hay gate intermedio)
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
      if (salida.requiere_desarrollo) return "ANALISIS";   // escalada: el analista re-analiza y elige carril de desarrollo
      return c.intentosTesting >= MAX_INTENTOS_TESTING ? "BLOQUEADO" : "EJECUCION";
  }
}
