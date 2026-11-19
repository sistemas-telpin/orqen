/**
 * The practice project of the interactive tutorial: a small invoicing module (facturas-demo) with tests, and the
 * requests its client sends. The client is an LLM (`orqen practice client`) that plays Ana with the facts below.
 */

export const CLIENT = { author: "ana.perez", name: "Ana Pérez" };

export interface PracticeRequest {
  n: number; title: string; description: string;
  /** What Ana knows and answers when asked, but did not write in the ticket. */
  hidden: string[];
}

export const REQUESTS: PracticeRequest[] = [
  {
    n: 1,
    title: "Ver las facturas de un período (filtro por fechas)",
    description: [
      "Hola, soy Ana de Administración.",
      "",
      "Cuando corro el listado de facturas (npm start) me salen todas, de todos los meses, y para cerrar el mes tengo que buscar a mano las que me sirven.",
      "Necesitaría poder ver solo las de un período, por ejemplo las de octubre, y que el total de abajo sea el de esas facturas.",
      "",
      "¡Gracias!",
    ].join("\n"),
    hidden: [
      "Quiere indicar una fecha desde y una fecha hasta, las dos incluidas (si pone del 1 al 31 de octubre, entran las del 1 y las del 31).",
      "Las dos son opcionales: solo 'desde' = de esa fecha en adelante; solo 'hasta' = hasta esa fecha; ninguna = todas, como hoy.",
      "Las fechas las escribe como 2026-10-01 (año-mes-día), así figuran en el sistema; no le importa el nombre de la opción (por ejemplo --desde y --hasta está perfecto).",
      "Si escribe mal una fecha quiere un mensaje claro que diga cuál está mal, no un listado vacío.",
      "Si no hay facturas en el período, que lo diga ('No hay facturas en el período') en vez de mostrar un total de 0 sin explicación.",
      "El total de abajo tiene que ser el de las facturas que se muestran.",
      "No necesita exportar a Excel ni filtrar por cliente (eso no es parte de este pedido).",
      "Para dar el visto bueno va a probar el listado de octubre 2026 (del 2026-10-01 al 2026-10-31).",
    ],
  },
  {
    n: 2,
    title: "¿Cuánto le facturamos a cada cliente?",
    description: [
      "Hola de nuevo, me pidieron de Gerencia el total facturado a cada cliente este año.",
      "¿Me lo pueden pasar? No hace falta que cambien nada en el sistema, es una consulta de una vez.",
    ].join("\n"),
    hidden: [
      "Es una consulta puntual: con una tabla cliente → total en el comentario le alcanza; no quiere una función nueva.",
      "'Este año' es 2026. Los montos en pesos, como figuran en las facturas.",
      "Si le preguntan, ordenado de mayor a menor está bien.",
    ],
  },
];

export const request = (n: number) => REQUESTS.find((r) => r.n === n);
export const requestOfKey = (key: string) => request(Number(key.split("-")[1]));

/** The invoices of the module (data/facturas.json). */
export const FACTURAS = [
  { numero: "A-0001", cliente: "Ferretería López", fecha: "2026-08-14", total: 125000 },
  { numero: "A-0002", cliente: "Almacén Don Pedro", fecha: "2026-09-02", total: 48300 },
  { numero: "A-0003", cliente: "Ferretería López", fecha: "2026-09-27", total: 76450 },
  { numero: "A-0004", cliente: "Kiosco La Esquina", fecha: "2026-10-01", total: 15800 },
  { numero: "A-0005", cliente: "Almacén Don Pedro", fecha: "2026-10-09", total: 52000 },
  { numero: "A-0006", cliente: "Ferretería López", fecha: "2026-10-18", total: 98700 },
  { numero: "A-0007", cliente: "Panadería Sol", fecha: "2026-10-31", total: 23150 },
  { numero: "A-0008", cliente: "Kiosco La Esquina", fecha: "2026-11-03", total: 19900 },
  { numero: "A-0009", cliente: "Panadería Sol", fecha: "2026-11-12", total: 31400 },
];

