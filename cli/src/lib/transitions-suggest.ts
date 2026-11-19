/**
 * orqen state → project column, proposed from the column names of a GitHub Project (the "Status" field), so a ticket moves
 * without anyone writing `transitions` by hand. Only states with a clear match are proposed; the person can edit the rest
 * in orqen/config.yaml. Names are matched in English and Spanish.
 */
type Role = "requests" | "issues";

const MATCH: Record<string, RegExp> = {
  progress: /progress|doing|working|curso|desarrollo|haciendo/i,
  review: /review|revis|accept|valid|aprob|testing|qa\b/i,
  done: /^(done|closed|complete|completed|finished|shipped|released|hecho|cerrado|listo|resuelto|terminado|finalizado|completado)$/i,
};

/** First column whose name matches; columns are in the order of the project, so "In progress" wins over "Progress report". */
const find = (columns: string[], kind: keyof typeof MATCH) => columns.find((c) => MATCH[kind].test(c.trim()));

export function suggestTransitions(role: Role, columns: string[]): Record<string, string> {
  const progress = find(columns, "progress"), review = find(columns, "review"), done = find(columns, "done");
  const pairs: Array<[string, string | undefined]> = role === "requests"
    ? [["ANALYSIS", progress], ["ACCEPTANCE", review], ["CLOSED", done], ["CANCELLED", done]]
    : [["DEVELOPMENT", progress], ["TESTING", progress], ["QA_REVIEW", review], ["CODE_REVIEW", review], ["CLOSED", done], ["CANCELLED", done]];
  return Object.fromEntries(pairs.filter((p): p is [string, string] => !!p[1]));
}

export const showTransitions = (t: Record<string, string>) => Object.entries(t).map(([s, c]) => `${s} → ${c}`).join(" · ");
