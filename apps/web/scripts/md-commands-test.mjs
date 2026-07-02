// Headless test for the toolbar's markdown command transforms
// (editor-core mdCommands.ts — pure, DOM-free by design, same pattern as
// live-preview-test.mjs).
//
// Run from apps/web:  node scripts/md-commands-test.mjs
// (Node >= 22.18 strips the TypeScript types natively.)
//
// Covered: inline toggles (bold incl. multibyte selection, wrap/unwrap, word
// expansion, empty pair), block style transforms (heading set/cycle, quote,
// code-block wrap/unwrap), list toggles (bullet/task/numbered with
// renumbering), link insertion, insert-menu snippets (table skeleton parses,
// blank-line separation), and the outline parser used by the left rail.

import assert from "node:assert/strict";
import { EditorSelection, EditorState } from "@codemirror/state";
import { ensureSyntaxTree } from "@codemirror/language";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import {
  activeInlineMarks,
  currentBlockStyle,
  currentListKind,
  insertBlockSnippet,
  insertLink,
  insertWikilink,
  isProbablyUrl,
  parseOutline,
  setBlockStyle,
  SNIPPETS,
  SNIPPET_CURSOR,
  tableSkeleton,
  toggleInlineMark,
  toggleList,
} from "../../../packages/editor-core/src/mdCommands.ts";
import { parseTableMarkdown } from "../src/livePreview/transform.ts";

let passed = 0;
function check(name, cond, detail) {
  assert.ok(cond, `${name}${detail ? ` — ${detail}` : ""}`);
  passed++;
  console.log(`ok - ${name}`);
}

function mkState(doc, selection) {
  const state = EditorState.create({
    doc,
    selection,
    // base: markdownLanguage (GFM) — must match Editor.svelte's config
    extensions: [
      markdown({ base: markdownLanguage }),
      EditorState.allowMultipleSelections.of(true),
    ],
  });
  // the commands resolve nodes through the tree; parse it all up front
  ensureSyntaxTree(state, state.doc.length, 1e9);
  return state;
}

function apply(state, spec) {
  return state.update(spec).state;
}

function sel(from, to = from) {
  return EditorSelection.range(from, to);
}

// --- inline toggles ---------------------------------------------------------------

// bold toggle over a multibyte selection (emoji = 2 UTF-16 units, é = 1)
{
  const doc = "café 😀toast ok";
  const from = doc.indexOf("😀");
  const to = from + "😀toast".length;
  let st = mkState(doc, sel(from, to));
  st = apply(st, toggleInlineMark(st, "strong"));
  check(
    "bold wraps multibyte selection",
    st.doc.toString() === "café **😀toast** ok",
    st.doc.toString(),
  );
  check(
    "selection maps inside the markers",
    st.selection.main.from === from + 2 && st.selection.main.to === to + 2,
  );
  // toggle again from the mapped selection -> unwrapped
  st = apply(st, toggleInlineMark(st, "strong"));
  check("bold toggles back off", st.doc.toString() === doc, st.doc.toString());
}

// cursor inside a bold node unwraps it (no selection needed)
{
  let st = mkState("a **bold** b", sel(6));
  st = apply(st, toggleInlineMark(st, "strong"));
  check("cursor-in-bold unwraps", st.doc.toString() === "a bold b", st.doc.toString());
}

// empty selection on a word wraps the word
{
  let st = mkState("hello wörld here", sel(8)); // inside wörld
  st = apply(st, toggleInlineMark(st, "em"));
  check(
    "word under cursor wrapped in em",
    st.doc.toString() === "hello *wörld* here",
    st.doc.toString(),
  );
}

// empty selection on whitespace -> empty pair with the cursor inside
{
  let st = mkState("a  b", sel(2));
  st = apply(st, toggleInlineMark(st, "code"));
  check("empty pair inserted", st.doc.toString() === "a `` b", st.doc.toString());
  check("cursor sits between the markers", st.selection.main.head === 3);
}

// selection that includes the markers unwraps
{
  const doc = "x ~~gone~~ y";
  let st = mkState(doc, sel(2, 10));
  st = apply(st, toggleInlineMark(st, "strike"));
  check("marker-inclusive selection unwraps", st.doc.toString() === "x gone y", st.doc.toString());
}

