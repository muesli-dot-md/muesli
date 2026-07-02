// Pure transforms for the live-preview layer (editor redesign §Core).
//
// Everything here is DOM-free and @codemirror/view-free so it runs headlessly
// (scripts/live-preview-test.mjs): given an EditorState (+ its markdown syntax
// tree) these helpers compute WHICH ranges to hide/style/replace; the actual
// Decoration objects are built in inline.ts / blocks.ts. All offsets are
// UTF-16 code units, straight from the lezer tree, so multibyte text needs no
// conversion (the byte<->UTF-16 dance only exists at the server boundary).

import type { EditorState } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import type { SyntaxNode, Tree } from "@lezer/common";
// .ts extension: this module must resolve under plain `node` too
// (scripts/live-preview-test.mjs runs it headlessly with type stripping).
import { slugify } from "@muesli/editor-core/render";

export type Range16 = { from: number; to: number };

export type SpanKind =
  | "heading"
  | "strong"
  | "em"
  | "strike"
  | "code"
  | "mark"
  | "math"
  | "link"
  | "image"
  | "task"
  | "listmark"
  | "quote"
  | "wikilink";

/** One renderable inline construct: its extent, the marker ranges to hide
 * while the selection stays outside `reveal`, and styling extras per kind. */
export type LiveSpan = {
  kind: SpanKind;
  from: number;
  to: number;
  /** Selection touching this range reveals the raw markers (Obsidian behavior). */
  reveal: Range16;
  /** Marker ranges hidden via replace decorations when not revealed. */
  hide: Range16[];
  /** Styled content (bold text, link label, image alt, list marker…). */
  contentFrom?: number;
  contentTo?: number;
  level?: number; // heading
  url?: string; // link / image
  slug?: string; // wikilink router target
  target?: string; // wikilink raw target
  checked?: boolean; // task
  source?: string; // inline math (KaTeX tex)
};

export type LineStyle = { pos: number; cls: string };

export type LiveBlock = {
  kind: "table" | "mermaid" | "math" | "hr";
  from: number; // full-line extent
  to: number;
  source: string;
};

export type LiveImage = { linePos: number; from: number; to: number; url: string; alt: string };

// --- selection / reveal math --------------------------------------------------

/** Inclusive intersection: a cursor sitting on either edge counts as inside. */
export function rangesTouch(a: Range16, b: Range16): boolean {
  return a.from <= b.to && a.to >= b.from;
}

export function selectionTouches(sel: readonly Range16[], range: Range16): boolean {
  return sel.some((r) => rangesTouch(r, range));
}

/** True when any selection range intersects the span's reveal extent —
 * multiple selections each reveal their own spans. */
export function spanRevealed(span: LiveSpan, sel: readonly Range16[]): boolean {
  return selectionTouches(sel, span.reveal);
}

/** The marker ranges that should be hidden for the given selection: every
 * span's `hide` ranges except where the selection reveals the span. */
export function hiddenRanges(spans: readonly LiveSpan[], sel: readonly Range16[]): Range16[] {
  const out: Range16[] = [];
  for (const span of spans) {
    if (spanRevealed(span, sel)) continue;
    for (const h of span.hide) if (h.from < h.to) out.push(h);
  }
  return out.sort((a, b) => a.from - b.from || a.to - b.to);
}

// --- frontmatter ----------------------------------------------------------------
// Canonical implementation lives in editor-core (mdCommands needs it too);
// re-exported here for the live-preview callers below, which suppress all
// decoration inside the range and style it as dim metadata instead.
import { frontmatterRange } from "@muesli/editor-core/frontmatter";
export { frontmatterRange };

// --- inline spans ------------------------------------------------------------

const HEADING_RE = /^ATXHeading([1-6])$/;
/** Syntax-node names that mean "inside code" — wikilink/math regexes must not fire here. */
const CODE_CONTEXT =
  /^(FencedCode|CodeBlock|InlineCode|CodeText|CodeInfo|CodeMark|HTMLBlock|CommentBlock)$/;

/** Matches render.ts's wikilink tokenizer: [[Target]] / [[Target|label]]. */
const WIKILINK_RE = /\[\[([^[\]|\n]+?)(?:\|([^[\]\n]+?))?\]\]/g;

/** `==text==` highlight, mirroring render.ts's highlight tokenizer: no leading/
 * trailing whitespace, single line, so stray `==` runs are left alone. */
