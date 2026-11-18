/**
 * The same tutorial steps, done from the desktop app (orqen-desktop) instead of the terminal.
 * The app shows both: "App" (this file) and "Terminal" (content.ts). `pantalla` is the app screen the step talks
 * about, so the app can offer a button that takes you there.
 */
import type { Idioma } from "../lib/lang.ts";
import type { Bloque, DatosTutorial } from "./content.ts";

export type Pantalla = "pending" | "env" | "connectors";
export interface PasoApp { bloques: Bloque[]; pantalla?: Pantalla }

export function pasosApp(d: DatosTutorial, i: Idioma): Record<string, PasoApp> {
  const tx = (es: string, en: string) => (i === "es" ? es : en);
  const recNum = d.request, sisNum = d.issue, H = d.herramienta, HI = d.herramientaIssues;
  const aprobar = d.gate === "github"
    ? tx("El senior aprueba en el PR de GitHub (Approve o Request changes), igual que siempre.", "The senior approves on the GitHub PR (Approve or Request changes), as always.")
    : tx(`El senior aprueba comentando /approve o /reject motivo en ${H}, igual que siempre.`, `The senior approves by commenting /approve or /reject reason in ${H}, as always.`);

  return {
    welcome: {
      bloques: [
        { t: "p", texto: tx("En la app ves lo mismo que con los comandos `orqen` de la terminal, sin escribir nada.",
          "In the app you see the same as with the `orqen` commands in the terminal, without typing anything.") },
        { t: "h", texto: tx("Dónde está cada cosa", "Where everything is") },
        { t: "ul", items: [
          tx("Arriba, una pestaña por proyecto. El + abre otro proyecto o crea uno nuevo.", "At the top, one tab per project. The + opens another project or creates a new one."),
          tx("A la izquierda, Pendientes (los pedidos y qué sigue en cada uno) y Entornos (lo que está corriendo en tu máquina).",
            "On the left, Pending (the requests and what comes next for each) and Environments (what is running on your machine)."),
          tx("Abajo, el engranaje abre Configuración: Conectores y este Tutorial. A la derecha, las cuotas de IA de tu máquina.",
            "At the bottom, the gear opens Settings: Connectors and this Tutorial. On the right, the AI quotas of your machine."),
        ] },
        { t: "tip", texto: tx("El trabajo del agente (los comandos /orqen:) se sigue haciendo en Claude Code. La app te dice qué comando sigue y lo copiás con un clic.",
          "The agent's work (the /orqen: commands) still happens in Claude Code. The app tells you which command comes next and you copy it with one click.") },
      ],
    },
    words: {
      pantalla: "pending",
      bloques: [
        { t: "p", texto: tx("En la lista de Pendientes cada palabra tiene su lugar:", "In the Pending list each word has its place:") },
        { t: "ul", items: [
          tx(`Request: la clave en azul de cada pedido (por ejemplo ${recNum}).`, `Request: the blue key of each request (for example ${recNum}).`),
          ...(HI ? [tx(`Issue: la etiqueta rosa al lado de la clave (por ejemplo ${sisNum}).`, `Issue: the pink tag next to the key (for example ${sisNum}).`)] : []),
          tx("Etapa: los grupos de la lista, y la fila de etapas arriba del detalle del pedido.", "Stage: the groups of the list, and the row of stages above the request detail."),
          tx("Agente: cuando uno trabaja en un pedido, la fila dice \"Trabajando: <agente>\" con un punto azul que late.",
            "Agent: when one is working on a request, the row says \"Working: <agent>\" with a pulsing blue dot."),
          tx("Carril: la etiqueta gris direct, light o full.", "Lane: the grey tag direct, light or full."),
        ] },
      ],
    },
    map: {
      pantalla: "pending",
      bloques: [
        { t: "p", texto: tx("Elegí un pedido en Pendientes: arriba del detalle está este mismo camino. Las etapas hechas tienen ✓, la actual está resaltada en azul y las que faltan están punteadas.",
          "Pick a request in Pending: above the detail there is this same path. Finished stages have a ✓, the current one is highlighted in blue and the ones left are dotted.") },
        { t: "ul", items: [
          tx("La lista agrupa los pedidos por etapa, en el mismo orden del camino.", "The list groups the requests by stage, in the same order as the path."),
          tx("Un pedido en BLOCKED aparece en amarillo con \"Bloqueado: espera a una persona\".", "A BLOCKED request shows in yellow with \"Blocked: waiting for a person\"."),
          tx("Si vuelve a ANALYSIS (ronda 2), lo ves en el RECORRIDO del pedido.", "If it goes back to ANALYSIS (round 2), you see it in the request HISTORY."),
        ] },
      ],
    },
    next: {
      pantalla: "pending",
      bloques: [
        { t: "p", texto: tx("En el detalle de cada pedido, QUÉ SIGUE te muestra el comando de la etapa en que está. No hace falta la tabla de memoria.",
          "In the detail of each request, WHAT'S NEXT shows the command for the stage it is in. No need to remember the table.") },
        { t: "ol", items: [
          tx("Abrí Pendientes y elegí el pedido.", "Open Pending and pick the request."),
          tx(`En QUÉ SIGUE, hacé clic en la tarjeta (por ejemplo "Analizar" → /orqen:analyze ${recNum}). El comando se copia.`,
            `In WHAT'S NEXT, click the card (for example "Analyze" → /orqen:analyze ${recNum}). The command is copied.`),
          tx("Pegalo en Claude Code. Si empieza con `orqen`, pegalo en la terminal.", "Paste it in Claude Code. If it starts with `orqen`, paste it in the terminal."),
          tx("Cuando la etapa termina, el pedido cambia de grupo solo y QUÉ SIGUE muestra el comando nuevo.", "When the stage ends, the request moves to its new group by itself and WHAT'S NEXT shows the new command."),
        ] },
        { t: "tip", texto: tx(`Las decisiones de las personas (/approve, /reject) se siguen tomando en ${H} o en el PR de GitHub. La app te muestra cuándo el pedido está esperando a alguien.`,
          `People's decisions (/approve, /reject) are still made in ${H} or on the GitHub PR. The app shows you when the request is waiting for someone.`) },
      ],
    },
    pending: {
      pantalla: "pending",
      bloques: [
        { t: "p", texto: tx("Pendientes es la primera pantalla de cada proyecto: `orqen pending` y `orqen status` juntos.",
          "Pending is the first screen of every project: `orqen pending` and `orqen status` together.") },
        { t: "ul", items: [
          tx("Cada fila dice quién tiene que actuar: Espera al analista, Listo para un agente, Espera en el ticket…", "Each row says who has to act: Waiting for the analyst, Ready for an agent, Waiting on the ticket…"),
          tx("El número al lado de Pendientes, en el menú de la izquierda, es cuántos pedidos esperan algo.", "The number next to Pending, in the left menu, is how many requests are waiting for something."),
          tx(`Al elegir uno ves su etapa, QUÉ SIGUE y el RECORRIDO: todo lo que le pasó (lo mismo que orqen status ${recNum}).`,
            `When you pick one you see its stage, WHAT'S NEXT and the HISTORY: everything that happened (the same as orqen status ${recNum}).`),
          tx("Copiar clave copia la clave del pedido. La lista se actualiza sola cada pocos segundos.", "Copy key copies the request key. The list refreshes by itself every few seconds."),
        ] },
        { t: "tip", texto: tx("Si la lista está vacía, todavía no entró ningún pedido en el request. Si dice que no pudo consultarlo, revisá los Conectores (engranaje, abajo).",
          "If the list is empty, no request has arrived on the request yet. If it says it could not query it, check the Connectors (gear, at the bottom).") },
      ],
    },
    analysis: {
      pantalla: "pending",
      bloques: [
        { t: "ol", items: [
          tx("En Pendientes, buscá el pedido: dice \"Espera al analista\".", "In Pending, find the request: it says \"Waiting for the analyst\"."),
          tx(`Elegilo y en QUÉ SIGUE hacé clic en "Analizar (analista, en Claude Code)": se copia /orqen:analyze ${recNum}.`,
            `Pick it and in WHAT'S NEXT click "Analyze (analyst, in Claude Code)": /orqen:analyze ${recNum} is copied.`),
          tx("Pegalo en Claude Code y seguí la conversación con el agente. No hace falta tu nombre: orqen lo toma de tu Git.", "Paste it in Claude Code and follow the conversation with the agent. No need for your name: orqen takes it from your Git."),
          HI ? tx(`Cuando cierra el análisis, en la app el pedido pasa solo a Desarrollo y aparece la etiqueta rosa del issue (${sisNum}).`,
                  `When the analysis closes, the request moves to Development in the app by itself and the pink issue tag (${sisNum}) shows up.`)
            : tx("Cuando cierra el análisis, en la app el pedido pasa solo a Desarrollo.", "When the analysis closes, the request moves to Development in the app by itself."),
        ] },
      ],
    },
    implement: {
      pantalla: "pending",
      bloques: [
        { t: "ol", items: [
          tx("En Pendientes, el pedido está en Desarrollo con \"Listo para un agente\".", "In Pending, the request is in Development with \"Ready for an agent\"."),
          tx(`QUÉ SIGUE → "Implementar" copia /orqen:implement ${sisNum}. Pegalo en Claude Code.`, `WHAT'S NEXT → "Implement" copies /orqen:implement ${sisNum}. Paste it in Claude Code.`),
          tx("Mientras trabaja, la fila muestra \"Trabajando\" con el punto azul, y en Entornos ves lo que levantó.", "While it works, the row shows \"Working\" with the blue dot, and in Environments you see what it started."),
          tx("Si el agente parte el trabajo, en el detalle aparece IMPLEMENTACIÓN con cada parte y su estado: en cola, trabajando, integrada…",
            "If the agent splits the work, the detail shows IMPLEMENTATION with each part and its state: queued, working, integrated…"),
        ] },
      ],
    },
    review: {
      pantalla: "pending",
      bloques: [
        { t: "ul", items: [
          tx("Testing: QUÉ SIGUE ofrece \"Correr testing\" y \"Revisión de e2e\". El RECORRIDO muestra si pasó o si volvió a Desarrollo.",
            "Testing: WHAT'S NEXT offers \"Run testing\" and \"e2e review\". The HISTORY shows whether it passed or went back to Development."),
          tx(`Code review: "Abrir el PR" copia /orqen:pr ${sisNum} y "Code review (senior)" copia /orqen:code-review ${sisNum}.`,
            `Code review: "Open the PR" copies /orqen:pr ${sisNum} and "Code review (senior)" copies /orqen:code-review ${sisNum}.`),
          tx("Arriba del detalle ves la rama del pedido: para abrir el PR tenés que estar en esa rama.", "Above the detail you see the request branch: you must be on that branch to open the PR."),
          aprobar,
        ] },
      ],
    },
    watch: {
      pantalla: "pending",
      bloques: [
        { t: "ul", items: [
          tx("En Pendientes, el pedido que tiene un agente encima muestra \"Trabajando: <agente>\" y un punto azul que late.",
            "In Pending, the request an agent is working on shows \"Working: <agent>\" and a pulsing blue dot."),
          tx("En su detalle, el RECORRIDO suma cada cambio de etapa en el momento, y arriba ves la rama en la que trabaja.",
            "In its detail, the HISTORY adds each stage change as it happens, and above you see the branch it works on."),
          tx("Abajo, en la barra de estado, ves cuántos procesos están prendidos.", "At the bottom, in the status bar, you see how many processes are running."),
        ] },
        { t: "tip", texto: tx("Lo que el agente escribe línea por línea se sigue viendo en Claude Code (Ctrl+O), y los cambios de código con git diff o en tu editor.",
          "What the agent writes line by line is still in Claude Code (Ctrl+O), and the code changes with git diff or in your editor.") },
      ],
    },
    env: {
      pantalla: "env",
      bloques: [
        { t: "p", texto: tx("Entornos, en el menú de la izquierda, es `orqen env status` con botones.", "Environments, in the left menu, is `orqen env status` with buttons.") },
        { t: "ul", items: [
          tx("Cada proceso con su comando, puerto y cuándo se usa; el punto verde dice que está prendido.", "Each process with its command, port and when it is used; the green dot means it is running."),
          tx("Levantar, Levantar todo (con e2e) y Apagar hacen orqen env up, env up --all y env down.", "Start, Start everything (with e2e) and Stop do orqen env up, env up --all and env down."),
          tx("\"ver log\" muestra el log de ese proceso en vivo, sin abrir otra terminal.", "\"view log\" shows that process log live, without opening another terminal."),
          tx("El número al lado de Entornos en el menú es cuántos están corriendo.", "The number next to Environments in the menu is how many are running."),
        ] },
        { t: "tip", texto: tx("Si algo no prende, abrí su log acá: las últimas líneas suelen decir por qué.", "If something does not start, open its log here: the last lines usually say why.") },
      ],
    },
    problems: {
      bloques: [
        { t: "ul", items: [
          tx("Un pedido en BLOCKED aparece en amarillo. En su RECORRIDO está el motivo, y QUÉ SIGUE te dice cómo destrabarlo.",
            "A BLOCKED request shows in yellow. Its HISTORY has the reason, and WHAT'S NEXT tells you how to unblock it."),
          tx("Pendientes dice que no pudo consultar el request → engranaje → Conectores → Probar conexión.",
            "Pending says it could not query the request → gear → Connectors → Test connection."),
          tx("Algo del entorno no prende → Entornos → ver log de ese proceso.", "Part of the environment does not start → Environments → view log of that process."),
          tx("Un proyecto sin orqen se abre con un asistente para inicializarlo (lo mismo que orqen init).", "A project without orqen opens with a wizard to set it up (the same as orqen init)."),
          tx("Las cuotas de IA (abajo a la derecha) te avisan antes de quedarte sin uso en Claude Code o Codex.", "The AI quotas (bottom right) warn you before you run out of usage in Claude Code or Codex."),
        ] },
      ],
    },
    cheatsheet: {
      bloques: [
        { t: "pre", lineas: [
          tx(" MIRAR (app)", " LOOK (app)"),
          tx("   Pendientes            qué hay para hacer, etapa y recorrido de cada pedido", "   Pending               what needs doing, stage and history of each request"),
          tx("   Entornos              qué está prendido, levantar / apagar, log en vivo", "   Environments          what is running, start / stop, live log"),
          tx("   Engranaje > Conectores  tickets y credenciales, probar la conexión", "   Gear > Connectors     tickets and credentials, test the connection"),
          "",
          tx(" TRABAJAR (Claude Code)", " WORK (Claude Code)"),
          tx("   QUÉ SIGUE             un clic copia el comando; pegalo en Claude Code", "   WHAT'S NEXT           one click copies the command; paste it in Claude Code"),
          "",
          tx(` DECIDIR (${H} / GitHub)`, ` DECIDE (${H} / GitHub)`),
          tx("   /approve   /reject motivo     comentario en el request", "   /approve   /reject reason     comment on the request"),
        ] },
      ],
    },
  };
}
