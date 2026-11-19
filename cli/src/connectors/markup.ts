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

function inline(line: string): string {
  return line
    // *bold* → **bold** (not when it is already **bold**, nor a * inside a word)
    .replace(/(?<![*\w])\*(?=\S)([^*\n]+?)(?<=\S)\*(?![*\w])/g, "**$1**")
    .replace(/\{\{([^}\n]+)\}\}/g, "`$1`")
    .replace(/\[([^\]|\n]+)\|(https?:\/\/[^\]\s]+)\]/g, "[$1]($2)");
}