const HIGHLIGHT_RE = /==(?!\s)([^\n]+?)(?<!\s)==/g;

/** Inline `$math$`, mirroring render.ts's inlineMath: non-space chars adjacent
 * to both `$`, balanced on one line, never a lone `$` / currency. A `\$` is a
 * literal escape, so the opening `$` must not be preceded by a backslash. */
const INLINE_MATH_RE = /(?<!\\)\$(?!\s)([^$\n]+?)(?<!\s)\$/g;

function inCodeContext(tree: Tree, pos: number): boolean {
  for (let n: SyntaxNode | null = tree.resolveInner(pos, 1); n; n = n.parent) {
    if (CODE_CONTEXT.test(n.name)) return true;
  }
  return false;
}

function lineExtent(state: EditorState, pos: number): Range16 {
  const line = state.doc.lineAt(pos);
  return { from: line.from, to: line.to };
}

/** Find wikilinks in [from, to) outside code contexts. Returned spans hide the
 * brackets and the `Target|` part, keeping the label styled + clickable. */
export function findWikilinks(
  state: EditorState,
  from: number,
  to: number,
  tree: Tree = syntaxTree(state),
): LiveSpan[] {
  const text = state.doc.sliceString(from, to);
  const spans: LiveSpan[] = [];
  WIKILINK_RE.lastIndex = 0;
  for (let m = WIKILINK_RE.exec(text); m; m = WIKILINK_RE.exec(text)) {
    const start = from + m.index;
    const end = start + m[0].length;
    if (inCodeContext(tree, start)) continue;
    const target = m[1].trim();
    const slug = slugify(target);
    if (!slug) continue;
    // label region: after `[[` (+ `Target|` when a label is present), before `]]`.
    const labelFrom = m[2] !== undefined ? start + 2 + m[1].length + 1 : start + 2;
    const labelTo = end - 2;
    spans.push({
      kind: "wikilink",
      from: start,
      to: end,
      reveal: { from: start, to: end },
      hide: [
        { from: start, to: labelFrom },
        { from: labelTo, to: end },
      ],
      contentFrom: labelFrom,
      contentTo: labelTo,
      slug,
      target,
    });
  }
  return spans;
}

function marksOf(node: SyntaxNode, markName: string): Range16[] {
  return node.getChildren(markName).map((m) => ({ from: m.from, to: m.to }));
}

/** `==highlight==` spans in [from, to) outside code contexts. The `==` markers
 * hide while not revealed; the content styles as <mark>. Lezer has no highlight
 * node, so this is a regex scan like findWikilinks. */
export function findHighlights(
  state: EditorState,
  from: number,
  to: number,
  tree: Tree = syntaxTree(state),
): LiveSpan[] {
  const text = state.doc.sliceString(from, to);
  const spans: LiveSpan[] = [];
  HIGHLIGHT_RE.lastIndex = 0;
  for (let m = HIGHLIGHT_RE.exec(text); m; m = HIGHLIGHT_RE.exec(text)) {
    const start = from + m.index;
    const end = start + m[0].length;
    if (inCodeContext(tree, start)) continue;
    const contentFrom = start + 2;
    const contentTo = end - 2;
    spans.push({
      kind: "mark",
      from: start,
      to: end,
      reveal: { from: start, to: end },
      hide: [
        { from: start, to: contentFrom },
        { from: contentTo, to: end },
      ],
      contentFrom,
      contentTo,
    });
  }
  return spans;
}

/** Inline `$math$` spans in [from, to) outside code contexts. While not
 * revealed the whole `$…$` is replaced by a KaTeX widget (inline.ts); the
 * source tex rides on `span.source`. Mirrors render.ts's inlineMath guards. */
export function findInlineMath(
  state: EditorState,
  from: number,
  to: number,
  tree: Tree = syntaxTree(state),
): LiveSpan[] {
  const text = state.doc.sliceString(from, to);
  const spans: LiveSpan[] = [];
  INLINE_MATH_RE.lastIndex = 0;
  for (let m = INLINE_MATH_RE.exec(text); m; m = INLINE_MATH_RE.exec(text)) {
    const start = from + m.index;
    const end = start + m[0].length;
    if (inCodeContext(tree, start)) continue;
    spans.push({
      kind: "math",
      from: start,
      to: end,
      reveal: { from: start, to: end },
      hide: [],
      contentFrom: start,
      contentTo: end,
      source: m[1],
    });
  }
  return spans;
}

