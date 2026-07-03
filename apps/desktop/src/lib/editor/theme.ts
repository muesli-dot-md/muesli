import { EditorView } from "@codemirror/view";

/**
 * Arc-themed editor: transparent background inherits from the base-100 card.
 * Uses CSS vars so the theme reacts to arc-light / arc-dark token swaps.
 */
export const muesliTheme = EditorView.theme(
  {
    // ── Root / scroller ───────────────────────────────────────────────────────
    "&": {
      backgroundColor: "transparent",
      color: "var(--color-base-content)",
      fontSize: "16px",
      lineHeight: "1.6",
      height: "100%",
    },

    ".cm-scroller": {
      overflow: "auto",
    },

    // ── Readable-width centred column ─────────────────────────────────────────
    ".cm-content": {
      maxWidth: "700px",
      margin: "0 auto",
      padding: "24px 32px",
      caretColor: "var(--color-primary)",
    },

    // ── Line background / selection ───────────────────────────────────────────
    ".cm-line": {
      padding: "0",
    },
    ".cm-placeholder": {
      color: "var(--text-muted)",
    },
    "&.cm-focused .cm-cursor": {
      borderLeftColor: "var(--color-primary)",
    },
    "&.cm-focused .cm-selectionBackground, ::selection": {
      backgroundColor: "color-mix(in oklch, var(--color-primary) 20%, transparent)",
    },
    ".cm-selectionBackground": {
      backgroundColor: "color-mix(in oklch, var(--color-primary) 14%, transparent)",
    },

    // ── No visible gutters ────────────────────────────────────────────────────
    ".cm-gutters": {
      display: "none",
    },

    // ── Focused outline ───────────────────────────────────────────────────────
    "&.cm-focused": {
      outline: "none",
    },
  },
  { dark: false },
);
