// Headless test for the live-preview transform layer
// (src/livePreview/transform.ts — pure, DOM-free by design).
//
// Run from apps/web:  node scripts/live-preview-test.mjs
// (Node >= 22.18 strips the TypeScript types natively, same as render-test.)
//
// Covered: marker-hide range math against a fixture document (multibyte
// included), reveal-on-cursor semantics (single + multiple selections), the
// CRDT-safe checkbox toggle as a real EditorState transaction, table parsing,
// and block collection (mermaid / math / hr / table, code-fence guards).

import assert from "node:assert/strict";
import { EditorSelection, EditorState } from "@codemirror/state";
import { ensureSyntaxTree } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import {
  checkboxToggle,
  collectBlocks,
  collectInlineSpans,
  collectImages,
  findHighlights,
  findInlineMath,
  findWikilinks,
  frontmatterRange,
  hiddenRanges,
  parseTableMarkdown,
  spanRevealed,
} from "../src/livePreview/transform.ts";

let passed = 0;
function check(name, cond, detail) {
  assert.ok(cond, `${name}${detail ? ` — ${detail}` : ""}`);
  passed++;
  console.log(`ok - ${name}`);
}

function mkState(doc, selection) {
  return EditorState.create({
    doc,
    selection,
    // base: markdownLanguage (GFM) — must match Editor.svelte's config
    extensions: [
      markdown({ base: markdownLanguage }),
      EditorState.allowMultipleSelections.of(true),
    ],
  });
}

function parsed(state) {
  const tree = ensureSyntaxTree(state, state.doc.length, 1e9);
  assert.ok(tree, "syntax tree parsed");
  return tree;
}

// --- fixture (multibyte on purpose: 😀 is 2 UTF-16 units, é/â are 1) ----------

const fixture = [
  "# Héading 😀 ok", // 0
  "", // …
  "**bold** café *em* and ~~gone~~ plus `code`",
  "- [ ] tâche one",
  "- [x] done",
  "[label](https://example.com/p)",
  "[[The Slug|lbl]]",
  "> quoted",
  "end",
].join("\n");

const state = mkState(fixture, EditorSelection.cursor(fixture.length)); // cursor on "end"
const tree = parsed(state);
const { spans } = collectInlineSpans(state, 0, fixture.length, tree);
const sel = state.selection.ranges.map((r) => ({ from: r.from, to: r.to }));
const hidden = hiddenRanges(spans, sel);
const hasHide = (from, to) => hidden.some((h) => h.from === from && h.to === to);
const idx = (s) => {
  const i = fixture.indexOf(s);
  assert.ok(i >= 0, `fixture contains ${JSON.stringify(s)}`);
  return i;
};

// 1) heading marker (`# ` = [0,2)) hidden; heading span carries the level
check("heading marker hidden", hasHide(0, 2));
const heading = spans.find((s) => s.kind === "heading");
check("heading level", heading?.level === 1);

// 2) multibyte sanity: the bold markers land AFTER the 2-unit emoji line,
//    at positions derived from UTF-16 indexOf — both `**` hidden
const boldOpen = idx("**bold**");
check("bold open marker hidden (multibyte-safe)", hasHide(boldOpen, boldOpen + 2));
check("bold close marker hidden", hasHide(boldOpen + 6, boldOpen + 8));
// explicit UTF-16 arithmetic: line 0 is "# Héading 😀 ok" = 15 units (emoji=2)
check("emoji line is 15 UTF-16 units", state.doc.line(1).length === 15);

// 3) em / strike / inline-code markers hidden
const emAt = idx("*em*");
check("em markers hidden", hasHide(emAt, emAt + 1) && hasHide(emAt + 3, emAt + 4));
const strikeAt = idx("~~gone~~");
check("strike markers hidden", hasHide(strikeAt, strikeAt + 2) && hasHide(strikeAt + 6, strikeAt + 8));
const codeAt = idx("`code`");
check("inline-code markers hidden", hasHide(codeAt, codeAt + 1) && hasHide(codeAt + 5, codeAt + 6));

// 4) link: `[` hidden and `](url)` hidden, label styled, url captured
const linkAt = idx("[label]");
check("link open bracket hidden", hasHide(linkAt, linkAt + 1));
check("link url part hidden", hasHide(linkAt + 6, linkAt + "[label](https://example.com/p)".length));
const link = spans.find((s) => s.kind === "link");
check("link url extracted", link?.url === "https://example.com/p");
check("link label is content", link?.contentFrom === linkAt + 1 && link?.contentTo === linkAt + 6);