/** Collect inline spans + per-line style classes for [from, to). The caller
 * passes line-aligned bounds (viewport expanded to whole lines). */
export function collectInlineSpans(
  state: EditorState,
  from: number,
  to: number,
  tree: Tree = syntaxTree(state),
): { spans: LiveSpan[]; lines: LineStyle[] } {
  const spans: LiveSpan[] = [];
  const lines: LineStyle[] = [];
  const doc = state.doc;
  const fm = frontmatterRange(doc.sliceString(0, Math.min(doc.length, 8192)));
  const inFrontmatter = (a: number) => fm !== null && a < fm.to;

  if (fm && fm.from < to && fm.to > from) {
    for (let p = fm.from; p < Math.min(fm.to, to + 1);) {
      const line = doc.lineAt(p);
      lines.push({ pos: line.from, cls: "cm-live-frontmatter" });
      p = line.to + 1;
    }
  }

  // Wikilinks first; lezer half-parses `[[x]]` as a Link, so tree spans that
  // overlap a wikilink are suppressed below.
  const wikis = findWikilinks(state, from, to, tree).filter((w) => !inFrontmatter(w.from));
  spans.push(...wikis);
  const overlapsWiki = (a: number, b: number) => wikis.some((w) => a < w.to && b > w.from);

  // Inline `$math$` is replaced wholesale by a KaTeX widget when not revealed,
  // so any lezer span inside it must be suppressed (its inner `$`/markers would
  // fight the replace). `==highlight==` keeps inner markdown, so it does NOT
  // suppress tree spans.
  const maths = findInlineMath(state, from, to, tree).filter((s) => !inFrontmatter(s.from));
  const highlights = findHighlights(state, from, to, tree).filter(
    (s) => !inFrontmatter(s.from) && !maths.some((mt) => s.from < mt.to && s.to > mt.from),
  );
  spans.push(...maths, ...highlights);
  const overlapsMath = (a: number, b: number) => maths.some((mt) => a < mt.to && b > mt.from);

  const pushLineRange = (a: number, b: number, cls: string) => {
    for (let p = Math.max(a, from); p <= Math.min(b, to);) {
      const line = doc.lineAt(p);
      lines.push({ pos: line.from, cls });
      if (line.to >= b) break;
      p = line.to + 1;
    }
  };

  tree.iterate({
    from,
    to,
    enter(node) {
      if (inFrontmatter(node.from)) return node.name === "Document" ? undefined : false;
      const name = node.name;

      if (name === "FencedCode" || name === "CodeBlock") {
        pushLineRange(node.from, node.to, "cm-live-codeline");
        if (name === "FencedCode") {
          lines.push({ pos: doc.lineAt(node.from).from, cls: "cm-live-codefence" });
          const lastLine = doc.lineAt(node.to);
          if (lastLine.from !== doc.lineAt(node.from).from)
            lines.push({ pos: lastLine.from, cls: "cm-live-codefence" });
        }
        return false; // no inline rendering inside code; highlighting is a separate facet
      }

      if (name === "Blockquote") {
        pushLineRange(node.from, node.to, "cm-live-blockquote");
        return; // descend for QuoteMark + nested inline styles
      }

      if (name === "QuoteMark") {
        // hide `>` plus one following space; reveal while the cursor is on the line
        const after = doc.sliceString(node.to, node.to + 1) === " " ? node.to + 1 : node.to;
        spans.push({
          kind: "quote",
          from: node.from,
          to: after,
          reveal: lineExtent(state, node.from),
          hide: [{ from: node.from, to: after }],
        });
        return;
      }

      const h = HEADING_RE.exec(name);
      if (h) {
        const level = Number(h[1]);
        lines.push({ pos: doc.lineAt(node.from).from, cls: `cm-live-heading cm-live-h${level}` });
        const marks = node.node.getChildren("HeaderMark");
        const hide: Range16[] = [];
        if (marks.length > 0) {
          const lead = marks[0];
          const afterLead = doc.sliceString(lead.to, lead.to + 1) === " " ? lead.to + 1 : lead.to;
          hide.push({ from: lead.from, to: afterLead });
          // optional closing ### marker
          for (const m of marks.slice(1)) {
            const before = doc.sliceString(m.from - 1, m.from) === " " ? m.from - 1 : m.from;
            hide.push({ from: before, to: m.to });
          }
        }
        spans.push({
          kind: "heading",
          from: node.from,
          to: node.to,
          reveal: lineExtent(state, node.from),
          hide,
          level,
        });
        return;
      }

      if (name === "SetextHeading1" || name === "SetextHeading2") {
        const level = name.endsWith("1") ? 1 : 2;
        lines.push({ pos: doc.lineAt(node.from).from, cls: `cm-live-heading cm-live-h${level}` });
        const mark = node.node.getChild("HeaderMark");
        if (mark) lines.push({ pos: doc.lineAt(mark.from).from, cls: "cm-live-setext-mark" });
        return;
      }

      if (name === "Table") {
        pushLineRange(node.from, node.to, "cm-live-tableline");
        return false; // the block field renders it; raw rows stay monospace
      }

      if (
        (name === "StrongEmphasis" ||
          name === "Emphasis" ||
          name === "Strikethrough" ||
          name === "InlineCode") &&
        !overlapsWiki(node.from, node.to) &&
        !overlapsMath(node.from, node.to)
      ) {
        const markName =
          name === "Strikethrough"
            ? "StrikethroughMark"
            : name === "InlineCode"
              ? "CodeMark"
              : "EmphasisMark";
        const hide = marksOf(node.node, markName);
        const inner =
          hide.length >= 2 ? { from: hide[0].to, to: hide[hide.length - 1].from } : null;
        spans.push({
          kind:
            name === "StrongEmphasis"
              ? "strong"
              : name === "Emphasis"
                ? "em"
                : name === "Strikethrough"
                  ? "strike"
                  : "code",
          from: node.from,
          to: node.to,
          reveal: { from: node.from, to: node.to },
          hide,
          contentFrom: inner?.from ?? node.from,
          contentTo: inner?.to ?? node.to,
        });
        return;
      }

      if ((name === "Link" || name === "Image") && !overlapsWiki(node.from, node.to)) {
        const n = node.node;
        const marks = n.getChildren("LinkMark");
        const urlNode = n.getChild("URL");
        if (marks.length < 2) return;
        const labelFrom = marks[0].to;
        const labelTo = marks[1].from;
        const hide: Range16[] = [{ from: marks[0].from, to: marks[0].to }];
        // hide from `](` through the closing `)` (URL, title and all)
        hide.push({ from: marks[1].from, to: node.to });
        spans.push({
          kind: name === "Link" ? "link" : "image",
          from: node.from,
          to: node.to,
          reveal: { from: node.from, to: node.to },
          hide,
          contentFrom: labelFrom,
          contentTo: labelTo,
          url: urlNode ? doc.sliceString(urlNode.from, urlNode.to) : "",
        });
        return;
      }

      if (name === "ListMark") {
        spans.push({
          kind: "listmark",
          from: node.from,
          to: node.to,
          reveal: { from: node.from, to: node.to },
          hide: [],
          contentFrom: node.from,
          contentTo: node.to,
        });
        return;
      }

      if (name === "TaskMarker") {
        const raw = doc.sliceString(node.from, node.to);
        spans.push({
          kind: "task",
          from: node.from,
          to: node.to,
          reveal: lineExtent(state, node.from),
          hide: [{ from: node.from, to: node.to }],
          checked: /x/i.test(raw),
        });
        return;
      }
      return;
    },
  });

  return { spans, lines };
}

