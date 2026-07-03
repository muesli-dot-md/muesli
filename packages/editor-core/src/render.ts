// Markdown rendering pipeline for the preview pane (ADR 0015).
//
// Flavor: CommonMark + GFM (marked defaults) plus:
//   - KaTeX math      ($inline$ and $$display$$)
//   - Mermaid blocks  (```mermaid -> placeholder div; the DOM-side renderer in
//                      mermaid.ts swaps in the SVG asynchronously — see below)
//   - Callouts        (> [!NOTE] / [!TIP] / [!IMPORTANT] / [!WARNING] / [!CAUTION])
//   - Wikilinks       ([[Target]] / [[Target|label]] -> #slug hash links)
//   - YAML frontmatter (leading --- block -> compact key/value table)
//
// This module is deliberately DOM-free so it can run headlessly (see
// scripts/render-test.mjs): mermaid blocks only become a *placeholder* here
// (`<div data-diagram="mermaid"><pre>…source…</pre></div>`); the actual SVG
// rendering needs a real DOM and lives in mermaid.ts, invoked by callers
// (snapshot modal, live-preview widgets) after the HTML lands. Sanitization is injectable for the
// same reason — in the browser it defaults to DOMPurify, headless callers
// provide their own (e.g. DOMPurify bound to a jsdom window).
//
// Per ADR 0015, parsing is for rendering only — failures must never throw;
// unsupported syntax degrades to plain text.

import { Marked, type Token, type Tokens } from "marked";
import katex from "katex";
import DOMPurify from "dompurify";
// Self-referencing package subpath (not a relative path): resolves via this
// package's own `exports` map, which works both under Vite/svelte-check and
// under plain `node` (the headless render-test script type-strips render.ts and
// imports it by file path, where a relative `./tableModel` would not resolve
// without an extension and a `.ts` extension trips `allowImportingTsExtensions`).
import {
  evalTableFormula,
  formatFormulaValue,
  isFormula,
  isFormulaError,
  type Align,
  type ParsedTable,
} from "@muesli/editor-core/tableModel";

// --- Sanitization ----------------------------------------------------------

/** Extra allowances over DOMPurify defaults so KaTeX MathML output survives. */
export const PURIFY_CONFIG = {
  ADD_TAGS: ["semantics", "annotation"],
  ADD_ATTR: ["encoding"],
};

/** PURIFY_CONFIG plus the allowances mermaid SVG output needs: mermaid renders
 * node/edge labels as HTML inside <foreignObject>, which DOMPurify strips by
 * default — both the tag itself and (via the HTML-in-SVG namespace check) any
 * HTML content under it, so foreignObject must also be registered as an HTML
 * integration point (the documented `{ foreignobject: true }` opt-in; the
 * config key REPLACES the default map, so 'annotation-xml' is re-listed).
 * The foreignObject *content* is still sanitized against the normal HTML
 * allowlist (scripts/handlers removed) — this re-enables the wrapper, not raw
 * HTML passthrough. Use this config only for mermaid-generated SVG, never for
 * user-authored markup. */
export const SVG_PURIFY_CONFIG = {
  ADD_TAGS: [...PURIFY_CONFIG.ADD_TAGS, "foreignObject"],
  ADD_ATTR: [...PURIFY_CONFIG.ADD_ATTR],
  HTML_INTEGRATION_POINTS: { "annotation-xml": true, foreignobject: true },
};

/** SECURITY: must stay `false`. trust:true would let \href / \url / \html*
 * macros emit attacker-chosen URLs and attributes from document text
 * (security review finding 32). Every KaTeX call site (render.ts and the
 * live-preview widgets) must pass this constant, never a literal, so the
 * setting can only regress in one greppable place — guarded by render.test.ts. */
export const KATEX_TRUST = false;

export type Sanitizer = (html: string) => string;

let sanitizer: Sanitizer | null = null;

/** Inject a sanitizer (used by headless tests, where DOMPurify needs a DOM).
 * The injected function is used verbatim for every sanitize() call, including
 * ones that pass a custom config — headless callers own their own config. */
export function setSanitizer(fn: Sanitizer): void {
  sanitizer = fn;
}

