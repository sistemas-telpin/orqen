import { existsSync } from "node:fs";
import { join } from "node:path";

const PREVIOUS_NAMES: Record<string, string> = {
  "analysis.md": "analisis.md",
  "development.md": "desarrollo.md",
  "execution.md": "ejecucion.md",
  "delivery.md": "entrega.md",
  "specification.md": "especificacion.md",
  "verification.md": "verificacion.md",
};

/** Keep project guides at their previous paths until the project updates them. */
export function stageGuideFile(directory: string, filename: string): string {
  const previous = PREVIOUS_NAMES[filename];
  return previous && !existsSync(join(directory, filename)) && existsSync(join(directory, previous))
    ? previous
    : filename;
}
