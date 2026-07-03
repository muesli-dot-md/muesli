// Browser-side mermaid rendering (ADR 0015). render.ts emits inert
// placeholders (`<div data-diagram="mermaid"><pre>…source…</pre></div>`);
// this module finds them after the preview HTML lands and swaps in SVGs.
// Kept separate from render.ts so the render pipeline stays DOM-free and
// headlessly testable. The mermaid package itself is loaded lazily (it is
// huge) and only when a document actually contains a diagram.

// Self-referencing subpath import (same convention as render.ts): resolves via
// this package's own `exports` map. render.ts stays DOM-free, so importing it
// here keeps this module the only DOM-touching side.
import { sanitize, SVG_PURIFY_CONFIG } from "@muesli/editor-core/render";

/** SECURITY: must stay `"strict"`. Any weaker level ("loose"/"antiscript")
 * lets diagram text carry HTML labels and click handlers into the SVG
 * (security review finding 32). Kept as an exported constant so the
 * regression test in mermaid.test.ts can assert it. */
export const MERMAID_SECURITY_LEVEL = "strict";

let mermaidPromise: Promise<typeof import("mermaid").default> | null = null;

function isDarkTheme(): boolean {
  // daisyUI sets data-theme when configured; default config follows the
  // OS preference, so fall back to prefers-color-scheme.
  const explicit = document.documentElement.getAttribute("data-theme");
  if (explicit) return explicit.includes("dark");
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function getMermaid(): Promise<typeof import("mermaid").default> {
  if (!mermaidPromise) {
    mermaidPromise = import("mermaid").then((mod) => {
      // Initialize exactly once. securityLevel "strict" is mermaid's default
      // (labels are sanitized, no script/click handlers) — stated explicitly
      // via the guarded constant above.
      mod.default.initialize({
        startOnLoad: false,
        securityLevel: MERMAID_SECURITY_LEVEL,
        theme: isDarkTheme() ? "dark" : "default",
      });
      return mod.default;
    });
  }
  return mermaidPromise;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function errorBox(message: string, source: string): string {
  return (
    `<div class="alert alert-error mermaid-error" role="alert">` +
    `<span><strong>Mermaid:</strong> ${escapeHtml(message)}</span></div>` +
    `<pre class="mermaid-source">${escapeHtml(source)}</pre>`
  );
}

let seq = 0;

/**
 * Render every un-rendered mermaid placeholder under `root` to SVG.
 * `isCurrent` lets the caller abandon results from a stale render pass
 * (the preview re-renders on every CRDT change). Diagram errors become a
 * small alert box with the source preserved underneath; this function
 * never throws.
 */
export async function renderMermaidDiagrams(
  root: HTMLElement,
  isCurrent: () => boolean = () => true,
): Promise<void> {
  const nodes = Array.from(
    root.querySelectorAll<HTMLElement>('[data-diagram="mermaid"]:not([data-rendered])'),
  );
  if (nodes.length === 0) return;

  let mermaid: typeof import("mermaid").default;
  try {
    mermaid = await getMermaid();
  } catch {
    return; // module failed to load — placeholders keep showing the source
  }

  // NOTE: no isConnected gate. Live-preview widgets call this from toDOM(),
  // before CodeMirror attaches the element; mermaid renders fine into a
  // detached node (it measures in its own scratch element on body), and the
  // caller caches the SVG for the next synchronous widget rebuild.
  for (const node of nodes) {
    if (!isCurrent()) return;
    const source = node.querySelector("pre")?.textContent ?? "";
    const id = `muesli-mermaid-${++seq}`;
    try {
      const { svg } = await mermaid.render(id, source);
      if (!isCurrent()) return;
      // mermaid output is generated under securityLevel "strict" (labels are
      // sanitized by mermaid itself); the DOMPurify pass below is
      // belt-and-suspenders so a mermaid config/sanitizer regression never
      // reaches innerHTML unfiltered (finding 32). SVG_PURIFY_CONFIG keeps
      // mermaid's <foreignObject> html labels while sanitizing their content.
      node.innerHTML = sanitize(svg, SVG_PURIFY_CONFIG);
      node.dataset.rendered = "svg";
    } catch (err) {
      // mermaid.render can leave a scratch element behind on parse errors.
      document.getElementById(id)?.remove();
      document.getElementById(`d${id}`)?.remove();
      if (!isCurrent()) return;
      const message = err instanceof Error ? err.message.split("\n")[0] : String(err);
      node.innerHTML = errorBox(message, source);
      node.dataset.rendered = "error";
    }
  }
}
