<script lang="ts">
  // Lucide's FolderOpen outline plus an interior fill. The stock icon is one
  // OPEN (never-closed) path, so CSS-filling it — the .folder-glyph treatment
  // the closed Folder gets — implicitly closes it from its endpoint and the
  // shape self-intersects into a diagonal seam. This renders the identical
  // outline stroke over a separate CLOSED front-flap subpath that takes the
  // fill cleanly: its implicit closing edge falls where the eye reads the
  // flap's left edge and stays inside the silhouette (the stock outline has
  // no such segment, so this edge is the one fill boundary not covered by
  // the stroke — invisible at tree-glyph sizes).
  // Path data copied from lucide "folder-open" (lucide-svelte 1.0.1 /
  // @lucide/svelte 1.17.0 — currently identical); re-copy the d attributes
  // whenever the app's lucide package updates this icon, or the two tree
  // glyphs drift apart. The fill color lives in app.css next to
  // .folder-glyph so both glyphs stay one color definition. Kept identical
  // with the copy in the other app (apps/web/src <-> apps/desktop/src/lib).
  let { size = 24, class: className = "" }: { size?: number; class?: string } = $props();
</script>

<svg
  xmlns="http://www.w3.org/2000/svg"
  width={size}
  height={size}
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="2"
  stroke-linecap="round"
  stroke-linejoin="round"
  class={className}
  aria-hidden="true"
>
  <path
    class="folder-open-flap"
    stroke="none"
    d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4z"
  />
  <path
    d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"
  />
</svg>