// 5) wikilink: matches render.ts semantics ([[Target|label]] -> slugified)
const wikiAt = idx("[[The Slug|lbl]]");
const wiki = spans.find((s) => s.kind === "wikilink");
check("wikilink found with render.ts slug", wiki?.slug === "the-slug" && wiki?.target === "The Slug");
check("wikilink brackets+target hidden", hasHide(wikiAt, wikiAt + 11) && hasHide(wikiAt + 14, wikiAt + 16));

// 6) task markers: both hidden (widget territory), checked flag correct
const tasks = spans.filter((s) => s.kind === "task");
check("two task markers", tasks.length === 2);
check("task checked flags", tasks[0].checked === false && tasks[1].checked === true);
check("task markers are hide ranges", hasHide(tasks[0].from, tasks[0].to));

// 7) quote marker hidden
const quoteAt = idx("> quoted");
check("quote marker hidden (incl. trailing space)", hasHide(quoteAt, quoteAt + 2));

// --- reveal-on-cursor ------------------------------------------------------------

// cursor inside **bold** reveals ONLY the bold markers
{
  const st = mkState(fixture, EditorSelection.cursor(boldOpen + 3));
  const tr = parsed(st);
  const sp = collectInlineSpans(st, 0, fixture.length, tr).spans;
  const sl = st.selection.ranges.map((r) => ({ from: r.from, to: r.to }));
  const hid = hiddenRanges(sp, sl);
  check(
    "cursor in bold reveals bold markers",
    !hid.some((h) => h.from === boldOpen) && !hid.some((h) => h.from === boldOpen + 6),
  );
  check("…but the heading stays hidden", hid.some((h) => h.from === 0 && h.to === 2));
  const bold = sp.find((s) => s.kind === "strong");
  check("spanRevealed agrees", spanRevealed(bold, sl) === true);
}

// edge-touching cursor counts as inside (cursor exactly at the node start)
{
  const st = mkState(fixture, EditorSelection.cursor(emAt));
  const sp = collectInlineSpans(st, 0, fixture.length, parsed(st)).spans;
  const em = sp.find((s) => s.kind === "em");
  check("cursor at node edge reveals", spanRevealed(em, [{ from: emAt, to: emAt }]));
}

// multiple selections: each reveals its own span
{
  const st = mkState(
    fixture,
    EditorSelection.create([
      EditorSelection.cursor(boldOpen + 3),
      EditorSelection.cursor(strikeAt + 3),
    ]),
  );
  const sp = collectInlineSpans(st, 0, fixture.length, parsed(st)).spans;
  const sl = st.selection.ranges.map((r) => ({ from: r.from, to: r.to }));
  const hid = hiddenRanges(sp, sl);
  check(
    "multiple selections reveal bold AND strike",
    !hid.some((h) => h.from === boldOpen) && !hid.some((h) => h.from === strikeAt),
  );
  check("…while em stays hidden", hid.some((h) => h.from === emAt));
}

// --- checkbox toggle as a real (no-DOM) transaction --------------------------------

{
  let st = mkState("- [ ] a\n- [x] b", EditorSelection.cursor(0));
  const openPos = 2; // the `[` of the first marker
  const change = checkboxToggle(st, openPos);
  check("toggle [ ] -> change spec", change?.from === 3 && change?.to === 4 && change?.insert === "x");
  st = st.update({ changes: change }).state;
  check("toggle applied: doc has [x]", st.doc.toString() === "- [x] a\n- [x] b");
  const back = checkboxToggle(st, openPos);
  st = st.update({ changes: back }).state;
  check("toggle back: doc has [ ]", st.doc.toString() === "- [ ] a\n- [x] b");
  check("non-marker position returns null", checkboxToggle(st, 0) === null);
}

// --- table parsing --------------------------------------------------------------------

{
  const tbl = parseTableMarkdown("| a | b \\| c |\n| :- | -: |\n| 1 | 2 |\n| 3 | 4 |");
  check("table header", tbl && tbl.header.length === 2 && tbl.header[1] === "b | c");
  check("table align", tbl.align[0] === "left" && tbl.align[1] === "right");
  check("table rows", tbl.rows.length === 2 && tbl.rows[1][1] === "4");
  check("non-table rejected", parseTableMarkdown("hello\nworld") === null);
}

// --- block collection -------------------------------------------------------------------