/** Files of the practice project: a real module that the agents read, change and test. */
export function projectFiles(): Record<string, string> {
  return {
    "package.json": JSON.stringify({
      name: "facturas-demo", version: "1.0.0", private: true, type: "module",
      description: "Listado de facturas de Distribuidora Sur (proyecto de práctica de orqen)",
      scripts: { start: "node src/cli.mjs", test: "node --test" },
      engines: { node: ">=20.12" },
    }, null, 2) + "\n",
    "README.md": [
      "# facturas-demo",
      "",
      "Listado de facturas de Distribuidora Sur. Proyecto de práctica del tutorial interactivo de orqen.",
      "",
      "```sh",
      "npm start     # lista las facturas y el total",
      "npm test      # corre los tests (node --test)",
      "```",
      "",
      "- `data/facturas.json`: las facturas (número, cliente, fecha AAAA-MM-DD, total en pesos).",
      "- `src/facturas.mjs`: lectura, total y formato del listado.",
      "- `src/cli.mjs`: el comando `npm start`.",
      "",
    ].join("\n"),
    "data/facturas.json": JSON.stringify(FACTURAS, null, 2) + "\n",
    "src/facturas.mjs": [
      "import { readFileSync } from \"node:fs\";",
      "",
      "/** Lee las facturas de un archivo JSON. */",
      "export function cargarFacturas(archivo) {",
      "  return JSON.parse(readFileSync(archivo, \"utf8\"));",
      "}",
      "",
      "/** Suma los totales. */",
      "export function totalDe(facturas) {",
      "  return facturas.reduce((s, f) => s + f.total, 0);",
      "}",
      "",
      "/** $ 1.234.567 */",
      "export function pesos(n) {",
      "  return \"$ \" + Math.round(n).toString().replace(/\\B(?=(\\d{3})+(?!\\d))/g, \".\");",
      "}",
      "",
      "/** Las líneas del listado: una por factura (ordenadas por fecha) y el total. */",
      "export function listado(facturas) {",
      "  const filas = [...facturas].sort((a, b) => a.fecha.localeCompare(b.fecha))",
      "    .map((f) => `${f.fecha}  ${f.numero}  ${f.cliente.padEnd(20)} ${pesos(f.total).padStart(12)}`);",
      "  return [...filas, \"\", `Total (${facturas.length} facturas): ${pesos(totalDe(facturas))}`];",
      "}",
      "",
    ].join("\n"),
    "src/cli.mjs": [
      "import { fileURLToPath } from \"node:url\";",
      "import { cargarFacturas, listado } from \"./facturas.mjs\";",
      "",
      "const archivo = fileURLToPath(new URL(\"../data/facturas.json\", import.meta.url));",
      "const facturas = cargarFacturas(archivo);",
      "for (const linea of listado(facturas)) console.log(linea);",
      "",
    ].join("\n"),
    "test/facturas.test.mjs": [
      "import { test } from \"node:test\";",
      "import assert from \"node:assert/strict\";",
      "import { listado, pesos, totalDe } from \"../src/facturas.mjs\";",
      "",
      "const facturas = [",
      "  { numero: \"A-1\", cliente: \"Uno\", fecha: \"2026-10-05\", total: 1000 },",
      "  { numero: \"A-2\", cliente: \"Dos\", fecha: \"2026-09-30\", total: 2500 },",
      "];",
      "",
      "test(\"suma los totales\", () => {",
      "  assert.equal(totalDe(facturas), 3500);",
      "  assert.equal(totalDe([]), 0);",
      "});",
      "",
      "test(\"formatea pesos con punto de miles\", () => {",
      "  assert.equal(pesos(1234567), \"$ 1.234.567\");",
      "  assert.equal(pesos(15), \"$ 15\");",
      "});",
      "",
      "test(\"el listado ordena por fecha y termina con el total\", () => {",
      "  const l = listado(facturas);",
      "  assert.match(l[0], /^2026-09-30/);",
      "  assert.match(l.at(-1), /Total \\(2 facturas\\): \\$ 3\\.500/);",
      "});",
      "",
    ].join("\n"),
    ".gitignore": "node_modules/\n",
  };
}

/** Script that "opens" the PR of the practice: there is no GitHub, so the PR is a Markdown file in practica/prs/. */
export const PR_SCRIPT = `#!/usr/bin/env node
// orqen practice: opens the request's PR as a file (DEVEL_PR_COMMAND of the practice project).
// node pr.mjs <dir prs> <key> <branch> <base> <title> <body file>
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
const [dir, key, branch, base, title, body] = process.argv.slice(2);
mkdirSync(dir, { recursive: true });
const file = join(dir, key + ".md");
const text = existsSync(resolve(body)) ? readFileSync(resolve(body), "utf8") : "";
writeFileSync(file, "# " + key + ": " + title + "\\n\\n" + branch + " → " + base + "\\n\\n" + text);
console.log("PR abierto: " + pathToFileURL(file).href);
`;

/** The client's instructions for one answer. */
export function clientPrompt(o: { req: PracticeRequest; title: string; description: string; conversation: string; canApprove: boolean }): string {
  return [
    "Sos Ana Pérez, de Administración de Distribuidora Sur. No sos técnica: usás el listado de facturas (`npm start`) para cerrar el mes.",
    "Le pediste algo al equipo de sistemas en un ticket y ahora te escribieron. Contestás como Ana, en español rioplatense, breve (1 a 5 oraciones), amable y concreta.",
    "",
    "Reglas:",
    "- Respondé solo lo que te preguntan o lo que te piden. Si te hacen preguntas, contestalas con lo que sabés (abajo). Si te preguntan algo que no sabés, decí qué preferirías como usuaria, sin inventar detalles técnicos.",
    "- Si el último mensaje del equipo es solo un aviso que no te pide nada (por ejemplo 'X está analizando este pedido', 'se abrió el PR', 'empezó el desarrollo'), contestá exactamente: NADA",
    o.canApprove
      ? "- Te están entregando el trabajo. Si lo que describen cumple tu pedido (y lo que sabés abajo), contestá empezando con /approve y una frase de agradecimiento. Si le falta algo importante, contestá empezando con /reject y qué falta."
      : "- Todavía no te entregaron nada para aprobar: NO escribas /approve ni /reject.",
    "- No escribas código ni comandos. No firmes el mensaje. No uses comillas alrededor de la respuesta.",
    "",
    "Lo que sabés del pedido (no lo escribiste en el ticket, pero lo contestás si te preguntan):",
    ...o.req.hidden.map((h) => `- ${h}`),
    "",
    `Tu ticket: ${o.title}`,
    o.description,
    "",
    "La conversación hasta ahora (lo último es lo más reciente):",
    o.conversation,
    "",
    "Tu respuesta (o NADA):",
  ].join("\n");
}
