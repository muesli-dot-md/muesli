// VSCode/Atom-style "scroll beyond last line" for CodeMirror 6.
//
// Adds bottom padding to the scrollable content (.cm-content) so the viewport
// can scroll PAST the end of the document — the last line can be scrolled up to
// sit near the TOP of the viewport instead of being pinned at the bottom. This
// is purely visual breathing room: it adds NO text/newlines to the document and
// never touches the underlying markdown.
//
// The padding is dynamic: a ViewPlugin measures the editor's viewport height
// (scrollDOM.clientHeight) and the line height, and sizes the padding so the
// last line reaches one line-height below the top (VSCode's exact behavior). It
// re-measures on geometry changes (resize, content height changes), so it
// adapts to the desktop editor pane and the webapp editor having different
// heights. The value is bounded by the viewport height — it is finite and small,
// never an infinite/runaway scroll region.
//
// The padding sits BELOW the content, so it does not affect the line gutter,
// the live-preview block widgets (tables/mermaid), the reading view, or the
// document text. Because the last lines can now scroll toward the center, the
// comment-anchor "reveal thread into view" scroll has more room and reads
// better rather than jamming the anchor against the bottom edge.

import { EditorView, ViewPlugin, type PluginValue, type ViewUpdate } from "@codemirror/view";

// Fallback line height used only when the editor cannot report one yet (e.g.
// first measure before layout). ~1.4 * a typical 14px font.
const FALLBACK_LINE_HEIGHT = 20;

/**
 * Bottom padding (px) that lets the last line scroll up to one line-height below
 * the top of the viewport — VSCode's "scroll beyond last line" feel.
 *
 * Bounded: the result is `viewportHeight - lineHeight`, clamped to be
 * non-negative and never NaN, so it is always a finite value smaller than the
 * viewport (not an infinite scroll region).
 */
export function scrollPastEndPadding(viewportHeight: number, lineHeight: number): number {
  const vh = Number.isFinite(viewportHeight) ? viewportHeight : 0;
  const lh = Number.isFinite(lineHeight) && lineHeight > 0 ? lineHeight : FALLBACK_LINE_HEIGHT;
  return Math.max(0, vh - lh);
}

/**
 * CodeMirror 6 extension adding VSCode/Atom "scroll beyond last line" breathing
 * room. Wire it into the editor's extension list. Visual only — no document
 * mutation.
 */
export function scrollPastEnd() {
  return ViewPlugin.fromClass(
    class implements PluginValue {
      private padding = -1;

      constructor(private readonly view: EditorView) {
        // Measure after the initial layout settles.
        this.schedule();
      }

      update(update: ViewUpdate) {
        // Geometry changes (resize/height) and doc changes can move the viewport
        // height or line height; re-measure on those.
        if (update.geometryChanged || update.viewportChanged || update.docChanged) {
          this.schedule();
        }
      }

      // Read geometry in the measure READ phase, then apply padding in the WRITE
      // phase — CodeMirror's read/write split avoids layout thrash.
      private schedule() {
        this.view.requestMeasure({
          read: () => {
            const viewportHeight = this.view.scrollDOM.clientHeight;
            const lineHeight = this.view.defaultLineHeight || FALLBACK_LINE_HEIGHT;
            return scrollPastEndPadding(viewportHeight, lineHeight);
          },
          write: (next) => {
            if (next === this.padding) return;
            this.padding = next;
            this.view.contentDOM.style.paddingBottom = `${next}px`;
          },
        });
      }

      destroy() {
        this.view.contentDOM.style.paddingBottom = "";
      }
    },
  );
}
