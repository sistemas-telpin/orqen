import assert from "node:assert/strict";
import { test } from "node:test";
import { toMarkdown } from "../src/connectors/markup.ts";

test("Jira wiki markup becomes Markdown for GitHub: numbered lists are not headings, bold stays bold", () => {
  const wiki = [
    "*Analysis* (analyst: Ana)", "Resumen del pedido.", "", "*Type:* feature", "",
    "*Acceptance criteria:*", "* Dado A, entonces B.", "* Dado C, entonces D.", "",
    "*Please confirm the following so we can specify the request:*", "# ¿Excel o CSV?", "# ¿Con estado del mensaje?",
  ].join("\n");
  const md = toMarkdown(wiki);
  assert.equal(md, [
    "**Analysis** (analyst: Ana)", "Resumen del pedido.", "", "**Type:** feature", "",
    "**Acceptance criteria:**", "- Dado A, entonces B.", "- Dado C, entonces D.", "",
    "**Please confirm the following so we can specify the request:**", "1. ¿Excel o CSV?", "2. ¿Con estado del mensaje?",
  ].join("\n"));
  assert.ok(!/^# /m.test(md), "no line starts with # (it would be a heading)");
});

test("code blocks, headings, links and inline code convert; Markdown that is already Markdown is left alone", () => {
  assert.equal(toMarkdown("*SQL script:*\n{code:sql}\nSELECT *\n# not a list\n{code}\nlisto"), "**SQL script:**\n```sql\nSELECT *\n# not a list\n```\nlisto");
  assert.equal(toMarkdown("{code}\nsin cerrar"), "```\nsin cerrar\n```");
  assert.equal(toMarkdown("h2. Título\nVer [la guía|https://x.test/g] y {{orqen list}}"), "## Título\nVer [la guía](https://x.test/g) y `orqen list`");
  assert.equal(toMarkdown("Ya **negrita**, `código` y 2*3*4 no se tocan\n- item"), "Ya **negrita**, `código` y 2*3*4 no se tocan\n- item");
  // two lists in a row restart their numbering
  assert.equal(toMarkdown("# a\n# b\ntexto\n# c"), "1. a\n2. b\ntexto\n1. c");
});
