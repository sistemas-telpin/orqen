/** Static checks for proposed SQL before human approval. */

const sinRuido = (sql: string) =>
  sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ").replace(/'(?:[^']|'')*'/g, "''");

/** Return any problems found. */
export function revisarSql(sql: string, etiqueta = "script_sql"): string[] {
  const err: string[] = [];
  const sentencias = sinRuido(sql).split(/;|^\s*GO\s*$/gim).map((s) => s.trim()).filter(Boolean);
  for (const s of sentencias) {
    const u = s.toUpperCase();
    const corto = s.replace(/\s+/g, " ").slice(0, 80);
    if (/\b(DROP|TRUNCATE)\b/.test(u)) err.push(`${etiqueta}: DROP and TRUNCATE are prohibited ("${corto}")`);
    if (/\b(UPDATE|DELETE)\b/.test(u) && !/\bWHERE\b/.test(u)) err.push(`${etiqueta}: UPDATE or DELETE requires WHERE ("${corto}")`);
    if (/\bWHERE\s+(1\s*=\s*1|TRUE)\b/.test(u)) err.push(`${etiqueta}: WHERE clause does not filter rows ("${corto}")`);
  }
  return err;
}
