/** Project-wide naming, independent of the providers used for requirements and development tickets. */
import { General, type Config } from "./config.ts";
import { connectorSettings, type ConectorYaml } from "../connectors/config.ts";
import { ejemploClave } from "../connectors/describe.ts";

export function generalSettings(config: Config) {
  if (config.general) return config.general;
  const prefix = (connector: ConectorYaml | null | undefined, fallback: string) => connector
    ? ejemploClave(connectorSettings(connector, {}), 1).replace(/-\d+$/, "") : fallback;
  return { prefijos: {
    requerimientos: prefix(config.conectores?.externo, "REQ"),
    tickets: prefix(config.conectores?.interno, "TKT"),
  } };
}

export function updateGeneral(config: Config, input: unknown, hasHistory: boolean): Config {
  const parsed = General.safeParse(input);
  if (!parsed.success) throw new Error(parsed.error.issues.map((i) => i.message).join("; "));
  const general = parsed.data;
  const previous = generalSettings(config).prefijos;
  if (hasHistory && (previous.requerimientos !== general.prefijos.requerimientos || previous.tickets !== general.prefijos.tickets)) {
    throw new Error("Este proyecto ya tiene requerimientos registrados. Cambiar los prefijos necesita migrar sus claves e historial; se conservó la configuración actual.");
  }
  if (config.conectores?.interno && general.prefijos.requerimientos === general.prefijos.tickets) throw new Error("Usá prefijos diferentes para requerimientos y tickets.");
  for (const connector of [config.conectores?.externo, config.conectores?.interno]) {
    if (connector?.tipo === "jira" && !connector.proyecto) throw new Error("Seleccioná el proyecto de Jira en Conectores antes de guardar los prefijos generales.");
  }
  const result = structuredClone(config);
  result.general = general;
  for (const connector of [result.conectores?.externo, result.conectores?.interno]) if (connector) delete connector.prefijo;
  return result;
}