// --- task checkboxes -----------------------------------------------------------

/** Change spec flipping a `[ ]`/`[x]` task marker at `pos` (the `[`).
 * A one-character replacement, so it travels through Yjs as a minimal
 * CRDT delete+insert. Returns null when `pos` is not on a marker. */
export function checkboxToggle(
  state: EditorState,
  pos: number,
): { from: number; to: number; insert: string } | null {
  const m = /^\[([ xX])\]/.exec(state.doc.sliceString(pos, pos + 3));
  if (!m) return null;
  return { from: pos + 1, to: pos + 2, insert: m[1] === " " ? "x" : " " };
}

// --- tables ---------------------------------------------------------------------
// The table model (parse, serialize, mutate, formula eval) lives in
// @muesli/editor-core/tableModel so both apps share ONE copy (sub-project ⑥ B).
// Re-exported here so existing importers (blocks.ts, the headless test script)
// keep their `./transform` import paths.

export { parseTableMarkdown, type ParsedTable } from "@muesli/editor-core/tableModel";

// --- blocks ----------------------------------------------------------------------

/** Display-math blocks, same syntax render.ts's blockMath accepts: a line
 * starting `$$`, closed by `$$` at a line end (possibly the same line).
 * Skips code contexts and frontmatter. */
export function findMathBlocks(state: EditorState, tree: Tree = syntaxTree(state)): LiveBlock[] {
  const doc = state.doc;
  const fm = frontmatterRange(doc.sliceString(0, Math.min(doc.length, 8192)));
  const blocks: LiveBlock[] = [];
  for (let i = 1; i <= doc.lines; i++) {
    const line = doc.line(i);
    if (!line.text.startsWith("$$")) continue;
    if (fm && line.from < fm.to) continue;
    if (inCodeContext(tree, line.from)) continue;
    const single = /^\$\$(.+?)\$\$\s*$/.exec(line.text);
    if (single) {
      blocks.push({ kind: "math", from: line.from, to: line.to, source: single[1].trim() });
      continue;
    }
    // multi-line: scan for the closing $$ line
    for (let j = i + 1; j <= doc.lines; j++) {
      const end = doc.line(j);
      if (/\$\$\s*$/.test(end.text)) {
        const source = doc
          .sliceString(line.from + 2, end.to)
          .replace(/\$\$\s*$/, "")
          .trim();
        blocks.push({ kind: "math", from: line.from, to: end.to, source });
        i = j;
        break;
      }
    }
  }
  return blocks;
}

