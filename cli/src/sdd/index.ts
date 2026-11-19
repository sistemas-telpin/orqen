/**
 * The SDD providers and which one a project uses: `sdd.proveedor` in orqen/config.yaml (or ORQEN_SDD), otherwise
 * the first one whose folders are in the project, otherwise OpenSpec (orqen's default). To add a tool: write a
 * provider (see openspec.ts) and list it here.
 */
import { openspec } from "./openspec.ts";
import { speckit } from "./speckit.ts";
import type { SddProvider, Source } from "./types.ts";

export const PROVIDERS: SddProvider[] = [openspec, speckit];

export function providerFor(src: Source, chosen?: string | null): SddProvider {
  const want = (process.env.ORQEN_SDD || chosen || "auto").toLowerCase();
  if (want !== "auto") {
    const p = PROVIDERS.find((x) => x.id === want || x.label.toLowerCase() === want);
    if (!p) throw new Error(`Unknown SDD provider "${want}". Available: ${PROVIDERS.map((x) => x.id).join(", ")}`);
    return p;
  }
  return PROVIDERS.find((p) => p.detect(src)) ?? openspec;
}

export * from "./types.ts";
export { DirSource, GitSource, parseTasks } from "./common.ts";
