/**
 * Key names of orqen/config.yaml and orqen/environment.yaml. The files use English keys; the code (and the JSON that tools
 * such as orqen-gui exchange with `orqen connectors get|set`) keeps the internal names. Files written by earlier versions,
 * with the keys in Spanish, are still read: each key is accepted under either name.
 */

/** English key in the file → internal key, with how to translate what is inside it. */
type Entry = string | { as: string; keys?: Keys; items?: Keys; values?: Record<string, string> };
export interface Keys { [english: string]: Entry }

const TESTS: Keys = { unit: "unitarios", integration: "integracion", e2e: "e2e", visual: "visual" };

const CONNECTOR: Keys = {
  type: "tipo", credentials: "credenciales", url: "url", filter: "filtro", state: "estado", project: "proyecto",
  issue_type: "tipo_ticket", operational_type: "tipo_operativo", link_type: "vinculo", repo: "repo",
  project_owner: "duenio_proyecto", field: "campo", labels: "etiquetas", prefix: "prefijo", transitions: "transiciones",
};

const COMPONENT: Keys = {
  name: "nombre", type: { as: "tipo", values: { library: "libreria", other: "otro" } }, path: "ruta", language: "lenguaje",
  framework: "framework", port: "puerto", dockerfile: "dockerfile",
  commands: { as: "comandos", keys: { install: "instalar", dev: "dev", build: "build", tests: "tests" } },
};
const SERVICE: Keys = {
  name: "nombre", type: { as: "tipo", values: { other: "otro" } }, image: "imagen", port: "puerto", variables: "variables", reason: "motivo",
};
export const STACK_KEYS: Keys = {
  summary: "resumen", package_manager: "gestor_paquetes", install: "instalar",
  components: { as: "componentes", items: COMPONENT }, services: { as: "servicios", items: SERVICE },
  tests: { as: "tests", keys: TESTS }, migrations: "migraciones", seed: "seed", variables: "variables", notes: "notas",
};
const PROCESS: Keys = {
  name: "nombre", command: "comando", path: "ruta", port: "puerto", url: "url", ready_when: "listo_si", stop: "detener",
  when: { as: "cuando", values: { always: "siempre" } }, wait_seconds: "espera_seg",
};
/** orqen/environment.yaml without `stack`: how the project starts and is tested (`entornos` inside). */
export const ENVIRONMENT_KEYS: Keys = {
  processes: { as: "procesos", items: PROCESS }, variables: "variables", prepare: "preparar", migrate: "migrar", seed: "seed",
  tests: { as: "tests", keys: TESTS },
};

/** orqen/config.yaml: what the 9-step flow needs. */
export const CONFIG_KEYS: Keys = {
  version: "version",
  orqen: { as: "orqen", keys: { cli: "cli", kit: "kit" } },
  project: { as: "proyecto", keys: { name: "nombre", base_branch: "rama_base" } },
  general: { as: "general", keys: { prefixes: "prefijos" } },
  agent: { as: "agente", keys: { command: "comando" } },
  openspec: { as: "openspec", keys: { version: "version", install: "instalacion", tools: "herramientas" } },
  sdd: { as: "sdd", keys: { provider: "proveedor" } },
  connectors: { as: "conectores", keys: { requests: { as: "requests", keys: CONNECTOR }, issues: { as: "issues", keys: CONNECTOR } } },
  workflow: {
    as: "flujo", keys: {
      support: "soporte",
      approvers: { as: "aprobadores", keys: { analysis: "analisis", qa: "qa", code: "codigo", client: "cliente", execution: "ejecucion" } },
      code_review: { as: "code_review", keys: { gate: "gate", reviewers: "revisores" } },
      devel_branch: "rama_desarrollo", pr_command: "comando_pr", test_command: "comando_tests",
      lock_minutes: "lock_min", interval_seconds: "intervalo_seg",
    },
  },
  // files of earlier versions kept these two in config.yaml
  stack: { as: "stack", keys: STACK_KEYS },
  environment: { as: "entornos", keys: ENVIRONMENT_KEYS },
};

const norm = (e: Entry) => (typeof e === "string" ? { as: e } : e);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** File (English, or the Spanish of earlier versions) → internal names. Unknown keys are kept as they are. */
export function toInternal(v: unknown, keys: Keys): any {
  if (!isObj(v)) return v;
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v)) {
    const hit = Object.entries(keys).find(([en, e]) => en === k || norm(e).as === k);
    if (!hit) { out[k] = val; continue; }
    const e = norm(hit[1]);
    // an English key wins over the same setting written with its old name
    if (e.as in out && hit[0] !== k) continue;
    out[e.as] = convert(val, e, "in");
  }
  return out;
}

/** Internal names → English keys of the file. */
export function toFile(v: unknown, keys: Keys): any {
  if (!isObj(v)) return v;
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v)) {
    const hit = Object.entries(keys).find(([, e]) => norm(e).as === k);
    if (!hit) { out[k] = val; continue; }
    out[hit[0]] = convert(val, norm(hit[1]), "out");
  }
  return out;
}

function convert(val: unknown, e: { keys?: Keys; items?: Keys; values?: Record<string, string> }, dir: "in" | "out"): unknown {
  const f = dir === "in" ? toInternal : toFile;
  if (e.keys) return f(val, e.keys);
  if (e.items && Array.isArray(val)) return val.map((x) => f(x, e.items!));
  if (e.values && typeof val === "string") {
    const pairs = Object.entries(e.values);
    const hit = dir === "in" ? pairs.find(([en]) => en === val) : pairs.find(([, int]) => int === val);
    return hit ? (dir === "in" ? hit[1] : hit[0]) : val;
  }
  return val;
}

/** Internal path of a validation error → the English path as written in the file (e.g. flujo.comando_pr → workflow.pr_command). */
export function filePath(path: PropertyKey[], keys: Keys): string {
  const out: string[] = [];
  let cur: Keys | undefined = keys;
  for (const seg of path) {
    if (typeof seg === "number") { out.push(String(seg)); continue; }
    const hit: [string, Entry] | undefined = cur ? Object.entries(cur).find(([, e]) => norm(e).as === seg) : undefined;
    if (!hit) { out.push(String(seg)); cur = undefined; continue; }
    out.push(hit[0]);
    const e = norm(hit[1]);
    cur = e.keys ?? e.items;
  }
  return out.join(".");
}