/**
 * Sanitize untrusted HTML through DOMPurify (or the injected test sanitizer).
 * Exported so every `innerHTML` sink that renders document-derived content
 * (live-preview KaTeX widgets, mermaid SVG injection) shares this exact path
 * instead of trusting upstream renderer settings alone (finding 32).
 */
export function sanitize(html: string, config: typeof PURIFY_CONFIG = PURIFY_CONFIG): string {
  if (sanitizer) return sanitizer(html);
  // In the browser the dompurify default export is bound to `window`.
  // In Node (no DOM) it is an unbound factory: isSupported is false and
  // sanitize is unavailable — headless callers must use setSanitizer().
  if (DOMPurify.isSupported) return DOMPurify.sanitize(html, config);
  return html;
}

// --- Helpers ----------------------------------------------------------------

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Wikilink target -> URL-hash slug: lowercase, spaces -> '-', strip the rest. */
export function slugify(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9_-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// --- Math (KaTeX) -----------------------------------------------------------
// Implemented as marked tokenizer extensions. Safety against `$` inside code
// spans / fenced blocks falls out of marked's lexer ordering: at a backtick or
// fence position our `^\$`-anchored tokenizers don't match, so the built-in
// code tokenizers consume the whole span/block before we ever see its insides.

function renderKatex(tex: string, displayMode: boolean): string {
  try {
    return katex.renderToString(tex, {
      throwOnError: false,
      displayMode,
      output: "htmlAndMathml",
      trust: KATEX_TRUST, // SECURITY: keep false — see KATEX_TRUST
    });
  } catch {
    // throwOnError:false covers parse errors; this catches anything else.
    return `<code class="katex-error">${escapeHtml(tex)}</code>`;
  }
}

const inlineMath = {
  name: "inlineMath",
  level: "inline" as const,
  start(src: string): number | undefined {
    const i = src.indexOf("$");
    return i === -1 ? undefined : i;
  },
  tokenizer(src: string) {
    // $$display$$ used inline.
    const block = /^\$\$([^$]+?)\$\$/.exec(src);
    if (block) {
      return { type: "inlineMath", raw: block[0], text: block[1].trim(), display: true };
    }
    // $inline$ — content must not start/end with whitespace, so "$5 and $10"
    // style prose is left alone.
    const m = /^\$([^$\n]+?)\$/.exec(src);
    if (m && !/^\s/.test(m[1]) && !/\s$/.test(m[1])) {
      return { type: "inlineMath", raw: m[0], text: m[1], display: false };
    }
    return undefined;
  },
  renderer(token: Tokens.Generic): string {
    return renderKatex(token.text, token.display as boolean);
  },
};

const blockMath = {
  name: "blockMath",
  level: "block" as const,
  start(src: string): number | undefined {
    return /\$\$/.exec(src)?.index;
  },
  tokenizer(src: string) {
    const m = /^\$\$([\s\S]+?)\$\$[ \t]*(?:\r?\n|$)/.exec(src);
    if (m) return { type: "blockMath", raw: m[0], text: m[1].trim() };
    return undefined;
  },
  renderer(token: Tokens.Generic): string {
    return `<p>${renderKatex(token.text, true)}</p>\n`;
  },
};

// --- Highlight (==text==) ----------------------------------------------------
// `==text==` -> <mark>text</mark>, mirroring the live-preview inline mark
// (inline.ts) so the editor and the export agree. Same lexer-ordering safety as
// math/wikilinks keeps it from firing inside code spans/blocks. Content must not
// start/end with whitespace, so stray `==` runs are left as plain text. Inner
// markdown is re-lexed so `==**bold**==` highlights bold text.

type InlineLexer = { lexer: { inlineTokens(s: string): Token[] } };
type InlineParser = { parser: { parseInline(t: Token[]): string } };

const highlight = {
  name: "highlight",
  level: "inline" as const,
  start(src: string): number | undefined {
    const i = src.indexOf("==");
    return i === -1 ? undefined : i;
  },
  tokenizer(this: InlineLexer, src: string) {
    const m = /^==(?!\s)([^\n]+?)(?<!\s)==/.exec(src);
    if (!m) return undefined;
    return {
      type: "highlight",
      raw: m[0],
      text: m[1],
      tokens: this.lexer.inlineTokens(m[1]),
    };
  },
  renderer(this: InlineParser, token: Tokens.Generic): string {
    return `<mark>${this.parser.parseInline(token.tokens as Token[])}</mark>`;
  },
};

// --- Wikilinks ---------------------------------------------------------------
// [[Target]] / [[Target|label]] -> <a class="wikilink" href="#slug">label</a>.
// Resolution is client-side slugification onto the app's hash routing (see
// collab.ts parseHash); cross-document resolution by title is a later feature
// (design/wikilinks-and-link-graph.md). Same lexer-ordering argument as math:
// never fires inside code spans/blocks.

const wikilink = {
  name: "wikilink",
  level: "inline" as const,
  start(src: string): number | undefined {
    const i = src.indexOf("[[");
    return i === -1 ? undefined : i;
  },
  tokenizer(src: string) {
    const m = /^\[\[([^[\]|\n]+?)(?:\|([^[\]\n]+?))?\]\]/.exec(src);
    if (!m) return undefined;
    const target = m[1].trim();
    const slug = slugify(target);
    if (!slug) return undefined;
    return {
      type: "wikilink",
      raw: m[0],
      target,
      slug,
      label: (m[2] ?? m[1]).trim(),
    };
  },
  renderer(token: Tokens.Generic): string {
    return `<a class="wikilink" href="#${token.slug}" data-wikilink="${escapeHtml(
      token.target as string,
    )}">${escapeHtml(token.label as string)}</a>`;
  },
};

// --- Callouts ----------------------------------------------------------------
// GitHub-style `> [!NOTE]` blockquotes -> daisyUI alert-styled blocks.

const CALLOUTS: Record<string, { title: string; cls: string }> = {
  NOTE: { title: "Note", cls: "alert-info" },
  TIP: { title: "Tip", cls: "alert-success" },
  IMPORTANT: { title: "Important", cls: "callout-important" },
  WARNING: { title: "Warning", cls: "alert-warning" },
  CAUTION: { title: "Caution", cls: "alert-error" },
};

const CALLOUT_MARKER = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*(?:\r?\n|$)/i;

function calloutOf(
  token: Tokens.Blockquote,
  relex: (md: string) => Token[],
): { kind: string; title: string; cls: string; tokens: Token[] } | null {
  const first = token.tokens[0];
  if (!first || first.type !== "paragraph") return null;
  const m = CALLOUT_MARKER.exec((first as Tokens.Paragraph).text);
  if (!m) return null;
  const kind = m[1].toUpperCase();
  const meta = CALLOUTS[kind];
  if (!meta) return null;
  // Drop the marker line; re-lex the rest of the first paragraph so nested
  // markdown inside the callout still renders.
  const remainder = (first as Tokens.Paragraph).text.slice(m[0].length);
  const tokens: Token[] = token.tokens.slice(1);
  if (remainder.trim()) tokens.unshift(...relex(remainder));
  return { kind: kind.toLowerCase(), title: meta.title, cls: meta.cls, tokens };
}

// --- Frontmatter -------------------------------------------------------------
// A leading `---\n…\n---` block becomes a compact daisyUI key/value table.
// Simple `key: value` line parsing only; nested structures collapse onto the
// preceding key as plain strings (per ADR 0015 this is render-only — the raw
// text in the CRDT is untouched).

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

function extractFrontmatter(src: string): { html: string; body: string } {
  const m = FRONTMATTER.exec(src);
  if (!m) return { html: "", body: src };
  const entries: [string, string][] = [];
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([^\s:][^:]*?)\s*:\s?(.*)$/.exec(line);
    if (kv) {
      entries.push([kv[1], kv[2]]);
    } else if (line.trim() && entries.length > 0) {
      // Continuation / nested line: append as plain string to the last key.
      const last = entries[entries.length - 1];
      last[1] = last[1] ? `${last[1]} ${line.trim()}` : line.trim();
    }
  }
  if (entries.length === 0) return { html: "", body: src }; // not key/value — leave as text
  const rows = entries
    .map(
      ([k, v]) =>
        `<tr><th class="frontmatter-key">${escapeHtml(k)}</th><td>${escapeHtml(v)}</td></tr>`,
    )
    .join("");
  const html =
    `<div class="frontmatter rounded-box border border-base-300 bg-base-200">` +
    `<table class="table table-xs"><tbody>${rows}</tbody></table></div>\n`;
  return { html, body: src.slice(m[0].length) };
}