// italic inside bold nests instead of breaking the bold markers
{
  let st = mkState("**bold** x", sel(2, 6));
  st = apply(st, toggleInlineMark(st, "em"));
  check("em inside strong nests", st.doc.toString() === "***bold*** x", st.doc.toString());
}

// active marks at the cursor
{
  const st = mkState("a **bo*it*ld** c", sel(8));
  const marks = activeInlineMarks(st);
  check("activeInlineMarks sees strong+em", marks.has("strong") && marks.has("em"));
}

// --- block styles -------------------------------------------------------------------

// heading cycle: normal -> h1 -> h2 -> quote -> normal
{
  let st = mkState("plain title\nbody", sel(3));
  st = apply(st, setBlockStyle(st, "h1"));
  check("h1 set", st.doc.toString() === "# plain title\nbody", st.doc.toString());
  st = mkState(st.doc.toString(), sel(4));
  check("currentBlockStyle reports h1", currentBlockStyle(st) === "h1");
  st = apply(st, setBlockStyle(st, "h2"));
  check(
    "h1 -> h2 replaces the marker",
    st.doc.toString() === "## plain title\nbody",
    st.doc.toString(),
  );
  st = mkState(st.doc.toString(), sel(4));
  st = apply(st, setBlockStyle(st, "quote"));
  check("h2 -> quote", st.doc.toString() === "> plain title\nbody", st.doc.toString());
  st = mkState(st.doc.toString(), sel(4));
  check("currentBlockStyle reports quote", currentBlockStyle(st) === "quote");
  st = apply(st, setBlockStyle(st, "normal"));
  check(
    "quote -> normal strips markers",
    st.doc.toString() === "plain title\nbody",
    st.doc.toString(),
  );
}

// multi-line selection styles every touched line, skipping blanks
{
  const doc = "one\n\ntwo";
  let st = mkState(doc, sel(0, doc.length));
  st = apply(st, setBlockStyle(st, "h3"));
  check(
    "multi-line h3 skips blank lines",
    st.doc.toString() === "### one\n\n### two",
    st.doc.toString(),
  );
}

// code block wrap + unwrap
{
  let st = mkState("alpha\nbeta\ngamma", sel(6, 10)); // "beta"
  st = apply(st, setBlockStyle(st, "codeblock"));
  check(
    "code block wraps the line",
    st.doc.toString() === "alpha\n```\nbeta\n```\ngamma",
    st.doc.toString(),
  );
  st = mkState(st.doc.toString(), sel(st.doc.toString().indexOf("beta")));
  check("currentBlockStyle reports codeblock", currentBlockStyle(st) === "codeblock");
  st = apply(st, setBlockStyle(st, "codeblock"));
  check("code block unwraps again", st.doc.toString() === "alpha\nbeta\ngamma", st.doc.toString());
}

// --- lists ------------------------------------------------------------------------------

{
  const doc = "one\ntwo\nthree";
  let st = mkState(doc, sel(0, doc.length));
  st = apply(st, toggleList(st, "bullet"));
  check("bullet list applied", st.doc.toString() === "- one\n- two\n- three", st.doc.toString());
  st = mkState(st.doc.toString(), sel(0, st.doc.length));
  check("currentListKind reports bullet", currentListKind(st) === "bullet");
  st = apply(st, toggleList(st, "ordered"));
  check(
    "bullet -> numbered renumbers from 1",
    st.doc.toString() === "1. one\n2. two\n3. three",
    st.doc.toString(),
  );
  st = mkState(st.doc.toString(), sel(0, st.doc.length));
  st = apply(st, toggleList(st, "ordered"));
  check("numbered toggles off to plain", st.doc.toString() === doc, st.doc.toString());
}