/** Collect the replaceable blocks: tables, ```mermaid fences, math blocks,
 * horizontal rules. Extents are full-line so block replace decorations are
 * legal. Images are collected separately (widget below the line, no replace). */
export function collectBlocks(state: EditorState, tree: Tree = syntaxTree(state)): LiveBlock[] {
  const doc = state.doc;
  const fm = frontmatterRange(doc.sliceString(0, Math.min(doc.length, 8192)));
  const blocks: LiveBlock[] = [];
  tree.iterate({
    enter(node) {
      if (fm && node.from < fm.to && node.name !== "Document") return false;
      if (node.name === "Table") {
        const from = doc.lineAt(node.from).from;
        const to = doc.lineAt(node.to).to;
        blocks.push({ kind: "table", from, to, source: doc.sliceString(from, to) });
        return false;
      }
      if (node.name === "FencedCode") {
        const info = node.node.getChild("CodeInfo");
        const lang = info ? doc.sliceString(info.from, info.to).trim().toLowerCase() : "";
        if (lang === "mermaid") {
          const text = node.node.getChild("CodeText");
          blocks.push({
            kind: "mermaid",
            from: doc.lineAt(node.from).from,
            to: doc.lineAt(node.to).to,
            source: text ? doc.sliceString(text.from, text.to) : "",
          });
        }
        return false;
      }
      if (node.name === "HorizontalRule") {
        const line = doc.lineAt(node.from);
        blocks.push({ kind: "hr", from: line.from, to: line.to, source: line.text });
        return false;
      }
      return;
    },
  });
  blocks.push(...findMathBlocks(state, tree));
  return blocks.sort((a, b) => a.from - b.from);
}

/** Inline images -> a widget below their line (the inline syntax hiding is a
 * LiveSpan). Only http(s)/data:image sources are rendered. */
export function collectImages(state: EditorState, tree: Tree = syntaxTree(state)): LiveImage[] {
  const doc = state.doc;
  const images: LiveImage[] = [];
  tree.iterate({
    enter(node) {
      if (CODE_CONTEXT.test(node.name)) return false;
      if (node.name !== "Image") return;
      const n = node.node;
      const urlNode = n.getChild("URL");
      if (!urlNode) return;
      const url = doc.sliceString(urlNode.from, urlNode.to);
      if (!/^(https?:|data:image\/)/i.test(url)) return;
      const marks = n.getChildren("LinkMark");
      const alt = marks.length >= 2 ? doc.sliceString(marks[0].to, marks[1].from) : "";
      images.push({ linePos: doc.lineAt(node.from).to, from: node.from, to: node.to, url, alt });
      return;
    },
  });
  return images;
}
