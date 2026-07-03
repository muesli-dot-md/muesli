// Markdown-semantic editing commands behind the Docs-style toolbar
// (editor redesign §Toolbar). Every command is a pure transform:
// EditorState in, TransactionSpec out — the toolbar dispatches the spec on the
// live EditorView. Deliberately DOM-free and @codemirror/view-free so
// scripts/md-commands-test.mjs can drive the EXACT functions the toolbar uses
// headlessly under plain node (same pattern as livePreview/transform.ts).
//
// Inline toggles resolve the enclosing markdown node via the syntax tree (the
// state carries the same GFM parser Editor.svelte configures), so unwrapping
// uses lezer's exact marker positions instead of re-guessing `*` runs.

import {
  EditorSelection,
  type ChangeSpec,
  type EditorState,
  type TransactionSpec,
} from "@codemirror/state";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
// .ts extension: must resolve under plain `node` for the headless test.
import { frontmatterRange } from "./livePreview/transform.ts";

// --- inline marks (bold / italic / strikethrough / inline code) ---------------

export type InlineMark = "strong" | "em" | "strike" | "code";

const MARKER: Record<InlineMark, string> = { strong: "**", em: "*", strike: "~~", code: "`" };
const NODE: Record<InlineMark, string> = {
  strong: "StrongEmphasis",
  em: "Emphasis",
  strike: "Strikethrough",
  code: "InlineCode",
};
const MARK_NODE: Record<InlineMark, string> = {
  strong: "EmphasisMark",
  em: "EmphasisMark",
  strike: "StrikethroughMark",
  code: "CodeMark",
};

function treeFor(state: EditorState, upTo: number) {
  // The toolbar acts near the selection; 20ms is plenty for the local parse.
  return ensureSyntaxTree(state, Math.min(state.doc.length, upTo + 1), 20) ?? syntaxTree(state);
}

/** The enclosing mark node's marker ranges when [from,to] sits inside one. */
function enclosingMark(
  state: EditorState,
  mark: InlineMark,
  from: number,
  to: number,
): { open: { from: number; to: number }; close: { from: number; to: number } } | null {
  const tree = treeFor(state, to);
  for (let n = tree.resolveInner(from, 1) as ReturnType<typeof tree.resolveInner> | null; n; n = n.parent) {
    if (n.name === NODE[mark] && n.from <= from && n.to >= to) {
      const marks = n.getChildren(MARK_NODE[mark]);
      if (marks.length >= 2) {
        const open = marks[0];
        const close = marks[marks.length - 1];
        return { open: { from: open.from, to: open.to }, close: { from: close.from, to: close.to } };
      }
      return null;
    }
  }
  return null;
}

/** Toggle an inline style on every selection range. Empty ranges act on the
 * word under the cursor; with no word, an empty marker pair is inserted with
 * the cursor inside. */
export function toggleInlineMark(state: EditorState, mark: InlineMark): TransactionSpec {
  const marker = MARKER[mark];
  const len = marker.length;
  return state.changeByRange((range) => {
    let { from, to } = range;
    const wrapped = enclosingMark(state, mark, from, to);
    if (wrapped) {
      // unwrap: drop the node's marker tokens (positions straight from lezer)
      const removed = wrapped.open.to - wrapped.open.from;
      return {
        changes: [
          { from: wrapped.open.from, to: wrapped.open.to },
          { from: wrapped.close.from, to: wrapped.close.to },
        ],
        range: EditorSelection.range(
          Math.max(wrapped.open.from, from - removed),
          Math.max(wrapped.open.from, to - removed),
        ),
      };
    }
    if (from === to) {
      const word = state.wordAt(from);
      if (word) ({ from, to } = word);
    }
    if (from === to) {
      // nothing to wrap: open an empty pair, cursor in the middle
      return {
        changes: { from, insert: marker + marker },
        range: EditorSelection.cursor(from + len),
      };
    }
    // selection that itself includes the markers (e.g. user selected `**bold**`)
    const inner = state.doc.sliceString(from, to);
    if (inner.length >= 2 * len && inner.startsWith(marker) && inner.endsWith(marker)) {
      return {
        changes: [
          { from, to: from + len },
          { from: to - len, to },
        ],
        range: EditorSelection.range(from, to - 2 * len),
      };
    }
    return {
      changes: [
        { from, insert: marker },
        { from: to, insert: marker },
      ],
      range: EditorSelection.range(from + len, to + len),
    };
  });
}

