import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const directory = dirname(fileURLToPath(import.meta.url));
/** Directory containing the files installed by orqen. */
export const TEMPLATES_DIR = join(directory, "templates");
/** @deprecated Use TEMPLATES_DIR. */
export const DIR_PLANTILLAS = TEMPLATES_DIR;
/** Kit version recorded by orqen init and update. */
export const VERSION_KIT = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")).version;
