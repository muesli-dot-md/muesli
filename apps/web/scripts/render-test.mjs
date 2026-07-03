// Headless test for the ADR 0015 preview rendering pipeline (src/render.ts).
//
// Run from apps/web:  node scripts/render-test.mjs
// (Node >= 22.18 strips the TypeScript types in src/render.ts natively.)
//
// render.ts is DOM-free by design; the one DOM-dependent step — mermaid SVG
// rendering — happens *after* the HTML lands (src/mermaid.ts, browser only),
// so here we assert the pre-render placeholder (`data-diagram="mermaid"` with
// the source preserved) rather than an SVG. Sanitization needs a DOM, so we
// inject DOMPurify bound to a jsdom window — the exact same PURIFY_CONFIG the
// browser path uses, meaning these assertions also prove KaTeX/callout/table
// markup survives sanitization.

import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import createDOMPurify from "dompurify";
import {
  renderMarkdown,
  setSanitizer,
  slugify,
  PURIFY_CONFIG,
} from "../../../packages/editor-core/src/render.ts";

const { window } = new JSDOM("");
const purify = createDOMPurify(window);
setSanitizer((html) => purify.sanitize(html, PURIFY_CONFIG));

const fixture = `---
title: Test Doc
owner: julian
tags: alpha, beta
---

# Heading

Einstein said $E=mc^2$ and that was that.

$$
\\int_0^1 x\\,dx = \\tfrac{1}{2}
$$

\`\`\`mermaid
graph TD;
  A-->B;
\`\`\`

> [!NOTE]
> Callouts contain **nested** markdown.

> [!WARNING]
> Mind the gap.

See [[The Slug]] and [[Other Page|a label]].

Here is ==highlighted **bold**== text, but \`==notmark==\` stays code.

Inline code keeps \`$notmath$\` untouched, and $5 with $10 is just money.

\`\`\`
$alsonotmath$ and [[not-a-link]]
\`\`\`
`;

const html = renderMarkdown(fixture);

let passed = 0;
function check(name, cond, detail) {
  assert.ok(cond, `${name}${detail ? ` — ${detail}` : ""}`);
  passed++;
  console.log(`ok - ${name}`);
}

// 1) KaTeX output present for $E=mc^2$
check("katex inline math rendered", html.includes('class="katex"'));
check("katex display math rendered", html.includes("katex-display"));

// 2) Mermaid: pre-render placeholder with source preserved (SVG rendering is
//    DOM-only and happens later in src/mermaid.ts — asserted as placeholder
//    by design, see header comment).
check("mermaid placeholder container", html.includes('data-diagram="mermaid"'));
check("mermaid source preserved", html.includes("A--&gt;B;"));

// 2b) Highlight: ==text== -> <mark>, inner markdown re-lexed, code span untouched
check("highlight renders as mark", html.includes("<mark>"));
check("highlight keeps inner markdown", /<mark>highlighted <strong>bold<\/strong><\/mark>/.test(html));
check("highlight in code span untouched", /<code>==notmark==<\/code>/.test(html));

// 3) Callouts: daisyUI alert class + title + nested markdown
check("callout has alert class", /class="callout alert alert-info"/.test(html));
check("callout title rendered", html.includes(">Note</p>"));
check("callout nested markdown renders", html.includes("<strong>nested</strong>"));
check("warning callout variant", html.includes("alert-warning"));

// 4) Wikilinks: slugified hash hrefs, label support, distinct class
check("slugify", slugify("The Slug") === "the-slug", `got ${slugify("The Slug")}`);

// Parity fixtures with the server's link extraction (crates/muesli-server/src/links.rs
// slugify_matches_render_ts_fixtures) — the SAME table is asserted there. Change one
// side and the other test fails; the link index must agree with what wikilinks render
// as (href="#slug"), or graph edges would point somewhere the client doesn't navigate.
const SLUGIFY_FIXTURES = [
  ["The Slug", "the-slug"],
  ["  Spaces  Around  ", "spaces-around"],
  ["Crème Brûlée!", "crme-brle"],
  ["under_score-ok", "under_score-ok"],
  ["A  --  B", "a-b"],
  ["##Heading##", "heading"],
  ["MiXeD CaSe 42", "mixed-case-42"],
  ["Page#Section", "pagesection"],
  ["日本語", ""],
  ["tabs\tand\nnewlines", "tabs-and-newlines"],
  ["---", ""],
];
for (const [input, expected] of SLUGIFY_FIXTURES) {
  assert.equal(slugify(input), expected, `slugify(${JSON.stringify(input)})`);
}
passed++;
console.log("ok - slugify parity fixtures (shared with muesli-server links.rs)");
check("wikilink href", html.includes('href="#the-slug"'));
check("wikilink label", /<a[^>]*href="#other-page"[^>]*>a label<\/a>/.test(html));
check("wikilink class", html.includes('class="wikilink"'));

// 5) Frontmatter table rows
check("frontmatter table", /<div class="frontmatter[^"]*"><table class="table table-xs">/.test(html));
check("frontmatter row: title", />title<\/th><td>Test Doc<\/td>/.test(html));
check("frontmatter row: owner", />owner<\/th><td>julian<\/td>/.test(html));
check("frontmatter not raw text", !html.includes("<hr"));

// 6) Math/wikilink guards: untouched inside code, currency left alone
check("$notmath$ in code span untouched", /<code>\$notmath\$<\/code>/.test(html));
check("code span not katex-ified", !/katex[^]*notmath|notmath[^]*?class="katex-error"/.test(
  html.slice(html.indexOf("notmath") - 200, html.indexOf("notmath") + 50),
));
check("fenced block content untouched", html.includes("$alsonotmath$ and [[not-a-link]]"));
check("currency is not math", html.includes("$5 with $10"));

// 7) Graceful degradation: never throws, junk round-trips
for (const junk of ["", "---", "$$", "[[", "> [!BOGUS]\n> hm", "<script>alert(1)</script>", "\x00"]) {
  const out = renderMarkdown(junk);
  assert.equal(typeof out, "string", `renderMarkdown(${JSON.stringify(junk)}) returns a string`);
}
passed++;
console.log("ok - degenerate inputs never throw");

// 8) Sanitization active: script tags do not survive
check("sanitizer strips script tags", !renderMarkdown("hi <script>alert(1)</script>").includes("<script"));

console.log(`\nrender-test: ${passed} checks passed`);
