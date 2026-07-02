// WidgetType classes for the live-preview layer. DOM-side counterpart of
// transform.ts: these render the blocks (tables, mermaid, math, images, hr)
// and the task checkboxes. Expensive renders (KaTeX HTML, mermaid SVG) are
// cached by source text so re-creating a widget after every selection change
// costs a Map lookup, not a re-render.

import { EditorView, WidgetType } from "@codemirror/view";
import katex from "katex";
import "katex/dist/katex.min.css";
import { renderMermaidDiagrams } from "@muesli/editor-core/mermaid";
import { attachMermaidInteraction } from "@muesli/editor-core/mermaidInteraction";
import { KATEX_TRUST, renderMarkdown, sanitize } from "@muesli/editor-core/render";
import { buildTableWidget } from "@muesli/editor-core/tableInteraction";
import { t } from "../i18n/index.svelte";
import type { ParsedTable } from "./transform";

// --- render caches (keyed by source text) -----------------------------------

const CACHE_MAX = 200;

function cachePut(cache: Map<string, string>, key: string, value: string): void {
  if (cache.size >= CACHE_MAX) {
    // drop the oldest half — cheap, and source-keyed entries rebuild on demand
    let i = 0;
    for (const k of cache.keys()) {
      cache.delete(k);
      if (++i >= CACHE_MAX / 2) break;
    }
  }
  cache.set(key, value);
}

const katexCache = new Map<string, string>();
const mermaidCache = new Map<string, string>();

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Block widgets share prose-muesli typography so the live document matches
 * the old Preview pane's look. */
function blockContainer(cls: string): HTMLDivElement {
  const div = document.createElement("div");
  div.className = `cm-live-widget prose-muesli ${cls}`;
  return div;
}

// --- task checkbox -------------------------------------------------------------

export class CheckboxWidget extends WidgetType {
  constructor(readonly checked: boolean) {
    super();
  }
  override eq(other: CheckboxWidget): boolean {
    return other.checked === this.checked;
  }
  toDOM(): HTMLElement {
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = this.checked;
    input.className = "cm-live-task checkbox checkbox-xs";
    input.setAttribute("aria-label", t("editor.toggleTask"));
    return input;
  }
  // Let the editor see events: index.ts's mousedown handler dispatches the
  // CRDT-safe [ ]/[x] toggle transaction.
  override ignoreEvent(): boolean {
    return false;
  }
}

// --- horizontal rule -------------------------------------------------------------

export class HrWidget extends WidgetType {
  override eq(): boolean {
    return true;
  }
  toDOM(): HTMLElement {
    const div = blockContainer("cm-live-hr");
    div.appendChild(document.createElement("hr"));
    return div;
  }
  override get estimatedHeight(): number {
    return 33;
  }
}

// --- math (KaTeX) -----------------------------------------------------------------
// Display ($$…$$) and inline ($…$) share one source-keyed cache; the key is
// prefixed by mode so the same tex can cache both block and inline HTML.

function renderKatexCached(source: string, displayMode: boolean): string {
  const key = `${displayMode ? "d" : "i"}:${source}`;
  let html = katexCache.get(key);
  if (html === undefined) {
    try {
      // SECURITY: the result goes straight into innerHTML, so it is run
      // through the same DOMPurify sanitize() as render.ts (finding 32) —
      // defense-in-depth on top of KaTeX's trust:false. Sanitizing here,
      // before cachePut, keeps the per-widget cost a Map lookup.
      html = sanitize(
        katex.renderToString(source, {
          throwOnError: false,
          displayMode,
          output: "htmlAndMathml",
          trust: KATEX_TRUST, // SECURITY: keep false — see KATEX_TRUST in render.ts
        }),
      );
    } catch {
      html = `<code class="katex-error">${escapeHtml(source)}</code>`;
    }
    cachePut(katexCache, key, html);
  }
  return html;
}

export class MathWidget extends WidgetType {
  constructor(readonly source: string) {
    super();
  }
  override eq(other: MathWidget): boolean {
    return other.source === this.source;
  }
  toDOM(): HTMLElement {
    const div = blockContainer("cm-live-math");
    div.innerHTML = renderKatexCached(this.source, true);
    return div;
  }
}

/** Inline `$…$` math: a KaTeX inline render replacing the `$…$` source span
 * while the selection is outside it (inline.ts reveals the raw text otherwise). */
export class InlineMathWidget extends WidgetType {
  constructor(readonly source: string) {
    super();
  }
  override eq(other: InlineMathWidget): boolean {
    return other.source === this.source;
  }
  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-live-inline-math";
    span.innerHTML = renderKatexCached(this.source, false);
    return span;
  }
}

// --- mermaid diagrams ---------------------------------------------------------------

