/** Project-wide naming, independent of the providers used for requests and issues. */
import { General, type Config } from "./config.ts";
import { connectorSettings, type ConectorYaml } from "../connectors/config.ts";
import { ejemploClave } from "../connectors/describe.ts";

export function generalSettings(config: Config) {
  if (config.general) return config.general;
  const prefix = (connector: ConectorYaml | null | undefined, fallback: string) => connector
    ? ejemploClave(connectorSettings(connector, {}), 1).replace(/-\d+$/, "") : fallback;
  return { prefijos: {
    requests: prefix(config.conectores?.requests, "REQ"),
    issues: prefix(config.conectores?.issues, "ISS"),
  } };
}

export function updateGeneral(config: Config, input: unknown, hasHistory: boolean): Config {
  const parsed = General.safeParse(input);
  if (!parsed.success) throw new Error(parsed.error.issues.map((i) => i.message).join("; "));
  const general = parsed.data;
  const previous = generalSettings(config).prefijos;
  if (hasHistory && (previous.requests !== general.prefijos.requests || previous.issues !== general.prefijos.issues)) {
    throw new Error("Este proyecto ya tiene requests registrados. Cambiar los prefijos necesita migrar sus claves e historial; se conservó la configuración actual.");
  }
  if (config.conectores?.issues && general.prefijos.requests === general.prefijos.issues) throw new Error("Usá prefijos diferentes para requests e issues.");
  for (const connector of [config.conectores?.requests, config.conectores?.issues]) {
    if (connector?.tipo === "jira" && !connector.proyecto) throw new Error("Seleccioná el proyecto de Jira en Conectores antes de guardar los prefijos generales.");
  }
  const result = structuredClone(config);
  result.general = general;
  for (const connector of [result.conectores?.requests, result.conectores?.issues]) if (connector) delete connector.prefijo;
  return result;
}
