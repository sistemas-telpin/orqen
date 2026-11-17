import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { comandoRapido, explorarConAgente, explorarRapido, explorarRapidoAislado, extraerJson, promptExploracion } from "../src/lib/agent.ts";
import { resumenComoTexto, resumirRepo } from "../src/lib/repo-summary.ts";
import { escena, logo } from "../src/ui/logo.ts";
import { detectar } from "../src/lib/detect.ts";
import { partirComando } from "../src/lib/proc.ts";
import { MONOREPO, repoTemporal } from "./helpers.ts";

/** Fake agent that reads stdin and writes a proposal using the selected mode. */
function agenteFalso(dir: string, modo: "archivo" | "stdout" | "malo-despues-bueno" | "malo") {
  const script = join(dir, "agente-falso.mjs");
  writeFileSync(script, `
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
const prompt = readFileSync(0, "utf8");
const bueno = { resumen: "Pagos: front React y API NestJS", componentes: [{ nombre: "api", tipo: "backend", ruta: "apps/api", lenguaje: "typescript", framework: "nestjs", puerto: 3000 }],
  servicios: [{ nombre: "db", tipo: "postgres" }], tests: { unitarios: "pnpm -r test", e2e: "pnpm exec playwright test" }, notas: ["agente"] };
const malo = { resumen: 3, componentes: [{ nombre: "x", tipo: "nave-espacial" }] };
const modo = ${JSON.stringify(modo)};
const reintento = prompt.includes("failed validation");
const salida = modo === "malo" || (modo === "malo-despues-bueno" && !reintento) ? malo : bueno;
if (!prompt.includes("JSON Schema")) process.exit(3);
if (modo === "stdout") console.log("Listo:\\n\`\`\`json\\n" + JSON.stringify(salida) + "\\n\`\`\`");
else writeFileSync("orqen/tmp/stack-proposal.json", JSON.stringify(salida));
`);
  return `node "${script}"`;
}

test("validates an agent proposal written to a file", async () => {
  const repo = repoTemporal(MONOREPO);
  const r = await explorarConAgente(repo, agenteFalso(repo, "archivo"), detectar(repo));
  assert.ok(r.ok, r.errores.join("; "));
  assert.equal(r.stack!.servicios[0].tipo, "postgres");
  assert.deepEqual(r.stack!.notas, ["agente"]);
});

test("accepts JSON from stdout when the agent writes no file", async () => {
  const repo = repoTemporal(MONOREPO);
  const r = await explorarConAgente(repo, agenteFalso(repo, "stdout"), detectar(repo));
  assert.ok(r.ok, r.errores.join("; "));
});

test("retries an invalid proposal with validation errors", async () => {
  const repo = repoTemporal(MONOREPO);
  let reintentos = 0;
  const r = await explorarConAgente(repo, agenteFalso(repo, "malo-despues-bueno"), detectar(repo), { alReintentar: () => reintentos++ });
  assert.ok(r.ok);
  assert.equal(reintentos, 1);
});

test("returns errors when neither proposal validates", async () => {
  const repo = repoTemporal(MONOREPO);
  const r = await explorarConAgente(repo, agenteFalso(repo, "malo"), detectar(repo));
  assert.equal(r.ok, false);
  assert.ok(r.errores.some((e) => e.startsWith("componentes.0.tipo")));
});

test("reports a missing command", async () => {
  const repo = repoTemporal();
  const r = await explorarConAgente(repo, "missing-agent-xyz -p", detectar(repo));
  assert.equal(r.ok, false);
  assert.match(r.errores[0], /Could not execute/);
});

test("splits command arguments and extracts JSON", () => {
  assert.deepEqual(partirComando(`claude -p --permission-mode acceptEdits`), ["claude", "-p", "--permission-mode", "acceptEdits"]);
  assert.deepEqual(partirComando(`node "C:\\Program Files\\x.mjs" ''`), ["node", "C:\\Program Files\\x.mjs", ""]);
  assert.deepEqual(extraerJson('bla ```json\n{"a":1}\n``` fin'), { a: 1 });
  assert.equal(extraerJson("nada"), undefined);
  assert.match(promptExploracion({ stack: detectar(repoTemporal()).stack, evidencias: [] }), /stack-proposal\.json/);
});

