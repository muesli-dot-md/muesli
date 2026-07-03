// Download / export plumbing for the toolbar (editor redesign §Toolbar).
// The markdown text is the canonical artifact (ADR 0001); HTML and PDF are
// conveniences rendered through the same render.ts pipeline the snapshot
// modal uses. Standalone styles are embedded (no app.css dependency) so the
// exported file works offline; KaTeX's stylesheet is inlined (its glyph fonts
// load from the version-pinned jsDelivr CDN) so exported math is styled, and
// mermaid blocks export as their fenced source.

import { renderMarkdown } from "./render";
// Raw KaTeX stylesheet, inlined into the export so math renders styled.
// `?raw` keeps the file verbatim (relative `fonts/…` urls); we rewrite those to
// the version-pinned jsDelivr CDN so the glyph fonts resolve in a standalone
// file without bundling ~1MB of woff2 into every export.
import katexCssRaw from "katex/dist/katex.min.css?raw";
import katex from "katex";

const KATEX_CSS = katexCssRaw.replace(
  /url\(fonts\//g,
  `url(https://cdn.jsdelivr.net/npm/katex@${katex.version}/dist/fonts/`,
);

/** Minimal prose styles mirroring .prose-muesli for standalone documents. */
const EXPORT_CSS = `
  body { font-family: ui-sans-serif, system-ui, sans-serif; line-height: 1.6;
         max-width: 46rem; margin: 2rem auto; padding: 0 1.5rem; color: #1f2227; }
  h1 { font-size: 1.6rem; font-weight: 700; margin: 1rem 0 0.5rem; }
  h2 { font-size: 1.3rem; font-weight: 650; margin: 1rem 0 0.5rem; }
  h3 { font-size: 1.1rem; font-weight: 600; margin: 0.8rem 0 0.4rem; }
  p { margin: 0.5rem 0; }
  ul { list-style: disc; padding-left: 1.5rem; margin: 0.5rem 0; }
  ol { list-style: decimal; padding-left: 1.5rem; margin: 0.5rem 0; }
  code { background: #f2f1ee; border-radius: 4px; padding: 0.1rem 0.3rem; font-size: 0.85em; }
  pre { background: #24251f; color: #f7f6f3; border-radius: 8px; padding: 0.75rem 1rem;
        overflow-x: auto; margin: 0.6rem 0; }
  pre code { background: transparent; padding: 0; color: inherit; }
  blockquote { border-left: 3px solid #d8d6d0; padding-left: 0.8rem; color: #6b6a66; margin: 0.6rem 0; }
  a { color: #3556c7; }
  table { border-collapse: collapse; margin: 0.6rem 0; }
  th, td { border: 1px solid #d8d6d0; padding: 0.3rem 0.6rem; }
  hr { border: none; border-top: 1px solid #d8d6d0; margin: 1rem 0; }
  img { max-width: 100%; }
  @media print { body { margin: 0 auto; } }
`;

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Full standalone HTML page for the given markdown source. */
export function buildHtmlExport(title: string, markdownSrc: string): string {
  return [
    "<!doctype html>",
    `<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">`,
    `<title>${escapeHtml(title)}</title><style>${KATEX_CSS}</style><style>${EXPORT_CSS}</style></head>`,
    `<body>${renderMarkdown(markdownSrc)}</body></html>`,
  ].join("\n");
}

function downloadBlob(blob: Blob, filename: string): void {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** Download the live markdown as {slug}.md. */
export function downloadMarkdown(slug: string, text: string): void {
  downloadBlob(new Blob([text], { type: "text/markdown;charset=utf-8" }), `${slug}.md`);
}

/** Download a standalone HTML render as {slug}.html. */
export function downloadHtml(slug: string, title: string, text: string): void {
  downloadBlob(
    new Blob([buildHtmlExport(title, text)], { type: "text/html;charset=utf-8" }),
    `${slug}.html`,
  );
}

/** Open a print-friendly window with the rendered document and invoke the
 * browser's print dialog (the user picks "Save as PDF"). */
export function printDocument(title: string, text: string): void {
  // no "noopener": it would make window.open return null, and we must write
  // into the (same-origin, about:blank) document we just opened.
  const win = window.open("", "_blank");
  if (!win) return;
  win.document.write(buildHtmlExport(title, text));
  win.document.close();
  // Give the new document a beat to lay out before the dialog freezes it.
  win.addEventListener("load", () => setTimeout(() => win.print(), 150));
}
