import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const aqui = dirname(fileURLToPath(import.meta.url));
/** Carpeta con las plantillas del kit. */
export const DIR_PLANTILLAS = join(aqui, "plantillas");
/** Versión del kit (se guarda en orqen.yaml para que `orqen update` sepa qué cambió). */
export const VERSION_KIT = JSON.parse(readFileSync(join(aqui, "package.json"), "utf8")).version;