{
  const doc = [
    "---",
    "title: x",
    "---",
    "",
    "para",
    "",
    "| a | b |",
    "| - | - |",
    "| 1 | 2 |",
    "",
    "```mermaid",
    "graph TD;",
    "  A-->B;",
    "```",
    "",
    "$$",
    "x^2",
    "$$",
    "",
    "---",
    "",
    "```",
    "$$ not math $$",
    "```",
    "![alt text](https://example.com/img.png)",
    "",
  ].join("\n");
  const st = mkState(doc, EditorSelection.cursor(doc.indexOf("para")));
  const tr = parsed(st);
  const blocks = collectBlocks(st, tr);
  const kinds = blocks.map((b) => b.kind).sort().join(",");
  check("blocks found: hr,math,mermaid,table", kinds === "hr,math,mermaid,table", kinds);
  const mermaid = blocks.find((b) => b.kind === "mermaid");
  check("mermaid source extracted", mermaid.source.includes("A-->B;"));
  const math = blocks.find((b) => b.kind === "math");
  check("math source extracted", math.source === "x^2");
  check(
    "math inside code fence NOT collected",
    !blocks.some((b) => b.kind === "math" && b.source.includes("not math")),
  );
  check(
    "frontmatter --- not a horizontal rule",
    blocks.filter((b) => b.kind === "hr").length === 1,
  );
  check("frontmatterRange detected", frontmatterRange(doc)?.from === 0);
  const images = collectImages(st, tr);
  check(
    "image collected with url + alt",
    images.length === 1 && images[0].url === "https://example.com/img.png" && images[0].alt === "alt text",
  );
}

// --- wikilinks never fire inside code -----------------------------------------------------

{
  const doc = "`[[not-a-link]]` and [[Real Page]]";
  const st = mkState(doc, EditorSelection.cursor(0));
  const ws = findWikilinks(st, 0, doc.length, parsed(st));
  check("wikilink skipped in code span", ws.length === 1 && ws[0].slug === "real-page");
}

// --- ==highlight== inline mark -----------------------------------------------------------

{
  const doc = "a ==marked text== b and `==not==` here";
  const st = mkState(doc, EditorSelection.cursor(0));
  const tr = parsed(st);
  const hls = findHighlights(st, 0, doc.length, tr);
  check("one highlight found (code span skipped)", hls.length === 1, JSON.stringify(hls));
  const at = doc.indexOf("==marked");
  check("highlight extent + content", hls[0].from === at && hls[0].to === at + "==marked text==".length);
  check(
    "highlight content excludes the == markers",
    hls[0].contentFrom === at + 2 && hls[0].contentTo === at + "==marked text".length,
  );
  check("highlight hides both == markers", hls[0].hide.length === 2);
  // collectInlineSpans surfaces it as a "mark" span
  const sp = collectInlineSpans(st, 0, doc.length, tr).spans;
  check("collectInlineSpans yields a mark span", sp.some((s) => s.kind === "mark"));
  // whitespace-adjacent and lone == are NOT highlights
  const none = findHighlights(mkState("x == y == z and == lone", EditorSelection.cursor(0)), 0, 24);
  check("whitespace-padded == is not a highlight", none.length === 0, JSON.stringify(none));
}

// --- $inline math$ -----------------------------------------------------------------------

{
  const doc = "cost is $5 and $10 but $x^2+y$ renders, `$z$` not, \\$9 escaped";
  const st = mkState(doc, EditorSelection.cursor(0));
  const tr = parsed(st);
  const ms = findInlineMath(st, 0, doc.length, tr);
  check("one inline-math span (currency + code + escape skipped)", ms.length === 1, JSON.stringify(ms.map((m) => m.source)));
  check("inline math source extracted", ms[0].source === "x^2+y", ms[0].source);
  const at = doc.indexOf("$x^2+y$");
  check("inline math extent covers $…$", ms[0].from === at && ms[0].to === at + "$x^2+y$".length);
  // it surfaces as a "math" inline span carrying source for the widget
  const sp = collectInlineSpans(st, 0, doc.length, tr).spans;
  const mathSpan = sp.find((s) => s.kind === "math");
  check("collectInlineSpans yields a math span with source", mathSpan?.source === "x^2+y");
  // a cursor inside reveals the raw $…$ (span has the whole range as reveal)
  check("inline math reveal is the whole span", mathSpan.reveal.from === at && mathSpan.reveal.to === at + 7);
}

console.log(`\nlive-preview-test: ${passed} checks passed`);
