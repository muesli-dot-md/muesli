// Live-preview decoration layer (internal/design/editor-redesign.md §Core).
//
// The CRDT stays raw markdown (ADR 0001/0004); this module only DECORATES the
// CodeMirror view, Obsidian-style: marker tokens are hidden until the
// selection touches their node, inline styles render in place, and
// table/mermaid/math/image/hr blocks become widgets while the cursor is
// outside them. Module map:
//   transform.ts — pure range math (headless-tested, scripts/live-preview-test.mjs)
//   inline.ts    — viewport-scoped ViewPlugin (marks, hides, checkboxes)
//   blocks.ts    — StateField (block widgets; CM forbids those from plugins)
//   widgets.ts   — DOM widget classes, render results cached by source text
//   languages.ts — fenced-code nested parsers for syntax highlighting
//
// PRECEDENCE (with the other decoration sources in Editor.svelte):
//   1. yCollab's remote selections/carets are drawn as layers + widget marks
//      from the y-codemirror.next plugin — independent of this module.
//   2. annotations.ts collab decorations (comment anchors, suggestion
//      strike-throughs/insertions) are registered BEFORE livePreview() in the
//      extension list, so where ranges overlap, their marks take priority.
//   3. livePreview replace decorations still hide marker tokens inside a
//      commented range (the visible text keeps the comment highlight), and a
//      comment inside a collapsed block widget (table/mermaid/math) stays
//      hidden until the block reveals — CollabStore.focusRange() moves the
//      selection into the range, which reveals the block, so sidebar
//      navigation always surfaces the annotated text.

import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { defaultHighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { checkboxToggle } from "./transform";
import { inlinePreview } from "./inline";
import { blockPreview } from "./blocks";

export { fenceLanguage } from "./languages";

function openLink(url: string): void {
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) {
    // external scheme -> new tab
    window.open(url, "_blank", "noopener,noreferrer");
  } else if (url.startsWith("#")) {
    // hash link -> doc slug, matching render.ts's wikilink hrefs
    // wikilink navigation lands in a later phase
  }
  // anything else (relative paths) has no meaningful target in muesli — ignore
}

const interactions = EditorView.domEventHandlers({
  // Double-click a rendered mermaid diagram -> reveal its raw source. Moving the
  // selection into the ```mermaid block makes blocks.ts swap the widget back to
  // editable text (the same reveal that any cursor-enter triggers); editing then
  // re-renders on cursor-exit. posAtDOM on the widget root lands at the block's
  // start, which selectionTouches counts as inside (inclusive edges).
  dblclick(event, view) {
    const tgt = event.target as HTMLElement | null;
    const widget = tgt?.closest<HTMLElement>(".cm-live-mermaid");
    if (!widget) return false;
    event.preventDefault();
    const pos = view.posAtDOM(widget);
    view.dispatch({ selection: { anchor: pos } });
    view.focus();
    return true;
  },
  mousedown(event, view) {
    const tgt = event.target as HTMLElement | null;
    if (!tgt) return false;

    // task checkbox -> flip [ ]/[x] with a one-character transaction (CRDT-safe)
    if (tgt instanceof HTMLInputElement && tgt.classList.contains("cm-live-task")) {
      event.preventDefault();
      if (view.state.readOnly) return true; // suggest mode: editing is paused
      const change = checkboxToggle(view.state, view.posAtDOM(tgt));
      if (change) view.dispatch({ changes: change, userEvent: "input" });
      return true;
    }

    // cmd/ctrl+click opens links (plain click just moves the cursor, revealing markers)
    if ((event.metaKey || event.ctrlKey) && event.button === 0) {
      const link = tgt.closest<HTMLElement>("[data-live-href]");
      if (link?.dataset.liveHref) {
        event.preventDefault();
        openLink(link.dataset.liveHref);
        return true;
      }
      const wiki = tgt.closest<HTMLElement>("[data-live-doc]");
      if (wiki?.dataset.liveDoc) {
        event.preventDefault();
        // wikilink navigation lands in a later phase
        return true;
      }
    }
    return false;
  },
});

/** The whole live-preview layer as one extension bundle (Editor.svelte adds
 * it after collabDecorations — see PRECEDENCE above). */
export function livePreview(): Extension[] {
  return [
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    inlinePreview,
    blockPreview,
    interactions,
  ];
}
