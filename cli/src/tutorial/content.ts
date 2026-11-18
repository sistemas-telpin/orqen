/**
 * Tutorial content: short steps in plain words, in Spanish or English, filled with this repository's data.
 * One structure for both languages: tx(es, en) picks the text. Rendered for the terminal and as Markdown (render.ts).
 */
import type { Idioma } from "../lib/lang.ts";

export type Bloque =
  | { t: "p"; texto: string }                      // paragraph
  | { t: "h"; texto: string }                      // small heading ("[Claude Code] Type:")
  | { t: "cmd"; lineas: string[] }                 // commands to type (may carry "# comment")
  | { t: "ul"; items: string[] }                   // bullets
  | { t: "ol"; items: string[] }                   // numbered list
  | { t: "pre"; lineas: string[] }                 // fixed-width block (diagram, table)
  | { t: "tip"; texto: string };                   // highlighted note

export interface Paso {
  id: string;
  titulo: string;
  bloques: Bloque[];
  /** Read-only commands the person can try from the tutorial. */
  demo?: string[];
}

export interface ProcesoTutorial { nombre: string; comando: string; puerto?: number | null; url?: string | null; cuando: "siempre" | "e2e" }

export interface DatosTutorial {
  proyecto: string;
  procesos: ProcesoTutorial[];
  tests: string[];
  externo: string;        // example key of an external ticket (what the client sees), e.g. SOP-123
  interno: string;        // example key of an internal ticket; without internal connector, the external key
  herramienta: string;    // where the external ticket lives: Jira, GitHub, Asana
  herramientaInterna?: string; // where the internal ticket lives (absent: no internal ticket)
  soporte: boolean;       // SUPPORT_STAGE=on
  gate: "github" | "ticket";
  ramaDevel: string;
  windows: boolean;
  db: boolean;            // orqen/tools/db.mjs exists
  conectado: boolean;     // external connector configured
}

export const TEMAS = ["welcome", "words", "map", "next", "pending", "analysis", "implement", "review", "watch", "env", "problems", "cheatsheet"] as const;

export function textosUi(i: Idioma) {
  const tx = (es: string, en: string) => (i === "es" ? es : en);
  return {
    paso: (n: number, total: number) => tx(`Paso ${n} de ${total}`, `Step ${n} of ${total}`),
    siguiente: tx("Siguiente paso", "Next step"),
    anterior: tx("Paso anterior", "Previous step"),
    probar: tx("Probalo ahora", "Try it now"),
    menu: tx("Ir a otro tema", "Go to another topic"),
    salir: tx("Salir del tutorial", "Exit the tutorial"),
    elegirTema: tx("¿Qué tema querés ver?", "Which topic do you want to see?"),
    queHacer: tx("¿Cómo seguimos?", "What next?"),
    fin: tx("Terminaste el tutorial. Para empezar a trabajar: orqen pending", "You finished the tutorial. To start working: orqen pending"),
    sinOrqen: tx("Este repositorio todavía no tiene orqen. Corré `orqen init` en la carpeta del proyecto y volvé a intentar.",
      "This repository does not have orqen yet. Run `orqen init` in the project folder and try again."),
    temaInvalido: (t: string) => tx(`No existe el paso "${t}". Opciones: 1-${TEMAS.length} o ${TEMAS.join(", ")}.`,
      `There is no step "${t}". Options: 1-${TEMAS.length} or ${TEMAS.join(", ")}.`),
  };
}

