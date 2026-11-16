/** Guardas del carril rápido: revisión estática del SQL que propone el agente. No reemplaza al aprobador humano. */

const sinRuido = (sql: string) =>
  sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ").replace(/'(?:[^']|'')*'/g, "''");

/** Devuelve los problemas encontrados (vacío = pasa las guardas). */
export function revisarSql(sql: string, etiqueta = "script_sql"): string[] {
  const err: string[] = [];
  const sentencias = sinRuido(sql).split(/;|^\s*GO\s*$/gim).map((s) => s.trim()).filter(Boolean);
  for (const s of sentencias) {
    const u = s.toUpperCase();
    const corto = s.replace(/\s+/g, " ").slice(0, 80);
    if (/\b(DROP|TRUNCATE)\b/.test(u)) err.push(`${etiqueta}: prohibido DROP/TRUNCATE ("${corto}")`);
    if (/\b(UPDATE|DELETE)\b/.test(u) && !/\bWHERE\b/.test(u)) err.push(`${etiqueta}: UPDATE/DELETE sin WHERE ("${corto}")`);
    if (/\bWHERE\s+(1\s*=\s*1|TRUE)\b/.test(u)) err.push(`${etiqueta}: WHERE trivial que no filtra ("${corto}")`);
  }
  return err;
}