/** Marks active at the main selection head (toolbar button highlight). */
export function activeInlineMarks(state: EditorState): Set<InlineMark> {
  const head = state.selection.main.head;
  const tree = treeFor(state, head);
  const names = new Map<string, InlineMark>([
    ["StrongEmphasis", "strong"],
    ["Emphasis", "em"],
    ["Strikethrough", "strike"],
    ["InlineCode", "code"],
  ]);
  const out = new Set<InlineMark>();
  for (let n = tree.resolveInner(head, -1) as ReturnType<typeof tree.resolveInner> | null; n; n = n.parent) {
    const mark = names.get(n.name);
    if (mark) out.add(mark);
  }
  return out;
}

// --- block styles (style dropdown) ---------------------------------------------

export type BlockStyle = "normal" | "h1" | "h2" | "h3" | "quote" | "codeblock";

const STYLE_PREFIX: Record<Exclude<BlockStyle, "codeblock">, string> = {
  normal: "",
  h1: "# ",
  h2: "## ",
  h3: "### ",
  quote: "> ",
};

/** Strip heading/quote markers from a line, keeping list markers and text. */
function stripBlockPrefix(text: string): { indent: string; rest: string } {
  const m = /^(\s*)((?:>\s?)*)(#{1,6}\s+)?(.*)$/.exec(text)!;
  return { indent: m[1], rest: m[4] };
}

/** Apply a paragraph style to every line the selection touches. The dropdown
 * SETS the style (Docs semantics); "normal" strips heading/quote markers. */
export function setBlockStyle(state: EditorState, style: BlockStyle): TransactionSpec {
  if (style === "codeblock") return toggleCodeBlock(state);
  const prefix = STYLE_PREFIX[style];
  const changes: ChangeSpec[] = [];
  const main = state.selection.main;
  const fromLine = state.doc.lineAt(main.from).number;
  const toLine = state.doc.lineAt(main.to).number;
  for (let i = fromLine; i <= toLine; i++) {
    const line = state.doc.line(i);
    if (line.text.trim() === "" && fromLine !== toLine) continue; // skip blanks in multi-line selections
    const { indent, rest } = stripBlockPrefix(line.text);
    const replacement = indent + prefix + rest;
    if (replacement !== line.text) {
      changes.push({ from: line.from, to: line.to, insert: replacement });
    }
  }
  return { changes };
}

/** Wrap the selected lines in ``` fences; unwrap when they are already fenced. */
function toggleCodeBlock(state: EditorState): TransactionSpec {
  const main = state.selection.main;
  const startLine = state.doc.lineAt(main.from);
  const endLine = state.doc.lineAt(main.to);
  const before = startLine.number > 1 ? state.doc.line(startLine.number - 1) : null;
  const after = endLine.number < state.doc.lines ? state.doc.line(endLine.number + 1) : null;
  if (before && after && /^(```|~~~)/.test(before.text) && /^(```|~~~)\s*$/.test(after.text)) {
    return {
      changes: [
        { from: before.from, to: startLine.from },
        { from: endLine.to, to: after.to },
      ],
    };
  }
  return {
    changes: [
      { from: startLine.from, insert: "```\n" },
      { from: endLine.to, insert: "\n```" },
    ],
  };
}

/** The style of the line under the main selection head (dropdown label). */
export function currentBlockStyle(state: EditorState): BlockStyle {
  const head = state.selection.main.head;
  const tree = treeFor(state, head);
  for (let n = tree.resolveInner(head, -1) as ReturnType<typeof tree.resolveInner> | null; n; n = n.parent) {
    if (n.name === "FencedCode" || n.name === "CodeBlock") return "codeblock";
  }
  const text = state.doc.lineAt(head).text;
  const h = /^\s*(#{1,6})\s+/.exec(text);
  if (h) return h[1].length === 1 ? "h1" : h[1].length === 2 ? "h2" : h[1].length === 3 ? "h3" : "normal";
  if (/^\s*>/.test(text)) return "quote";
  return "normal";
}

// --- lists (checklist / bulleted / numbered) -------------------------------------

export type ListKind = "bullet" | "ordered" | "task";

const TASK_RE = /^(\s*)[-*+]\s+\[[ xX]\]\s+(.*)$/;
const BULLET_RE = /^(\s*)[-*+]\s+(.*)$/;
const ORDERED_RE = /^(\s*)\d+[.)]\s+(.*)$/;

function lineListKind(text: string): ListKind | null {
  if (TASK_RE.test(text)) return "task";
  if (BULLET_RE.test(text)) return "bullet";
  if (ORDERED_RE.test(text)) return "ordered";
  return null;
}

function stripListPrefix(text: string): { indent: string; rest: string } {
  const m = TASK_RE.exec(text) ?? BULLET_RE.exec(text) ?? ORDERED_RE.exec(text);
  if (m) return { indent: m[1], rest: m[2] };
  const ws = /^(\s*)(.*)$/.exec(text)!;
  return { indent: ws[1], rest: ws[2] };
}

/** Toggle a list style across the selected lines: when every non-blank line
 * already has the kind, strip back to plain text; otherwise (re)write the
 * prefix — numbered lists renumber from 1. */
export function toggleList(state: EditorState, kind: ListKind): TransactionSpec {
  const main = state.selection.main;
  const fromLine = state.doc.lineAt(main.from).number;
  const toLine = state.doc.lineAt(main.to).number;
  const lines = [];
  for (let i = fromLine; i <= toLine; i++) lines.push(state.doc.line(i));
  const targets = lines.filter((l) => l.text.trim() !== "" || lines.length === 1);
  const allKind = targets.length > 0 && targets.every((l) => lineListKind(l.text) === kind);
  const changes: ChangeSpec[] = [];
  // A bare {changes} spec maps a caret inside a replaced line to the change
  // START — i.e. BEFORE the fresh "1. " marker, so typing lands ahead of it.
  // For an empty selection (necessarily a single line) place the caret
  // explicitly: same offset within the line content, right after the marker.
  let newHead: number | null = null;
  let n = 1;
  for (const line of targets) {
    const { indent, rest } = stripListPrefix(line.text);
    const prefix = allKind
      ? ""
      : kind === "bullet"
        ? "- "
        : kind === "task"
          ? "- [ ] "
          : `${n++}. `;
    const replacement = indent + prefix + rest;
    if (replacement === line.text) continue;
    changes.push({ from: line.from, to: line.to, insert: replacement });
    if (main.empty) {
      const restStart = line.length - rest.length; // old indent + old marker
      const offsetInRest = Math.max(0, Math.min(main.head - line.from - restStart, rest.length));
      newHead = line.from + indent.length + prefix.length + offsetInRest;
    }
  }
  return newHead === null
    ? { changes }
    : { changes, selection: EditorSelection.cursor(newHead) };
}

/** The list kind of the main selection head's line (toolbar active state). */
export function currentListKind(state: EditorState): ListKind | null {
  return lineListKind(state.doc.lineAt(state.selection.main.head).text);
}

// --- link ---------------------------------------------------------------------------

export function isProbablyUrl(s: string): boolean {
  return /^(https?:\/\/|www\.)\S+$/i.test(s.trim());
}

/** Replace the main selection with `[text](url)`; empty text falls back to the
 * url so the link never renders blank. */
export function insertLink(state: EditorState, text: string, url: string): TransactionSpec {
  const main = state.selection.main;
  const insert = `[${text || url}](${url})`;
  return {
    changes: { from: main.from, to: main.to, insert },
    selection: EditorSelection.cursor(main.from + insert.length),
  };
}

// --- insert menu snippets -----------------------------------------------------------

export function tableSkeleton(cols = 3, rows = 2): string {
  const row = (cell: string) => `|${Array.from({ length: cols }, () => ` ${cell} `).join("|")}|`;
  return [row(" "), row("---"), ...Array.from({ length: rows }, () => row(" "))].join("\n");
}

export const SNIPPETS = {
  hr: "---",
  codeblock: "```\n\n```",
  math: "$$\n\n$$",
  mermaid: "```mermaid\ngraph TD;\n  A-->B;\n```",
  callout: "> [!NOTE]\n> ",
  wikilink: "[[]]",
} as const;

/** Cursor offset (from snippet start) that leaves the caret at the natural
 * editing point of each snippet. */
export const SNIPPET_CURSOR: Record<keyof typeof SNIPPETS, number> = {
  hr: SNIPPETS.hr.length,
  codeblock: 4, // inside the fence
  math: 3, // inside the $$ block
  mermaid: SNIPPETS.mermaid.length,
  callout: SNIPPETS.callout.length,
  wikilink: 2, // between the brackets
};

/** Insert a multi-line snippet as its own block at the main selection head:
 * appended after the current line, separated by a blank line when the line has
 * content. `cursorOffset` is relative to the snippet's first character. */
export function insertBlockSnippet(
  state: EditorState,
  snippet: string,
  cursorOffset = snippet.length,
): TransactionSpec {
  const main = state.selection.main;
  const line = state.doc.lineAt(main.head);
  const emptyLine = line.text.trim() === "";
  const pos = line.to;
  const prefix = emptyLine ? "" : "\n\n";
  // one trailing newline: the line's own "\n" (still ahead of `pos`) provides
  // the blank-line separation from whatever follows
  const suffix = "\n";
  return {
    changes: { from: pos, insert: prefix + snippet + suffix },
    selection: EditorSelection.cursor(pos + prefix.length + cursorOffset),
  };
}

/** Inline snippets (wikilink) go at the cursor / replace the selection. */
export function insertInlineSnippet(
  state: EditorState,
  snippet: string,
  cursorOffset = snippet.length,
): TransactionSpec {
  const main = state.selection.main;
  return {
    changes: { from: main.from, to: main.to, insert: snippet },
    selection: EditorSelection.cursor(main.from + cursorOffset),
  };
}

/** Wrap the selected text in a wikilink (or open an empty one). */
export function insertWikilink(state: EditorState): TransactionSpec {
  const main = state.selection.main;
  const target = state.doc.sliceString(main.from, main.to);
  const insert = `[[${target}]]`;
  return {
    changes: { from: main.from, to: main.to, insert },
    selection: EditorSelection.cursor(main.from + (target ? insert.length : 2)),
  };
}

// --- outline (left rail) --------------------------------------------------------------

export type OutlineItem = { level: number; text: string; from: number };

/** ATX headings from raw markdown, skipping fenced code and frontmatter.
 * Pure text scan (no parser) so the outline rail can run it debounced on
 * every ytext update without touching the editor. */
export function parseOutline(docText: string): OutlineItem[] {
  const fm = frontmatterRange(docText);
  const items: OutlineItem[] = [];
  let pos = 0;
  let fence: string | null = null;
  for (const line of docText.split("\n")) {
    const skip = fm !== null && pos < fm.to;
    if (!skip) {
      const f = /^(```+|~~~+)/.exec(line);
      if (f) {
        if (fence === null) fence = f[1][0];
        else if (f[1][0] === fence) fence = null;
      } else if (fence === null) {
        const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
        if (m) items.push({ level: m[1].length, text: m[2], from: pos });
      }
    }
    pos += line.length + 1;
  }
  return items;
}