export class MermaidWidget extends WidgetType {
  constructor(readonly source: string) {
    super();
  }
  override eq(other: MermaidWidget): boolean {
    return other.source === this.source;
  }
  toDOM(): HTMLElement {
    const div = blockContainer("cm-live-mermaid");
    const cached = mermaidCache.get(this.source);
    const holder = document.createElement("div");
    holder.dataset.diagram = "mermaid";
    holder.className = "mermaid-block";
    const labels = {
      zoomIn: t("editor.mermaid.zoomIn"),
      reset: t("editor.mermaid.reset"),
      zoomOut: t("editor.mermaid.zoomOut"),
    };
    if (cached !== undefined) {
      // `cached` is holder.innerHTML captured after renderMermaidDiagrams(),
      // which DOMPurify-sanitizes the SVG before injection — so the cache
      // replay is sanitized-at-source.
      holder.innerHTML = cached;
      holder.dataset.rendered = "svg";
      div.appendChild(holder);
      // Only a successfully rendered SVG is pannable; error boxes stay static.
      attachMermaidInteraction(div, holder, labels);
      return div;
    }
    const pre = document.createElement("pre");
    pre.className = "mermaid-source";
    pre.textContent = this.source;
    holder.appendChild(pre);
    div.appendChild(holder); // attach BEFORE rendering — the renderer querySelector()s under div
    const src = this.source;
    // Async SVG render (same pipeline as the old Preview pane); cache the
    // result so the next widget rebuild is synchronous.
    void renderMermaidDiagrams(div).then(() => {
      if (holder.dataset.rendered === "svg") {
        cachePut(mermaidCache, src, holder.innerHTML);
        attachMermaidInteraction(div, holder, labels);
      }
    });
    return div;
  }
  // CM should not treat clicks inside the diagram as cursor moves — pan/zoom is
  // handled by the widget, and dblclick-to-edit is dispatched from index.ts.
  override ignoreEvent(event: Event): boolean {
    return event.type !== "dblclick";
  }
  override get estimatedHeight(): number {
    return 160;
  }
}

// --- images (widget below the line) -----------------------------------------------------

export class ImageWidget extends WidgetType {
  constructor(
    readonly url: string,
    readonly alt: string,
  ) {
    super();
  }
  override eq(other: ImageWidget): boolean {
    return other.url === this.url && other.alt === this.alt;
  }
  toDOM(): HTMLElement {
    const div = blockContainer("cm-live-image");
    const img = document.createElement("img");
    img.src = this.url;
    img.alt = this.alt;
    img.loading = "lazy";
    img.onerror = () => div.classList.add("cm-live-image-broken");
    div.appendChild(img);
    return div;
  }
  override get estimatedHeight(): number {
    return 120;
  }
}

// --- tables --------------------------------------------------------------------------------

export class TableWidget extends WidgetType {
  // Transient column widths, per widget instance — never written to markdown,
  // reset whenever a source edit produces a fresh widget (design B §resize).
  private readonly widths = new Map<number, number>();
  constructor(
    readonly source: string,
    readonly parsed: ParsedTable,
  ) {
    super();
  }
  override eq(other: TableWidget): boolean {
    return other.source === this.source;
  }
  toDOM(): HTMLElement {
    const div = blockContainer("cm-live-table");
    const source = this.source;
    buildTableWidget(
      div,
      this.parsed,
      {
        renderCell: (raw) => renderMarkdown(raw),
        // Replace the table's source range with regenerated GFM. The widget's
        // root maps to the block start via posAtDOM; the original source length
        // bounds the range exactly (the widget is cached by source text).
        onCommit: (markdown) => {
          const view = EditorView.findFromDOM(div);
          if (!view || view.state.readOnly) return; // suggest mode pauses editing
          const from = view.posAtDOM(div);
          const to = from + source.length;
          view.dispatch({ changes: { from, to, insert: markdown }, userEvent: "input" });
        },
        labels: {
          insertRowAbove: t("editor.table.insertRowAbove"),
          insertRowBelow: t("editor.table.insertRowBelow"),
          insertColumnLeft: t("editor.table.insertColumnLeft"),
          insertColumnRight: t("editor.table.insertColumnRight"),
          deleteRow: t("editor.table.deleteRow"),
          deleteColumn: t("editor.table.deleteColumn"),
          resizeColumn: t("editor.table.resizeColumn"),
          formulaError: t("editor.table.formulaError"),
        },
      },
      this.widths,
    );
    return div;
  }
  // The widget owns its cells' edit events — CM must not treat clicks inside as
  // raw-source reveals (contenteditable + controls handle interaction).
  override ignoreEvent(): boolean {
    return true;
  }
  override get estimatedHeight(): number {
    return 40 + this.parsed.rows.length * 33;
  }
}
