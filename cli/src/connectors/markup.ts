/**
 * The texts orqen posts on tickets are written once, in Jira wiki markup (`*bold*`, `* item`, `# numbered`, `{code}`):
 * Jira renders it as is. Other tools need their own format: `toMarkdown` is what GitHub gets (there a leading `#` is a
 * heading, so a numbered list would show up as titles). Text that is already Markdown (`**bold**`, `- item`) is left alone.
 */
export function toMarkdown(text: string): string {
  const out: string[] = [];
  let fence = false;      // inside {code}…{code} / {noformat}…{noformat}
  let numbered = 0;       // position in a "# " list
  for (const raw of text.replace(/\r\n/g, "\n").split("\n")) {
    const open = raw.match(/^\s*\{(?:code|noformat)(?::([\w+-]+))?\}\s*$/);
    if (open && !fence) { fence = true; out.push("```" + (open[1] ?? "")); continue; }
    if (fence) {
      if (/^\s*\{(?:code|noformat)\}\s*$/.test(raw)) { fence = false; out.push("```"); } else out.push(raw);
      continue;
    }
    let line = raw;
    const n = line.match(/^#\s+(.*)$/);
    if (n) { numbered++; out.push(`${numbered}. ${inline(n[1])}`); continue; }
    numbered = 0;
    const h = line.match(/^h([1-6])\.\s+(.*)$/);
    if (h) { out.push(`${"#".repeat(Number(h[1]))} ${inline(h[2])}`); continue; }
    const b = line.match(/^\*\s+(.*)$/);
    line = b ? `- ${b[1]}` : line;
    out.push(inline(line));
  }
  if (fence) out.push("```");   // an unclosed block must not swallow what follows
  return out.join("\n");
}

/**
 * Plain text for tools that show comments as typed (Asana's `text`): the Jira markup goes away without losing structure.
 * `*bold*` → bold, `* item` → `• item`, `# item` → `1. item`, `h2. Title` → Title, `{{x}}` → x, `[text|url]` → text (url),
 * `{code}` blocks keep their lines, indented. Text with no markup is returned as it is.
 */
export function toPlain(text: string): string {
  const out: string[] = [];
  let fence = false, numbered = 0;
  for (const raw of text.replace(/\r\n/g, "\n").split("\n")) {
    if (/^\s*\{(?:code|noformat)(?::[\w+-]+)?\}\s*$/.test(raw)) { fence = !fence; continue; }
    if (fence) { out.push(`    ${raw}`); continue; }
    const n = raw.match(/^#\s+(.*)$/);
    if (n) { numbered++; out.push(`${numbered}. ${plainInline(n[1])}`); continue; }
    numbered = 0;
    const h = raw.match(/^h[1-6]\.\s+(.*)$/);
    if (h) { out.push(plainInline(h[1])); continue; }
    const b = raw.match(/^\*\s+(.*)$/);
    out.push(b ? `• ${plainInline(b[1])}` : plainInline(raw));
  }
  return out.join("\n");
}

function plainInline(line: string): string {
  return line
    .replace(/(?<![*\w])\*(?=\S)([^*\n]+?)(?<=\S)\*(?![*\w])/g, "$1")
    .replace(/\{\{([^}\n]+)\}\}/g, "$1")
    .replace(/\[([^\]|\n]+)\|(https?:\/\/[^\]\s]+)\]/g, "$1 ($2)");
}

function inline(line: string): string {
  return line
    // *bold* → **bold** (not when it is already **bold**, nor a * inside a word)
    .replace(/(?<![*\w])\*(?=\S)([^*\n]+?)(?<=\S)\*(?![*\w])/g, "**$1**")
    .replace(/\{\{([^}\n]+)\}\}/g, "`$1`")
    .replace(/\[([^\]|\n]+)\|(https?:\/\/[^\]\s]+)\]/g, "[$1]($2)");
}
