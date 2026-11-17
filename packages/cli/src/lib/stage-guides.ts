import { existsSync } from "node:fs";
import { join } from "node:path";
import type { EstadoAgente } from "../workflow/states.ts";

export const STAGE_GUIDES = {
  ANALISIS: "analysis.md",
  DESARROLLO: "development.md",
  EJECUCION: "execution.md",
  ENTREGA: "delivery.md",
  ESPECIFICACION: "specification.md",
  TESTING: "testing.md",
  VERIFICACION: "verification.md",
} satisfies Record<EstadoAgente | "ESPECIFICACION", string>;

/** Keep existing project guides at their original paths so local edits remain effective. */
export function stageGuideFile(directory: string, filename: string): string {
  if (existsSync(join(directory, filename))) return filename;
  const stage = Object.entries(STAGE_GUIDES).find(([, name]) => name === filename)?.[0];
  const previous = stage && `${stage.toLowerCase()}.md`;
  return previous && existsSync(join(directory, previous)) ? previous : filename;
}
