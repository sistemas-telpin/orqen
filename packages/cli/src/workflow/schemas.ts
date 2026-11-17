/** Stage output schemas validated by `orqen complete`. */
import { z } from "zod";
import { CARRILES, type Carril, type EstadoAgente } from "./states.ts";

const lista = z.array(z.string());

export const ESQUEMAS = {
  ANALISIS: z.object({
    resumen: z.string().min(20).describe("Customer request in business terms"),
    tipo: z.enum(["funcionalidad", "cambio", "bug", "consulta", "rendimiento", "otro"]),
    criterios_aceptacion: lista.min(1).describe("Testable Given/When/Then criteria for OpenSpec scenarios or the direct lane's test checklist"),
    capacidades_afectadas: lista.describe("Affected paths under openspec/specs, or new capability names in kebab case"),
    decisiones: z.array(z.object({ pregunta: z.string(), respuesta: z.string() })).default([])
      .describe("Questions resolved by the analyst and their answers"),
    preguntas_abiertas: lista.max(5).describe("Specification blockers that only the customer can answer"),
    riesgos: lista,
    relacionados: lista.optional(),
    listo: z.boolean().describe("True if the analyst approved and the request can advance"),
    analista_ok: z.boolean().default(false).describe("The analyst explicitly approved the analysis and lane. Required when listo=true."),
    via: z.enum(["desarrollo", "operativa"]).default("desarrollo")
      .describe("Use operativa for SQL, restarts, cleanup, or configuration without code changes. Use desarrollo for code changes."),
    carril: z.enum(CARRILES as [Carril, ...Carril[]]).optional()
      .describe("Use directo (no spec), liviano (lightweight), or completo (full). Required when listo=true. Operational work uses directo."),
    justificacion_carril: z.string().optional().describe("Why this lane fits the size, risk, and scope"),
    plan: lista.optional().describe("Ordered implementation steps for direct development"),
    estimacion_horas: z.number().nonnegative().optional().describe("Total hours for direct development. Other lanes use tasks.md."),
    especificacion: z.object({
      cambio: z.string().describe("OpenSpec change ID assigned by orqen lane"),
      resumen: z.string().min(20).describe("Proposal summary"),
      supuestos: lista,
    }).optional().describe("Required for the lightweight and full lanes"),
  }).superRefine((s, ctx) => {
    if (!s.listo) return;
    const falta = (path: string, message: string) => ctx.addIssue({ code: "custom", path: [path], message });
    if (!s.analista_ok) falta("analista_ok", "Set analista_ok=true after explicit analyst approval before setting listo=true");
    if (!s.carril) return falta("carril", "Choose a lane when listo=true: directo, liviano, or completo");
    if (!s.justificacion_carril || s.justificacion_carril.length < 10) falta("justificacion_carril", "Explain why you chose this lane");
    if (s.via === "operativa" && s.carril !== "directo") falta("carril", "Use the directo lane for operational work");
    if (s.via === "desarrollo" && s.carril === "directo" && !s.plan?.length) falta("plan", "The direct lane requires an implementation plan");
    if (s.via === "desarrollo" && s.carril !== "directo" && !s.especificacion) falta("especificacion", "The lightweight and full lanes require a spec (orqen lane + OpenSpec artifacts)");
  }),

  DESARROLLO: z.object({
    completado: z.boolean(),
    resumen_cambios: z.string(),
    archivos_modificados: lista,
    tests_agregados: lista,
    bloqueo: z.string().optional().describe("Required when completado=false"),
  }).refine((s) => s.completado || !!s.bloqueo, { message: "Explain the blocker when completado=false", path: ["bloqueo"] }),

  TESTING: z.object({
    escenarios: z.array(z.object({
      requisito: z.string(),
      escenario: z.string(),
      cubierto: z.boolean(),
      test: z.string().optional().describe("file::name of the test that covers the scenario"),
    })).describe("One entry per expected scenario"),
    diagnostico_fallas: z.string(),
    sugerencias: lista,
    cobertura_ok: z.boolean(),
  }),

  ENTREGA: z.object({
    notas_release: z.string(),
    mensaje_cliente: z.string().min(20),
    pasos_validacion: lista.min(1),
  }),

  EJECUCION: z.object({
    resumen: z.string().min(20).describe("Proposed action and how it resolves the request"),
    sistema: z.string().min(2).describe("Target database, server, or service"),
    impacto: z.string().min(10).describe("Affected rows, tables, or services, maintenance window, and downtime"),
    filas_estimadas: z.number().int().nonnegative().optional().describe("Affected rows estimated by a SELECT COUNT query"),
    script_sql: z.string().optional().describe("Complete SQL script for the approved operator to run"),
    pasos_manuales: lista.optional().describe("Ordered non-SQL steps, such as restarts, commands, or configuration"),
    rollback: z.string().min(5).describe("Rollback script or procedure. Explain any irreversible changes."),
    verificacion: z.string().min(5).describe("Read-only SELECT query or check that verifies the result"),
    riesgos: lista,
  }).refine((s) => !!s.script_sql?.trim() || !!s.pasos_manuales?.length, {
    message: "Provide script_sql or pasos_manuales", path: ["script_sql"],
  }),

  VERIFICACION: z.object({
    verificado: z.boolean().describe("True if evidence confirms the issue is resolved"),
    evidencia: z.string().min(5).describe("Verification results from the query or check"),
    requiere_desarrollo: z.boolean().default(false).describe("True if verification shows that a code change is required"),
    mensaje_cliente: z.string().default(""),
    pasos_validacion: lista.default([]),
  }).refine((s) => !s.verificado || (s.mensaje_cliente.length >= 20 && s.pasos_validacion.length > 0), {
    message: "When verificado=true, provide mensaje_cliente (at least 20 characters) and pasos_validacion", path: ["mensaje_cliente"],
  }),
} satisfies Record<EstadoAgente, z.ZodType>;

export type Salida<E extends EstadoAgente> = z.infer<(typeof ESQUEMAS)[E]>;

export const esquemaJson = (e: EstadoAgente) => z.toJSONSchema(ESQUEMAS[e], { io: "input" });