export function pasosTutorial(d: DatosTutorial, i: Idioma): Paso[] {
  const tx = (es: string, en: string) => (i === "es" ? es : en);
  const TERM = tx("[Terminal] Escribí:", "[Terminal] Type:");
  const CC = tx("[Claude Code] Escribí:", "[Claude Code] Type:");
  const LISTO = tx("Cómo sabés que terminó", "How you know it is done");
  const siempre = d.procesos.filter((p) => p.cuando === "siempre");
  const e2e = d.procesos.filter((p) => p.cuando === "e2e");
  const nombres = (ps: ProcesoTutorial[]) => ps.map((p) => p.nombre).join(", ");
  const donde = (p: ProcesoTutorial) => p.url ?? (p.puerto ? `http://localhost:${p.puerto}` : "");
  const unLog = d.procesos[0]?.nombre ?? tx("<nombre>", "<name>");
  const seguirLog = d.windows
    ? `Get-Content orqen\\state\\logs\\${unLog}.log -Wait -Tail 50`
    : `tail -f orqen/state/logs/${unLog}.log`;
  const recNum = d.externo, sisNum = d.interno, H = d.herramienta, HI = d.herramientaInterna;

  const pasos: Paso[] = [
    {
      id: "welcome",
      titulo: tx("Bienvenida", "Welcome"),
      bloques: [
        { t: "p", texto: tx(
          `Este tutorial te muestra, paso a paso, cómo se trabaja con orqen en este proyecto (${d.proyecto}). Son ${TEMAS.length} pasos cortos.`,
          `This tutorial shows you, step by step, how to work with orqen in this project (${d.proyecto}). It has ${TEMAS.length} short steps.`) },
        { t: "p", texto: tx(
          `orqen lleva un pedido del cliente desde que entra en ${H} hasta que se entrega. Vos tomás las decisiones. Un agente de IA (Claude) hace el trabajo pesado: lee, escribe código y corre los tests.`,
          `orqen takes a customer request from the moment it arrives in ${H} until it is delivered. You make the decisions. An AI agent (Claude) does the heavy lifting: it reads, writes code, and runs the tests.`) },
        { t: "h", texto: tx("Vas a usar dos lugares", "You will use two places") },
        { t: "ul", items: [
          tx("La terminal: ahí escribís comandos que empiezan con `orqen` (por ejemplo `orqen status`). Sirven para mirar cómo están las cosas.",
            "The terminal: there you type commands that start with `orqen` (for example `orqen status`). They show you how things are."),
          tx("Claude Code: ahí escribís comandos que empiezan con `/orqen:` (por ejemplo `/orqen:analyze`). Esos le dan trabajo al agente.",
            "Claude Code: there you type commands that start with `/orqen:` (for example `/orqen:analyze`). Those give work to the agent."),
        ] },
        { t: "tip", texto: tx("No tenés que memorizar nada: el último paso es un machete con todo.", "You do not need to memorize anything: the last step is a cheat sheet with everything.") },
      ],
    },
    {
      id: "words",
      titulo: tx("5 palabras que vas a escuchar", "5 words you will hear"),
      bloques: [
        { t: "ul", items: [
          tx(`Ticket externo: el pedido del cliente en ${H} (por ejemplo ${recNum}). Es lo que ve el cliente y donde se habla con él.`,
            `External ticket: the customer request in ${H} (for example ${recNum}). It is what the customer sees and where you talk to them.`),
          ...(HI ? [tx(`Ticket interno: la tarea del equipo que nace cuando se analiza el pedido (por ejemplo ${sisNum}, en ${HI}). Ahí se sigue el trabajo técnico; el cliente no la ve.`,
            `Internal ticket: the team's task created when the request is analyzed (for example ${sisNum}, in ${HI}). It tracks the technical work; the customer does not see it.`)] : []),
          tx("Etapa: dónde está el pedido ahora (análisis, desarrollo, testing…). Un pedido está en una sola etapa por vez.",
            "Stage: where the request is right now (analysis, development, testing…). A request is in one stage at a time."),
          tx("Agente: Claude trabajando en este repo. Propone, te pregunta y espera tu OK antes de cada paso importante.",
            "Agent: Claude working in this repository. It proposes, asks you, and waits for your OK before each important step."),
          tx("Carril: qué tan grande es el cambio. direct = chico, light = mediano, full = grande. Lo elige el analista.",
            "Lane: how big the change is. direct = small, light = medium, full = large. The analyst picks it."),
        ] },
        ...(HI ? [{ t: "tip" as const, texto: tx("Casi todos los comandos aceptan la clave del ticket externo o la del interno: usá la que tengas a mano.",
          "Almost every command accepts either the external or the internal ticket key: use whichever you have.") }] : []),
      ],
    },
    {
      id: "map",
      titulo: tx("El camino de un pedido", "The path of a request"),
      bloques: [
        { t: "p", texto: tx("Cada pedido pasa por estas etapas, en este orden:", "Every request goes through these stages, in this order:") },
        { t: "pre", lineas: [
          ...(d.soporte ? [tx(" 0. SUPPORT      soporte intenta responder sin programar      → persona + agente",
                              " 0. SUPPORT      support tries to answer without coding        → person + agent")] : []),
          tx(" 1. ANALYSIS     se entiende qué pide el cliente               → analista + agente",
             " 1. ANALYSIS     understand what the customer asks for         → analyst + agent"),
          tx(" 2. DEVELOPMENT  se escribe el código y los tests              → agente (vos aprobás)",
             " 2. DEVELOPMENT  write the code and the tests                  → agent (you approve)"),
          tx(" 3. TESTING      se corren todos los tests                     → automático",
             " 3. TESTING      run every test                                → automatic"),
          tx(" 4. CODE_REVIEW  se abre el PR y un senior lo revisa           → personas",
             " 4. CODE_REVIEW  open the PR and a senior reviews it           → people"),
          tx(" 5. DELIVERY     se preparan las notas para el cliente         → automático",
             " 5. DELIVERY     prepare the notes for the customer            → automatic"),
          tx(" 6. ACCEPTANCE   el cliente dice si está bien                  → cliente",
             " 6. ACCEPTANCE   the customer says whether it is right         → customer"),
          tx(" 7. CLOSED       terminado", " 7. CLOSED       done"),
        ] },
        { t: "ul", items: [
          tx("Si algo no puede seguir, el pedido queda en BLOCKED hasta que una persona lo destrabe.",
            "If something cannot go on, the request goes to BLOCKED until a person unblocks it."),
          tx("Si el cliente rechaza la entrega, el pedido vuelve a ANALYSIS (se llama ronda 2).",
            "If the customer rejects the delivery, the request goes back to ANALYSIS (this is called round 2)."),
        ] },
      ],
    },
    {
      id: "next",
      titulo: tx("Cómo se pasa a la etapa siguiente", "How a request moves to the next stage"),
      bloques: [
        { t: "p", texto: tx("Es lo más importante del tutorial. Un pedido avanza únicamente de dos maneras:",
          "This is the most important part of the tutorial. A request moves on in only two ways:") },
        { t: "ol", items: [
          tx("Termina una etapa del agente: con tu OK, el agente corre `orqen complete`. orqen revisa que esté todo bien y lo pasa a la etapa siguiente.",
            "An agent stage ends: with your OK, the agent runs `orqen complete`. orqen checks that everything is right and moves it to the next stage."),
          tx(`Una persona decide: aprueba o rechaza en ${H} (comentando \`/approve\` o \`/reject motivo\`) o en el PR de GitHub.`,
            `A person decides: approves or rejects in ${H} (commenting \`/approve\` or \`/reject reason\`) or on the GitHub PR.`),
        ] },
        { t: "h", texto: tx("Qué hacer en cada etapa", "What to do in each stage") },
        { t: "pre", lineas: [
          tx(" Etapa         Quién        Qué hacer", " Stage         Who          What to do"),
          ...(d.soporte ? [tx(` SUPPORT       soporte      /orqen:support ${recNum}`, ` SUPPORT       support      /orqen:support ${recNum}`)] : []),
          tx(` ANALYSIS      analista     /orqen:analyze ${recNum}`, ` ANALYSIS      analyst      /orqen:analyze ${recNum}`),
          tx(` DEVELOPMENT   desarrollo   /orqen:implement ${sisNum}`, ` DEVELOPMENT   developer    /orqen:implement ${sisNum}`),
          tx(` TESTING       nadie        automático (o pedile a Claude: "procesá el ${recNum}")`,
             ` TESTING       nobody       automatic (or ask Claude: "process ${recNum}")`),
          tx(` CODE_REVIEW   desarrollo   /orqen:pr ${sisNum}  (abre el PR)`, ` CODE_REVIEW   developer    /orqen:pr ${sisNum}  (opens the PR)`),
          d.gate === "github"
            ? tx(`               senior       /orqen:code-review ${sisNum}, después Approve en GitHub`, `               senior       /orqen:code-review ${sisNum}, then Approve on GitHub`)
            : tx(`               senior       /orqen:code-review ${sisNum}, después /approve en ${H}`, `               senior       /orqen:code-review ${sisNum}, then /approve in ${H}`),
          tx(" DELIVERY      nadie        automático", " DELIVERY      nobody       automatic"),
          tx(` ACCEPTANCE    cliente      /approve o /reject en ${H}`, ` ACCEPTANCE    customer     /approve or /reject in ${H}`),
          tx(` BLOCKED       aprobador    /approve <qué hacer> en ${H}`, ` BLOCKED       approver     /approve <what to do> in ${H}`),
        ] },
        { t: "tip", texto: tx(
          `Cada comando /orqen: hace UNA etapa y se detiene. Al final te dice qué sigue y quién lo hace. Si no sabés en qué etapa está un pedido: orqen status ${recNum}`,
          `Each /orqen: command does ONE stage and stops. At the end it tells you what comes next and who does it. If you do not know which stage a request is in: orqen status ${recNum}`) },
      ],
    },
    {
      id: "pending",
      titulo: tx("Ver qué hay para hacer", "See what needs doing"),
      bloques: [
        { t: "p", texto: tx("Antes de arrancar, fijate qué pedidos están esperando algo.", "Before you start, check which requests are waiting for something.") },
        { t: "h", texto: TERM },
        { t: "cmd", lineas: [
          tx("orqen pending              # pedidos que esperan algo, agrupados por quién tiene que actuar", "orqen pending              # requests waiting for something, grouped by who has to act"),
          tx("orqen status               # todos los pedidos de este repo y su etapa", "orqen status               # every request in this repository and its stage"),
          tx(`orqen status ${recNum.padEnd(13)} # un pedido: etapa, quién lo tiene y todo lo que le pasó`, `orqen status ${recNum.padEnd(13)} # one request: stage, who has it, and everything that happened`),
        ] },
        { t: "tip", texto: tx("Si `orqen status` no muestra nada, todavía no pasó ningún pedido por orqen en esta copia del repo. Es normal al principio.",
          "If `orqen status` shows nothing, no request has gone through orqen in this copy of the repository yet. That is normal at first.") },
      ],
      demo: ["orqen status", ...(d.conectado ? ["orqen pending", "orqen connectors"] : [])],
    },
    {
      id: "analysis",
      titulo: tx("Analizar un pedido (analista)", "Analyze a request (analyst)"),
      bloques: [
        { t: "h", texto: CC },
        { t: "cmd", lineas: [`/orqen:analyze ${recNum}`] },
        { t: "h", texto: tx("Qué va a pasar", "What will happen") },
        { t: "ol", items: [
          tx("El agente toma el pedido y lee el ticket externo, sus comentarios y el código.", "The agent takes the request and reads the external ticket, its comments, and the code."),
          tx("Te hace preguntas para entender bien qué hay que hacer. Contestá con tus palabras o elegí una opción.", "It asks you questions to understand what needs doing. Answer in your own words or pick an option."),
          tx("Te muestra un resumen: qué hay que hacer y cómo se va a probar. Si está bien, decile que sí.", "It shows you a summary: what needs doing and how it will be tested. If it is right, say yes."),
          tx("Te propone un carril (direct, light o full). Confirmalo o cambialo.", "It proposes a lane (direct, light, or full). Confirm it or change it."),
          tx("Si es light o full, escriben juntos la especificación: qué tiene que hacer el sistema.", "For light or full, you write the specification together: what the system must do."),
          HI ? tx(`Con tu OK, cierra el análisis: orqen crea el ticket interno en ${HI} y lo vincula al pedido.`, `With your OK, it closes the analysis: orqen creates the internal ticket in ${HI} and links it to the request.`)
            : tx("Con tu OK, cierra el análisis y se lo cuenta al cliente en el ticket.", "With your OK, it closes the analysis and tells the customer on the ticket."),
        ] },
        { t: "h", texto: LISTO },
        { t: "p", texto: HI ? tx(`El agente te dice algo como "Listo. Se creó ${sisNum}. Sigue DEVELOPMENT." Esa clave es la que usa desarrollo.`,
          `The agent says something like "Done. ${sisNum} was created. Next: DEVELOPMENT." Developers use that key.`)
          : tx(`El agente te dice algo como "Listo. Sigue DEVELOPMENT." Desarrollo usa la misma clave ${recNum}.`,
          `The agent says something like "Done. Next: DEVELOPMENT." Developers use the same key ${recNum}.`) },
        { t: "tip", texto: d.soporte
          ? tx(`En este proyecto hay soporte: los pedidos nuevos pasan primero por /orqen:support ${recNum}. Si soporte no puede responderle al cliente, te lo pasa con un resumen.`,
               `This project has support: new requests go first through /orqen:support ${recNum}. If support cannot answer the customer, it hands it to you with a summary.`)
          : tx(`Si el pedido es una consulta que se responde sin tocar código, soporte puede atenderlo antes con /orqen:support ${recNum}.`,
               `If the request is a question that can be answered without touching code, support can handle it first with /orqen:support ${recNum}.`) },
      ],
    },
    {
      id: "implement",
      titulo: tx("Implementar (desarrollo)", "Implement (developer)"),
      bloques: [
        { t: "h", texto: CC },
        { t: "cmd", lineas: [`/orqen:implement ${sisNum}`] },
        { t: "h", texto: tx("Qué va a pasar", "What will happen") },
        { t: "ol", items: [
          siempre.length
            ? tx(`orqen prepara todo solo: cambia a la rama del pedido, instala dependencias y levanta ${nombres(siempre)}. No tenés que abrir nada a mano.`,
                 `orqen sets everything up: it switches to the request branch, installs dependencies, and starts ${nombres(siempre)}. You do not have to start anything by hand.`)
            : tx("orqen prepara todo solo: cambia a la rama del pedido e instala dependencias. No tenés que abrir nada a mano.",
                 "orqen sets everything up: it switches to the request branch and installs dependencies. You do not have to start anything by hand."),
          tx("El agente te muestra su plan: qué archivos va a tocar y qué tests va a escribir. Leelo y decile OK, o qué cambiar.", "The agent shows you its plan: which files it will change and which tests it will write. Read it and say OK, or what to change."),
          tx("Escribe el código y los tests. Te va contando a medida que termina cada parte.", "It writes the code and the tests, and tells you as it finishes each part."),
          tx("Corre los tests. Si algo falla, lo arregla.", "It runs the tests. If something fails, it fixes it."),
          tx("Te muestra un resumen y te pide OK para cerrar la etapa.", "It shows you a summary and asks for your OK to close the stage."),
          tx("Con tu OK, orqen revisa que esté todo hecho, apaga lo que levantó y pasa el pedido a TESTING.", "With your OK, orqen checks that everything is done, stops what it started, and moves the request to TESTING."),
        ] },
        { t: "h", texto: LISTO },
        { t: "p", texto: tx('El agente te dice "Sigue TESTING". Ahí termina tu parte por ahora.', 'The agent says "Next: TESTING". Your part ends there for now.') },
        { t: "tip", texto: tx("Si el pedido vuelve con cambios pedidos (de testing o del senior), corré el mismo comando: el agente arranca por lo que hay que corregir.",
          "If the request comes back with requested changes (from testing or the senior), run the same command: the agent starts with what needs fixing.") },
      ],
    },
    {
      id: "review",
      titulo: tx("Testing, PR y revisión", "Testing, PR, and review"),
      bloques: [
        { t: "h", texto: tx("1. Testing (automático)", "1. Testing (automatic)") },
        { t: "p", texto: tx(
          `orqen levanta todo el proyecto${e2e.length ? ` (también ${nombres(e2e)})` : ""}, corre todos los tests (también la regresión e2e completa) y lo apaga. Si pasan, sigue QA (solo carril completo) o CODE_REVIEW. Si fallan, vuelve a DEVELOPMENT.`,
          `orqen starts the whole project${e2e.length ? ` (including ${nombres(e2e)})` : ""}, runs every test (including the full e2e regression), and stops it. If they pass, next is QA (full lane only) or CODE_REVIEW. If they fail, it goes back to DEVELOPMENT.`) },
        { t: "h", texto: tx("2. Abrir el PR (desarrollo)", "2. Open the PR (developer)") },
        { t: "cmd", lineas: [`/orqen:pr ${sisNum}`] },
        { t: "p", texto: tx(`Tenés que estar en la rama del pedido. El agente escribe la explicación y orqen sube los cambios y abre el PR contra ${d.ramaDevel}.`,
          `You must be on the request branch. The agent writes the explanation, and orqen pushes the changes and opens the PR against ${d.ramaDevel}.`) },
        { t: "h", texto: tx("3. QA (solo carril completo)", "3. QA (full lane only)") },
        { t: "cmd", lineas: [`/orqen:review ${sisNum}`] },
        { t: "p", texto: tx("QA mira en pantalla los e2e del cambio y aprueba (sigue el senior) o pide cambios (vuelve a desarrollo). Los carriles directo y liviano no pasan por QA.",
          "QA checks the e2e of the change on screen and approves (the senior is next) or requests changes (it goes back to development). The direct and light lanes skip QA.") },
        { t: "h", texto: tx("4. Code review (senior)", "4. Code review (senior)") },
        { t: "cmd", lineas: [`/orqen:code-review ${sisNum}`] },
        { t: "p", texto: d.gate === "github"
          ? tx("El agente revisa el PR y le da al senior un informe. Después el senior entra al PR en GitHub y pone Approve (sigue la entrega) o Request changes (vuelve a desarrollo con sus comentarios).",
               "The agent reviews the PR and gives the senior a report. Then the senior opens the PR on GitHub and clicks Approve (delivery comes next) or Request changes (it goes back to development with the comments).")
          : tx(`El agente revisa el PR y le da al senior un informe. Después el senior comenta en ${H} /approve (sigue la entrega) o /reject motivo (vuelve a desarrollo).`,
               `The agent reviews the PR and gives the senior a report. Then the senior comments /approve (delivery comes next) or /reject reason (back to development) in ${H}.`) },
      ],
    },
    {
      id: "watch",
      titulo: tx("Mirar qué está haciendo el agente", "Watch what the agent is doing"),
      bloques: [
        { t: "h", texto: tx("En Claude Code", "In Claude Code") },
        { t: "ul", items: [
          tx("El agente te cuenta qué va a hacer y espera tu OK. Leé antes de aceptar.", "The agent tells you what it will do and waits for your OK. Read before you accept."),
          tx("Ctrl+O muestra u oculta el detalle: los comandos que corrió y lo que respondieron.", "Ctrl+O shows or hides the details: the commands it ran and their output."),
          tx("Esc lo frena en el momento. Después le escribís qué querés que haga.", "Esc stops it right away. Then you type what you want it to do."),
        ] },
        { t: "h", texto: tx("[Terminal] En otra terminal, mientras trabaja:", "[Terminal] In another terminal, while it works:") },
        { t: "cmd", lineas: [
          tx(`orqen status ${sisNum.padEnd(10)} # en qué etapa está y qué le pasó`, `orqen status ${sisNum.padEnd(10)} # which stage it is in and what happened`),
          tx("git status                # qué archivos está cambiando", "git status                # which files it is changing"),
          tx("git diff                  # los cambios, línea por línea", "git diff                  # the changes, line by line"),
        ] },
        { t: "ul", items: [
          tx(`El historial del pedido también queda en el archivo orqen/work/${recNum}/log.md.`, `The request history is also in the file orqen/work/${recNum}/log.md.`),
          tx("Si el carril es light o full, en openspec/changes/<nombre>/tasks.md ves qué tareas ya tildó.", "With the light or full lane, openspec/changes/<name>/tasks.md shows which tasks it has checked off."),
          tx("En modo automático (orqen cycle --loop), lo que hace el agente se ve en la terminal donde corre ese comando.", "In automatic mode (orqen cycle --loop), what the agent does shows up in the terminal where that command runs."),
        ] },
      ],
      demo: ["orqen status", "git status"],
    },
    {
      id: "env",
      titulo: tx("Mirar los entornos que levantó", "Look at the environments it started"),
      bloques: [
        { t: "p", texto: tx("Entorno = las partes del proyecto corriendo en tu máquina (backend, front, base de datos). orqen las prende y las apaga solo cuando hace falta.",
          "Environment = the parts of the project running on your machine (backend, frontend, database). orqen starts and stops them by itself when needed.") },
        ...(d.procesos.length
          ? [
              { t: "h", texto: tx("Este proyecto tiene:", "This project has:") } as Bloque,
              { t: "pre", lineas: d.procesos.map((p) => ` ${p.nombre.padEnd(12)} ${(donde(p) || p.comando).padEnd(28)} ${p.cuando === "e2e" ? tx("(solo para tests e2e)", "(e2e tests only)") : tx("(desarrollo y tests)", "(development and tests)")}`) } as Bloque,
            ]
          : [{ t: "p", texto: tx("Todavía no hay partes configuradas en orqen/config.yaml (entornos.procesos). Pedile al equipo que las agregue.",
              "No parts are configured in orqen/config.yaml yet (entornos.procesos). Ask the team to add them.") } as Bloque]),
        { t: "h", texto: tx("[Terminal] Ver qué está corriendo:", "[Terminal] See what is running:") },
        { t: "cmd", lineas: ["orqen env status"] },
        { t: "p", texto: tx("● = prendido, ○ = apagado. Debajo de cada uno aparece dónde está su log (lo que va escribiendo).",
          "● = running, ○ = stopped. Under each one you see where its log is (what it prints).") },
        { t: "h", texto: tx(`Ver el log en vivo${d.windows ? " (PowerShell)" : ""} — para salir, Ctrl+C:`, `Follow the log live${d.windows ? " (PowerShell)" : ""} — Ctrl+C to quit:`) },
        { t: "cmd", lineas: [seguirLog] },
        { t: "h", texto: tx("Prenderlo y apagarlo vos:", "Start and stop it yourself:") },
        { t: "cmd", lineas: [
          tx("orqen env up        # prende todo (agregá --all para incluir lo de e2e)", "orqen env up        # starts everything (add --all to include the e2e parts)"),
          tx("orqen env test      # corre los tests", "orqen env test      # runs the tests"),
          tx("orqen env down      # apaga todo lo que prendió orqen", "orqen env down      # stops everything orqen started"),
          ...(d.db ? [tx("node orqen/tools/db.mjs status   # la base de datos (corre en Docker)", "node orqen/tools/db.mjs status   # the database (runs in Docker)")] : []),
        ] },
        { t: "tip", texto: tx("Si algo no prende, mirá el final de su log. El agente también lo ve y te pregunta qué hacer.",
          "If something does not start, look at the end of its log. The agent sees it too and asks you what to do.") },
      ],
      demo: ["orqen env status", ...(d.db ? ["node orqen/tools/db.mjs status"] : [])],
    },
    {
      id: "problems",
      titulo: tx("Si algo sale mal", "If something goes wrong"),
      bloques: [
        { t: "ul", items: [
          tx("El agente hace algo que no querés → Esc, y escribile qué querés.", "The agent does something you do not want → Esc, and tell it what you want."),
          tx(`No sabés en qué etapa está un pedido → orqen status ${recNum}`, `You do not know which stage a request is in → orqen status ${recNum}`),
          tx(`Dice que el pedido lo tiene otra persona → esperá. Si nadie lo está usando: orqen release ${recNum}`, `It says someone else has the request → wait. If nobody is using it: orqen release ${recNum}`),
          tx(`El pedido quedó en BLOCKED → orqen status ${recNum} te dice por qué. Un aprobador lo destraba comentando /approve <qué hacer> en ${H}.`,
            `The request is BLOCKED → orqen status ${recNum} tells you why. An approver unblocks it by commenting /approve <what to do> in ${H}.`),
          tx("Algo del entorno no prende → orqen env status y mirá su log. Si el puerto está ocupado, cerrá lo que lo está usando.", "Part of the environment does not start → orqen env status and read its log. If the port is busy, close whatever is using it."),
          tx('No aparecen los comandos /orqen: en Claude Code → cerralo, abrilo en la carpeta del repo y aceptá "Trust this folder". Si sigue igual: orqen update.',
            'The /orqen: commands do not show up in Claude Code → close it, open it in the repository folder, and accept "Trust this folder". If that does not help: orqen update.'),
        ] },
      ],
    },
    {
      id: "cheatsheet",
      titulo: tx("Machete", "Cheat sheet"),
      bloques: [
        { t: "pre", lineas: [
          tx(" MIRAR (terminal)", " LOOK (terminal)"),
          tx("   orqen pending                 qué hay para hacer", "   orqen pending                 what needs doing"),
          tx(`   orqen status ${recNum.padEnd(16)} en qué etapa está`, `   orqen status ${recNum.padEnd(16)} which stage it is in`),
          tx("   orqen env status              qué está prendido y dónde está su log", "   orqen env status              what is running and where its log is"),
          tx("   git status / git diff         qué está cambiando el agente", "   git status / git diff         what the agent is changing"),
          "",
          tx(" TRABAJAR (Claude Code)", " WORK (Claude Code)"),
          ...(d.soporte ? [tx(`   /orqen:support ${recNum.padEnd(14)} soporte`, `   /orqen:support ${recNum.padEnd(14)} support`)] : []),
          tx(`   /orqen:analyze ${recNum.padEnd(14)} analista`, `   /orqen:analyze ${recNum.padEnd(14)} analyst`),
          tx(`   /orqen:implement ${sisNum.padEnd(12)} desarrollo`, `   /orqen:implement ${sisNum.padEnd(12)} developer`),
          tx(`   /orqen:pr ${sisNum.padEnd(19)} desarrollo (abre el PR)`, `   /orqen:pr ${sisNum.padEnd(19)} developer (opens the PR)`),
          tx(`   /orqen:review ${sisNum.padEnd(15)} QA (carril completo)`, `   /orqen:review ${sisNum.padEnd(15)} QA (full lane)`),
          tx(`   /orqen:code-review ${sisNum.padEnd(10)} senior`, `   /orqen:code-review ${sisNum.padEnd(10)} senior`),
          "",
          tx(` DECIDIR (${H} / GitHub)`, ` DECIDE (${H} / GitHub)`),
          tx("   /approve   /reject motivo     comentario en el ticket externo", "   /approve   /reject reason     comment on the external ticket"),
          ...(d.gate === "github" ? [tx("   Approve / Request changes     review en el PR de GitHub (senior)", "   Approve / Request changes     review on the GitHub PR (senior)")] : []),
          "",
          tx(" ENTORNO (terminal)", " ENVIRONMENT (terminal)"),
          tx("   orqen env up | test | down    prender, testear, apagar", "   orqen env up | test | down    start, test, stop"),
        ] },
        { t: "tip", texto: tx("Para repetir un paso: /orqen:tutorial <tema> (por ejemplo /orqen:tutorial env). Para empezar a trabajar: orqen pending.",
          "To repeat a step: /orqen:tutorial <topic> (for example /orqen:tutorial env). To start working: orqen pending.") },
      ],
    },
  ];
  return pasos;
}
