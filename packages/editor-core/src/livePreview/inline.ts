// Inline live-preview decorations, viewport-scoped (editor redesign §Core).
//
// A ViewPlugin (not a StateField) because everything here is inline-level —
// heading line classes, hidden marker tokens, styled strong/em/strike/code,
// links, list markers, task checkboxes — and CM6 lets plugins provide exactly
// that (block widgets are blocks.ts's StateField). Rebuilding only over
// view.visibleRanges keeps per-keystroke cost proportional to the viewport,
// not the document.

import type { Range } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { collectInlineSpans, spanRevealed, type LiveSpan, type Range16 } from "./transform";
import { CheckboxWidget, InlineMathWidget } from "./widgets";

const markFor: Partial<Record<LiveSpan["kind"], Decoration>> = {
  strong: Decoration.mark({ class: "cm-live-strong" }),
  em: Decoration.mark({ class: "cm-live-em" }),
  strike: Decoration.mark({ class: "cm-live-strike" }),
  code: Decoration.mark({ class: "cm-live-inline-code" }),
  mark: Decoration.mark({ class: "cm-live-mark" }),
  listmark: Decoration.mark({ class: "cm-live-list-mark" }),
  image: Decoration.mark({ class: "cm-live-image-alt" }),
};

const hideMark = Decoration.replace({});

function linkMark(span: LiveSpan): Decoration {
  // data-live-href drives the cmd/ctrl+click handler in index.ts; the title
  // tooltip surfaces the hidden URL.
  return Decoration.mark({
    class: "cm-live-link",
    attributes: { "data-live-href": span.url ?? "", title: span.url ?? "" },
  });
}

function wikilinkMark(span: LiveSpan): Decoration {
  return Decoration.mark({
    class: "cm-live-wikilink",
    attributes: { "data-live-doc": span.slug ?? "", title: span.target ?? "" },
  });
}

function buildInline(view: EditorView): DecorationSet {
  const state = view.state;
  const doc = state.doc;
  const sel: Range16[] = state.selection.ranges.map((r) => ({ from: r.from, to: r.to }));
  const ranges: Range<Decoration>[] = [];
  const seenSpans = new Set<string>();
  const seenLines = new Set<string>();

  for (const vr of view.visibleRanges) {
    const from = doc.lineAt(vr.from).from;
    const to = doc.lineAt(vr.to).to;
    const { spans, lines } = collectInlineSpans(state, from, to);

    for (const l of lines) {
      const key = `${l.pos}:${l.cls}`;
      if (seenLines.has(key)) continue;
      seenLines.add(key);
      ranges.push(Decoration.line({ class: l.cls }).range(l.pos));
    }

    for (const span of spans) {
      const key = `${span.kind}:${span.from}:${span.to}`;
      if (seenSpans.has(key)) continue;
      seenSpans.add(key);

      // content styling applies whether or not markers are revealed
      if (
        span.contentFrom !== undefined &&
        span.contentTo !== undefined &&
        span.contentFrom < span.contentTo
      ) {
        const mark =
          span.kind === "link"
            ? linkMark(span)
            : span.kind === "wikilink"
              ? wikilinkMark(span)
              : markFor[span.kind];
        if (mark) ranges.push(mark.range(span.contentFrom, span.contentTo));
      }

      const revealed = spanRevealed(span, sel);
      if (revealed) continue;

      if (span.kind === "task") {
        ranges.push(
          Decoration.replace({ widget: new CheckboxWidget(span.checked === true) }).range(
            span.from,
            span.to,
          ),
        );
        continue;
      }
      if (span.kind === "math") {
        // replace the whole `$…$` source with the inline KaTeX render
        ranges.push(
          Decoration.replace({ widget: new InlineMathWidget(span.source ?? "") }).range(
            span.from,
            span.to,
          ),
        );
        continue;
      }
      for (const h of span.hide) {
        if (h.from >= h.to) continue;
        // plugins may not replace line breaks — reveal such markers instead
        if (doc.sliceString(h.from, h.to).includes("\n")) continue;
        ranges.push(hideMark.range(h.from, h.to));
      }
    }
  }
  return Decoration.set(ranges, true);
}

export const inlinePreview = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildInline(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged || u.selectionSet) {
        this.decorations = buildInline(u.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);
