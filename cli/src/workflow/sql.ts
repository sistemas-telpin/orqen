/** Fast-lane guards: static review of the SQL the agent proposes. It does not replace the human approver. */

const stripNoise = (sql: string) =>
  sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ").replace(/'(?:[^']|'')*'/g, "''");

/** Returns the problems found (empty = passes the guards). */
export function reviewSql(sql: string, label = "sql_script"): string[] {
  const errors: string[] = [];
  const statements = stripNoise(sql).split(/;|^\s*GO\s*$/gim).map((s) => s.trim()).filter(Boolean);
  for (const s of statements) {
    const u = s.toUpperCase();
    const short = s.replace(/\s+/g, " ").slice(0, 80);
    if (/\b(DROP|TRUNCATE)\b/.test(u)) errors.push(`${label}: DROP/TRUNCATE is forbidden ("${short}")`);
    if (/\b(UPDATE|DELETE)\b/.test(u) && !/\bWHERE\b/.test(u)) errors.push(`${label}: UPDATE/DELETE without WHERE ("${short}")`);
    if (/\bWHERE\s+(1\s*=\s*1|TRUE)\b/.test(u)) errors.push(`${label}: trivial WHERE that does not filter ("${short}")`);
  }
  return errors;
}
