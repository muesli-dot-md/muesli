// CodeMirror 6 decorations for collaboration state (ADR 0019):
//   - comment anchors: subtle highlight over each open thread's range
//   - pending suggestions: deletion ranges struck through / red-tinted,
//     insertions shown as an inline green widget at the edit position
//   - a transient "flash" used when a sidebar card is clicked
//
// The store recomputes ranges (server byte offsets -> UTF-16, offsets.ts) on
// every refetch and dispatches setCollabDecorations wholesale. Between
// refetches, local edits keep decorations aligned because the StateField maps
// its DecorationSet through every transaction's changes.

import { StateEffect, StateField } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, type DecorationSet } from "@codemirror/view";

export type CommentHighlight = { from: number; to: number; threadId: string };
export type SuggestionHighlight = { from: number; to: number; insert: string; id: string };

export const setCollabDecorations = StateEffect.define<{
  comments: CommentHighlight[];
  suggestions: SuggestionHighlight[];
}>();

/** Highlight a range briefly (sidebar card click). `null` clears it. */
export const setFlashRange = StateEffect.define<{ from: number; to: number } | null>();

class InsertionWidget extends WidgetType {
  text: string;
  constructor(text: string) {
    super();
    this.text = text;
  }
  eq(other: InsertionWidget): boolean {
    return other.text === this.text;
  }
  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-suggest-insertion";
    span.textContent = this.text;
    return span;
  }
  ignoreEvent(): boolean {
    return true;
  }
}

// One mark per thread (cached) so the highlight DOM carries the thread id and
// a click can route to the right sidebar card.
const commentMarks = new Map<string, Decoration>();
function commentMark(threadId: string): Decoration {
  let mark = commentMarks.get(threadId);
  if (!mark) {
    mark = Decoration.mark({
      class: "cm-comment-anchor",
      attributes: { "data-thread-id": threadId },
    });
    commentMarks.set(threadId, mark);
  }
  return mark;
}

/** Clicking a comment highlight reveals its thread in the sidebar. */
export function commentClickHandler(onClick: (threadId: string) => void) {
  return EditorView.domEventHandlers({
    click(e) {
      const anchor = (e.target as HTMLElement).closest?.(".cm-comment-anchor[data-thread-id]");
      const threadId = anchor?.getAttribute("data-thread-id");
      if (threadId) onClick(threadId);
      return false; // never swallow the editor's own selection handling
    },
  });
}
const deletionMark = Decoration.mark({ class: "cm-suggest-deletion" });
const flashMark = Decoration.mark({ class: "cm-collab-flash" });

function clampRange(from: number, to: number, docLen: number): [number, number] {
  const a = Math.max(0, Math.min(from, docLen));
  const b = Math.max(a, Math.min(to, docLen));
  return [a, b];
}

function buildDecorations(
  spec: { comments: CommentHighlight[]; suggestions: SuggestionHighlight[] },
  docLen: number,
): DecorationSet {
  const ranges = [];
  for (const c of spec.comments) {
    const [from, to] = clampRange(c.from, c.to, docLen);
    if (from < to) ranges.push(commentMark(c.threadId).range(from, to));
  }
  for (const s of spec.suggestions) {
    const [from, to] = clampRange(s.from, s.to, docLen);
    if (from < to) ranges.push(deletionMark.range(from, to));
    if (s.insert) {
      ranges.push(Decoration.widget({ widget: new InsertionWidget(s.insert), side: 1 }).range(to));
    }
  }
  // sort=true: callers pass ranges in API order, not document order.
  return Decoration.set(ranges, true);
}

const collabField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setCollabDecorations)) deco = buildDecorations(e.value, tr.state.doc.length);
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

const flashField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setFlashRange)) {
        if (e.value === null) {
          deco = Decoration.none;
        } else {
          const [from, to] = clampRange(e.value.from, e.value.to, tr.state.doc.length);
          deco = from < to ? Decoration.set([flashMark.range(from, to)]) : Decoration.none;
        }
      }
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

export const collabDecorations = [collabField, flashField];
