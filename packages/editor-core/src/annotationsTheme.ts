// Base highlight styles for the collaboration decorations (annotations.ts).
// Ported from the webapp's app.css (apps/web/src/app.css "Collaboration
// decorations") but packaged here as a CM6 baseTheme so a consumer can ship the
// highlights with the extension instead of relying on its own app.css.
//
// Opt-in: the shared `collabDecorations` core does NOT include this theme. The
// desktop app adds `collabTheme` to its extensions explicitly; the web app
// keeps styling the same classes via app.css and does not use this theme.
//
// Colors use daisyUI semantic CSS vars via color-mix() rather than hardcoded
// oklch literals, so they stay legible in BOTH arc-light and arc-dark (the vars
// are redefined per [data-theme]).
import { EditorView } from "@codemirror/view";

export const collabTheme = EditorView.baseTheme({
  // Comment anchors: subtle marker-pen highlight; clickable (routes to the
  // sidebar thread card via commentClickHandler).
  ".cm-comment-anchor": {
    backgroundColor: "color-mix(in oklch, var(--color-warning) 30%, transparent)",
    borderBottom: "2px solid color-mix(in oklch, var(--color-warning) 70%, transparent)",
    cursor: "pointer",
  },
  // Pending suggestion: deleted range struck through with a red tint.
  ".cm-suggest-deletion": {
    backgroundColor: "color-mix(in oklch, var(--color-error) 14%, transparent)",
    textDecoration: "line-through",
    textDecorationColor: "color-mix(in oklch, var(--color-error) 70%, transparent)",
  },
  // Pending suggestion: proposed insertion as an inline green widget.
  ".cm-suggest-insertion": {
    backgroundColor: "color-mix(in oklch, var(--color-success) 16%, transparent)",
    color: "var(--color-success)",
    borderRadius: "3px",
    padding: "0 2px",
    margin: "0 1px",
  },
  // Flash when a sidebar card is clicked.
  ".cm-collab-flash": {
    backgroundColor: "color-mix(in oklch, var(--color-primary) 28%, transparent)",
    transition: "background 0.3s ease",
  },
});