test("quick analysis submits the repository summary in one turn without writing files", async () => {
  const repo = repoTemporal(MONOREPO);
  const script = join(repo, "..", `rapido-${Date.now()}.mjs`);
  writeFileSync(script, `
import { readFileSync } from "node:fs";
const prompt = readFileSync(0, "utf8");
const ok = prompt.includes("--- apps/api/package.json ---") && prompt.includes("schema.prisma") && prompt.includes("Do not call tools");
console.log(JSON.stringify({ resumen: ok ? "with summary" : "without summary", servicios: [{ nombre: "db", tipo: "postgres" }] }));
`);
  const r = await explorarRapido(repo, `node "${script}"`, detectar(repo));
  assert.ok(r.ok, r.errores.join("; "));
  assert.equal(r.stack!.resumen, "with summary");
  assert.ok(!existsSync(join(repo, "orqen")), "does not write files to the repository");
  assert.equal(comandoRapido("claude -p --permission-mode acceptEdits"), "claude -p --model haiku");
  assert.equal(comandoRapido("mi-agente --x"), "mi-agente --x");
});

test("quick analysis stops after an agent failure", async () => {
  const repo = repoTemporal(MONOREPO);
  const r = await explorarRapido(repo, `node -e "console.error('Authentication error'); process.exit(1)"`, detectar(repo));
  assert.equal(r.ok, false);
  assert.match(r.errores[0], /Authentication error/);
});

test("limits the repository summary to key files", () => {
  const r = resumirRepo(repoTemporal({ ...MONOREPO, "build.xml": "<project/>", "node_modules/x/package.json": "{}", "grande.txt": "x".repeat(10) }));
  const rutas = r.archivos.map((a) => a.ruta);
  assert.ok(rutas.includes("build.xml") && rutas.includes("apps/api/prisma/schema.prisma"));
  assert.ok(!rutas.some((x) => x.includes("node_modules")));
  assert.ok(resumenComoTexto(r).length < 60_000);
});

test("renders a stable animated loop and a static logo", () => {
  const limpio = (l: string) => l.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
  const bienvenida = ["uno", "dos"];
  const n = escena(0, bienvenida, true).length;
  const ancho = (tramos: [number, string][]) => tramos.reduce((a, [, s]) => a + [...limpio(s)].length, 0);
  for (const t of [0, 0.3, 0.8, 1.2, 1.6, 3, 7.77, 60]) {
    const e = escena(t, bienvenida, true);
    assert.equal(e.length, n, `same number of lines at t=${t}`);
    for (const fila of e.slice(0, 12)) assert.equal(ancho(fila), 90, `lienzo de ancho fijo en t=${t}`);
  }
  const e = escena(5, bienvenida, true);
  const texto = e.map((l) => l.map(([, s]) => limpio(s)).join("")).join("\n");
  assert.match(texto, /A U T O N O M O U S   S Y S T E M S/);
  assert.match(texto, /uno[\s\S]*dos[\s\S]*Press Enter to begin/);
  // The loop keeps moving after the intro and updates only some segments.
  const a = escena(5, [], true).slice(0, 12).flat().map(([, s]) => s), b = escena(5.05, [], true).slice(0, 12).flat().map(([, s]) => s);
  const cambiados = a.filter((s, i) => s !== b[i]).length;
  assert.ok(cambiados > 0 && cambiados < a.length, `tramos que cambian: ${cambiados}/${a.length}`);
  // The static logo uses pixels in a wide color terminal and plain characters otherwise.
  assert.match(logo(true, 120), /▀/);
  assert.ok(logo(true, 120).split("\n").every((l) => [...limpio(l)].length <= 90));
  assert.match(logo(false), /A U T O N O M O U S/);
  assert.match(logo(true, 80), /██████╗/);
});

test("isolated analysis returns a result from a process without a shared terminal", async () => {
  const repo = repoTemporal(MONOREPO);
  const script = join(repo, "..", `aislado-${Date.now()}.mjs`);
  writeFileSync(script, `
import { readFileSync } from "node:fs";
const prompt = readFileSync(0, "utf8");
console.log(JSON.stringify({ resumen: process.stdin.isTTY ? "con tty" : "aislado", servicios: [{ nombre: "db", tipo: "postgres" }] }));
`);
  const { resultado } = explorarRapidoAislado(repo, `node "${script}"`, detectar(repo));
  const r = await resultado;
  assert.ok(r.ok, r.errores.join("; "));
  assert.equal(r.stack!.resumen, "aislado");
  assert.ok(!existsSync(join(repo, "orqen")));

  const c = explorarRapidoAislado(repo, `node -e "setTimeout(()=>{}, 60000)"`, detectar(repo));
  c.cancelar();   // The worker has exited.
});