// task list keeps existing text, strips other list markers
{
  let st = mkState("- already bullet", sel(3));
  st = apply(st, toggleList(st, "task"));
  check(
    "bullet -> task rewrites the prefix",
    st.doc.toString() === "- [ ] already bullet",
    st.doc.toString(),
  );
  st = mkState(st.doc.toString(), sel(3));
  check("currentListKind reports task", currentListKind(st) === "task");
  st = apply(st, toggleList(st, "task"));
  check("task toggles off", st.doc.toString() === "already bullet", st.doc.toString());
}

// --- link --------------------------------------------------------------------------------

{
  const doc = "see têxt 😀 here";
  const from = doc.indexOf("têxt");
  const to = from + "têxt 😀".length;
  let st = mkState(doc, sel(from, to));
  st = apply(st, insertLink(st, st.doc.sliceString(from, to), "https://example.com/p"));
  check(
    "link replaces the (multibyte) selection",
    st.doc.toString() === "see [têxt 😀](https://example.com/p) here",
    st.doc.toString(),
  );
}

{
  let st = mkState("x", sel(1));
  st = apply(st, insertLink(st, "", "https://e.co"));
  check("empty text falls back to the url", st.doc.toString() === "x[https://e.co](https://e.co)");
  check(
    "isProbablyUrl accepts https + www",
    isProbablyUrl("https://a.b") && isProbablyUrl("www.a.b"),
  );
  check("isProbablyUrl rejects prose", !isProbablyUrl("hello world"));
}

// --- insert menu ----------------------------------------------------------------------------

// table skeleton: inserted as its own block AND parses as a GFM table
{
  const skel = tableSkeleton();
  const tbl = parseTableMarkdown(skel);
  check("table skeleton parses (3 cols)", tbl !== null && tbl.header.length === 3);
  check("table skeleton has 2 body rows", tbl.rows.length === 2);

  let st = mkState("para text\nnext", sel(4));
  st = apply(st, insertBlockSnippet(st, skel));
  const out = st.doc.toString();
  check(
    "table separated by blank lines on both sides",
    out.startsWith("para text\n\n|") && out.includes("|\n\nnext"),
    JSON.stringify(out),
  );
}

// snippet on an empty line inserts in place (no leading blank)
{
  let st = mkState("above\n\nbelow", sel(6)); // the empty line
  st = apply(st, insertBlockSnippet(st, SNIPPETS.hr, SNIPPET_CURSOR.hr));
  check(
    "hr on empty line inserts in place",
    st.doc.toString() === "above\n---\n\nbelow",
    JSON.stringify(st.doc.toString()),
  );
}

// code block snippet leaves the cursor inside the fence
{
  let st = mkState("", sel(0));
  st = apply(st, insertBlockSnippet(st, SNIPPETS.codeblock, SNIPPET_CURSOR.codeblock));
  check("code snippet inserted", st.doc.toString().startsWith("```\n\n```"));
  check("cursor inside the fence", st.selection.main.head === 4);
}

// wikilink wraps the selection / opens empty brackets
{
  let st = mkState("Visit The Page now", sel(6, 14));
  st = apply(st, insertWikilink(st));
  check(
    "wikilink wraps selection",
    st.doc.toString() === "Visit [[The Page]] now",
    st.doc.toString(),
  );
  st = mkState("x ", sel(2));
  st = apply(st, insertWikilink(st));
  check(
    "empty wikilink leaves cursor between brackets",
    st.doc.toString() === "x [[]]" && st.selection.main.head === 4,
  );
}

// --- outline (left rail) -----------------------------------------------------------------------

{
  const doc = [
    "---",
    "title: x",
    "---",
    "# One",
    "text",
    "```",
    "# not a heading",
    "```",
    "## Twö 😀",
    "### Three ###",
  ].join("\n");
  const items = parseOutline(doc);
  check("outline finds 3 headings", items.length === 3, JSON.stringify(items));
  check("outline levels", items[0].level === 1 && items[1].level === 2 && items[2].level === 3);
  check(
    "outline skips fenced code + frontmatter",
    !items.some((i) => i.text.includes("not a heading")),
  );
  check("outline strips closing hashes", items[2].text === "Three");
  check(
    "outline offsets point at the heading line",
    doc.slice(items[1].from, items[1].from + 2) === "##",
  );
}

console.log(`\nmd-commands-test: ${passed} checks passed`);
