/** Contrato de salida de cada etapa. `orqen complete` rechaza lo que no cumpla. */
import { z } from "zod";
import { CARRILES, type Carril, type EstadoAgente } from "./estados.ts";

const lista = z.array(z.string());

export const ESQUEMAS = {
  ANALISIS: z.object({
    resumen: z.string().min(20).describe("Qué pide el cliente, en términos de negocio"),
    tipo: z.enum(["funcionalidad", "cambio", "bug", "consulta", "rendimiento", "otro"]),
    criterios_aceptacion: lista.min(1).describe("Verificables (Dado/Cuando/Entonces); serán los Scenarios de OpenSpec o el checklist de testing del carril directo"),
    capacidades_afectadas: lista.describe("Paths de openspec/specs que toca (o nuevas, en kebab-case)"),
    decisiones: z.array(z.object({ pregunta: z.string(), respuesta: z.string() })).default([])
      .describe("Registro del grilling: cada pregunta que resolvió el analista y su respuesta"),
    preguntas_abiertas: lista.max(5).describe("Solo las que debe responder el CLIENTE y bloquean la especificación"),
    riesgos: lista,
    relacionados: lista.optional(),
    listo: z.boolean().describe("true si el analista dio el OK y alcanza para avanzar"),
    analista_ok: z.boolean().default(false).describe("El analista confirmó explícitamente el análisis Y el carril elegido. Obligatorio con listo=true"),
    via: z.enum(["desarrollo", "operativa"]).default("desarrollo")
      .describe("operativa = se resuelve SIN cambiar código (script SQL, reinicio, limpieza de datos, configuración); desarrollo = requiere código"),
    carril: z.enum(CARRILES as [Carril, ...Carril[]]).optional()
      .describe("directo (sin spec) | liviano | completo. Obligatorio con listo=true. La vía operativa siempre es directo"),
    justificacion_carril: z.string().optional().describe("Por qué ese carril (tamaño, riesgo, alcance)"),
    plan: lista.optional().describe("Carril directo (vía desarrollo): pasos de implementación en orden"),
    estimacion_horas: z.number().nonnegative().optional().describe("Carril directo: estimación total. En liviano/completo se calcula de tasks.md"),
    especificacion: z.object({
      cambio: z.string().describe("id del change de OpenSpec asignado por orqen lane"),
      resumen: z.string().min(20).describe("Resumen de la propuesta"),
      supuestos: lista,
    }).optional().describe("Obligatorio en carriles liviano y completo"),
  }).superRefine((s, ctx) => {
    if (!s.listo) return;
    const falta = (path: string, message: string) => ctx.addIssue({ code: "custom", path: [path], message });
    if (!s.analista_ok) falta("analista_ok", "Con listo=true el analista tiene que haber dado el OK explícito (analista_ok=true)");
    if (!s.carril) return falta("carril", "Con listo=true elegí el carril: directo | liviano | completo");
    if (!s.justificacion_carril || s.justificacion_carril.length < 10) falta("justificacion_carril", "Justificá el carril elegido");
    if (s.via === "operativa" && s.carril !== "directo") falta("carril", "La vía operativa no lleva spec: el carril es directo");
    if (s.via === "desarrollo" && s.carril === "directo" && !s.plan?.length) falta("plan", "El carril directo necesita el plan de implementación");
    if (s.via === "desarrollo" && s.carril !== "directo" && !s.especificacion) falta("especificacion", "Los carriles liviano y completo necesitan la spec (orqen lane + artefactos de OpenSpec)");
  }),

  DESARROLLO: z.object({
    completado: z.boolean(),
    resumen_cambios: z.string(),
    archivos_modificados: lista,
    tests_agregados: lista,
    bloqueo: z.string().optional().describe("Obligatorio si completado=false"),
  }).refine((s) => s.completado || !!s.bloqueo, { message: "Si completado=false explicá el bloqueo", path: ["bloqueo"] }),

  TESTING: z.object({
    escenarios: z.array(z.object({
      requisito: z.string(),
      escenario: z.string(),
      cubierto: z.boolean(),
      test: z.string().optional().describe("archivo::nombre del test que lo cubre"),
    })).describe("UNO por cada Scenario de los spec deltas del change"),
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
    resumen: z.string().min(20).describe("Qué se va a hacer y por qué resuelve el pedido"),
    sistema: z.string().min(2).describe("Dónde se aplica (base, servidor, servicio)"),
    impacto: z.string().min(10).describe("Qué toca: filas/tablas/servicios afectados, ventana, downtime"),
    filas_estimadas: z.number().int().nonnegative().optional().describe("Filas que afecta el script (obtenidas con un SELECT COUNT previo)"),
    script_sql: z.string().optional().describe("Script SQL a ejecutar, completo"),
    pasos_manuales: lista.optional().describe("Pasos no-SQL en orden (reinicios, comandos, configuración)"),
    rollback: z.string().min(5).describe("Cómo se deshace (script o procedimiento); si no hay vuelta atrás, decirlo y por qué"),
    verificacion: z.string().min(5).describe("Consulta SELECT o chequeo que confirma que quedó resuelto"),
    riesgos: lista,
  }).refine((s) => !!s.script_sql?.trim() || !!s.pasos_manuales?.length, {
    message: "Debe haber script_sql o pasos_manuales", path: ["script_sql"],
  }),

  VERIFICACION: z.object({
    verificado: z.boolean().describe("true si la evidencia confirma que el problema quedó resuelto"),
    evidencia: z.string().min(5).describe("Resultado de la verificación (salida de la consulta/chequeo)"),
    requiere_desarrollo: z.boolean().default(false).describe("true si se comprobó que la causa necesita un cambio de código"),
    mensaje_cliente: z.string().default(""),
    pasos_validacion: lista.default([]),
  }).refine((s) => !s.verificado || (s.mensaje_cliente.length >= 20 && s.pasos_validacion.length > 0), {
    message: "Si verificado=true completá mensaje_cliente (≥20 caracteres) y pasos_validacion", path: ["mensaje_cliente"],
  }),
} satisfies Record<EstadoAgente, z.ZodType>;

export type Salida<E extends EstadoAgente> = z.infer<(typeof ESQUEMAS)[E]>;

export const esquemaJson = (e: EstadoAgente) => z.toJSONSchema(ESQUEMAS[e], { io: "input" });