// --- The marked instance -----------------------------------------------------

const md = new Marked({ gfm: true });

md.use({
  extensions: [blockMath, inlineMath, wikilink, highlight],
  renderer: {
    // ```mermaid blocks -> inert placeholder keeping the source visible.
    // mermaid.ts (browser-only) swaps in the SVG after the HTML lands.
    code(token: Tokens.Code): string | false {
      if ((token.lang ?? "").trim().toLowerCase() === "mermaid") {
        return (
          `<div class="mermaid-block" data-diagram="mermaid">` +
          `<pre class="mermaid-source">${escapeHtml(token.text)}</pre></div>\n`
        );
      }
      return false; // fall back to the default code renderer
    },
    // `> [!NOTE]`-style callouts -> daisyUI alert blocks.
    blockquote(token: Tokens.Blockquote): string | false {
      const callout = calloutOf(token, (s) => md.lexer(s));
      if (!callout) return false;
      const body = md.parser(callout.tokens);
      return (
        `<div class="callout alert ${callout.cls}" data-callout="${callout.kind}" role="note">` +
        `<div class="callout-content"><p class="callout-title">${callout.title}</p>${body}</div>` +
        `</div>\n`
      );
    },
    // GFM tables with formula-cell support (sub-project ⑥ B): a cell whose raw
    // text starts with `=` shows its COMPUTED value in the reading view, exactly
    // like the live-preview TableWidget. Non-formula cells keep full inline
    // markdown. A1 row numbers index the BODY rows only (header excluded; first
    // data row = A1), so the live-preview and reading views agree.
    table(this: { parser: { parseInline(tokens: Token[]): string } }, token: Tokens.Table): string {
      const parsed: ParsedTable = {
        header: token.header.map((c) => c.text),
        align: token.align as Align[],
        rows: token.rows.map((row) => row.map((c) => c.text)),
      };
      const alignAttr = (a: Align): string => (a ? ` style="text-align:${a}"` : "");
      const renderCell = (raw: string, gridRow: number, col: number, tokens: Token[]): string => {
        if (isFormula(raw)) {
          const result = evalTableFormula(raw, parsed, { row: gridRow, col });
          if (isFormulaError(result)) {
            return (
              `<span class="cm-live-formula-error badge badge-sm badge-error" ` +
              `title="${escapeHtml(result.message)}">#ERR</span>`
            );
          }
          return `<span class="cm-live-formula-value">${escapeHtml(formatFormulaValue(result))}</span>`;
        }
        return this.parser.parseInline(tokens);
      };
      let head = "";
      token.header.forEach((cell, col) => {
        // Header sentinel row -1: never matched by an A1 ref (header excluded).
        head += `<th${alignAttr(cell.align as Align)}>${renderCell(cell.text, -1, col, cell.tokens)}</th>`;
      });
      let body = "";
      token.rows.forEach((row, r) => {
        let tr = "";
        row.forEach((cell, col) => {
          tr += `<td${alignAttr(cell.align as Align)}>${renderCell(cell.text, r, col, cell.tokens)}</td>`;
        });
        body += `<tr>${tr}</tr>`;
      });
      return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>\n`;
    },
  },
});

// --- Entry point --------------------------------------------------------------

/**
 * Render a full document (frontmatter + markdown body) to sanitized HTML.
 * Never throws: on any internal failure the source round-trips as escaped
 * plain text (ADR 0015 — rendering fidelity is the only risk, never data loss).
 */
export function renderMarkdown(src: string): string {
  try {
    const { html: fmHtml, body } = extractFrontmatter(src);
    const rendered = md.parse(body, { async: false }) as string;
    return sanitize(fmHtml + rendered);
  } catch {
    return `<pre class="render-fallback">${escapeHtml(src)}</pre>`;
  }
}
