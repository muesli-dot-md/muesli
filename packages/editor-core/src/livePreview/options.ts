// Per-app configuration for the live-preview layer. This module (widgets.ts,
// index.ts) is shared verbatim between web and desktop; the only two things
// that differ per app are widget control labels (webapp localizes via its
// i18n t(), desktop hardcodes English — same split already established for
// MermaidControlLabels/TableLabels in mermaidInteraction.ts/tableInteraction.ts)
// and wikilink navigation (webapp jumps via its router, desktop is a no-op
// until wikilink navigation ships there). Both are threaded through as an
// options object passed to livePreview() rather than imported directly, so
// this package stays app-agnostic.

import { Facet } from "@codemirror/state";
import type { MermaidControlLabels } from "@muesli/editor-core/mermaidInteraction";
import type { TableLabels } from "@muesli/editor-core/tableInteraction";

export interface LivePreviewLabels {
  toggleTask: string;
  mermaid: MermaidControlLabels;
  table: TableLabels;
}

export interface LivePreviewOptions {
  /** Called at widget build time (every toDOM/render), never snapshotted:
   * webapp backs this with t(), so a mid-session setLocale() — or an i18n
   * catalog that finishes its async load after the editor mounts — reaches
   * every widget built afterwards, exactly like the pre-extraction per-toDOM
   * t() calls did. Building the object per call is cheap (a dozen string
   * lookups) and matches the old per-toDOM cost. */
  labels: () => LivePreviewLabels;
  /** Cmd/ctrl+click on a `[[wikilink]]`. Undefined leaves the click a no-op
   * (desktop, for now — wikilink navigation lands in a later phase there). */
  onNavigateWikilink?: (target: string) => void;
}

/** English literals — desktop's copy verbatim. Frozen (including the nested
 * label groups) so a stray mutation cannot leak into every editor that shares
 * this object via the facet. */
export const defaultLivePreviewLabels: LivePreviewLabels = Object.freeze({
  toggleTask: "Toggle task",
  mermaid: Object.freeze({ zoomIn: "Zoom in", reset: "Reset view", zoomOut: "Zoom out" }),
  table: Object.freeze({
    insertRowAbove: "Insert row above",
    insertRowBelow: "Insert row below",
    insertColumnLeft: "Insert column left",
    insertColumnRight: "Insert column right",
    deleteRow: "Delete row",
    deleteColumn: "Delete column",
    resizeColumn: "Resize column",
    formulaError: "Formula error",
  }),
});

/** English defaults with no wikilink nav — what desktop and the package tests
 * pass explicitly (livePreview() takes no default: labels are required from
 * each app so a new caller cannot silently ship unlabeled controls). */
export const defaultLivePreviewOptions: LivePreviewOptions = Object.freeze({
  labels: () => defaultLivePreviewLabels,
});

/** Widgets (widgets.ts) and the click handlers (index.ts) read this via
 * `view.state.facet(livePreviewOptions)` — WidgetType.toDOM and
 * domEventHandlers only get a `view`, not whatever was passed to
 * `livePreview()`. Facet inputs are ordered highest-precedence first, so
 * `values[0]` is the CM convention for single-value facets: the
 * highest-precedence provider wins. `livePreview()` installs exactly one
 * `.of()`, so in practice that is the one value; the default only applies
 * when the facet is read before any livePreview() extension is installed. */
export const livePreviewOptions = Facet.define<LivePreviewOptions, LivePreviewOptions>({
  combine: (values) => values[0] ?? defaultLivePreviewOptions,
});
