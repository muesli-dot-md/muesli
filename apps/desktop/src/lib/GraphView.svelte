<script lang="ts">
  // Obsidian-style "universe" graph view for the desktop (ADR 0015), ported from
  // the webapp's apps/web/src/GraphView.svelte. Same hand-rolled force layout
  // (pairwise repulsion + edge springs + center gravity, alpha-decayed — no d3),
  // but fed by LOCAL vault data: a Rust command scans the open workspace's `.md`
  // files for [[wikilinks]] and returns {nodes, edges, unresolved}. Every note is
  // a node, resolved wikilinks are edges, unresolved targets render as dashed
  // ghost nodes. Clicking a real node opens that note in the editor.
  import { onMount } from "svelte";
  import { buildLinkGraph } from "$lib/tauri";
  import { slugify } from "@muesli/editor-core/render";

  interface Props {
    /** Workspace root to scan; null renders the empty state. */
    root: string | null;
    /** Absolute path of the active note, highlighted as the current node. */
    activePath?: string | null;
    /** Open a note by absolute path (switches back to the editor). */
    onOpen: (path: string) => void;
  }

  let { root, activePath = null, onOpen }: Props = $props();

  type SimNode = {
    id: string; // absolute path, or "ghost:<key>" for unresolved targets
    label: string;
    ghost: boolean;
    current: boolean;
    degree: number;
    x: number;
    y: number;
    vx: number;
    vy: number;
  };
  type SimEdge = { a: number; b: number; ghost: boolean };

  const W = 900;
  const H = 620;

  let loading = $state(true);
  let error = $state("");
  let nodes: SimNode[] = $state([]);
  let edges: SimEdge[] = $state([]);
  let hovered: string | null = $state(null);
  let dragging: { index: number; moved: number } | null = null;

  const alwaysLabel = $derived(nodes.length < 30);
  const radius = (n: SimNode) => 5 + 2.5 * Math.sqrt(n.degree);

  // --- simulation -------------------------------------------------------------

  let alpha = 1;
  let raf = 0;
  let svgEl: SVGSVGElement | undefined = $state();

  // --- zoom / pan --------------------------------------------------------------
  // A scale+translate transform applied to the inner <g> (in viewBox units). The
  // dot-grid background lives inside the same <g>, so it pans/zooms as one surface.
  const MIN_SCALE = 0.2;
  const MAX_SCALE = 4;
  let scale = $state(1);
  let tx = $state(0);
  let ty = $state(0);
  // Panning the canvas (background drag), distinct from dragging a node.
  let panning: { startX: number; startY: number; tx0: number; ty0: number } | null = $state(null);

  const prefersReducedMotion = () =>
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

  // Convert a pointer event to viewBox units (pre-transform, i.e. the SVG's own
  // coordinate space spanning 0..W / 0..H).
  function toSvg(ev: { clientX: number; clientY: number }): { x: number; y: number } {
    const rect = svgEl!.getBoundingClientRect();
    return {
      x: ((ev.clientX - rect.left) / rect.width) * W,
      y: ((ev.clientY - rect.top) / rect.height) * H,
    };
  }

  const clampScale = (s: number) => Math.min(Math.max(s, MIN_SCALE), MAX_SCALE);

  // Zoom toward an anchor point (in viewBox units) so that point stays put.
  function zoomTo(nextScale: number, anchorX: number, anchorY: number) {
    const s = clampScale(nextScale);
    if (s === scale) return;
    // World coords under the anchor before the change: (anchor - t) / scale.
    // Keep them fixed: anchor = t' + world * s  =>  t' = anchor - world * s.
    const worldX = (anchorX - tx) / scale;
    const worldY = (anchorY - ty) / scale;
    tx = anchorX - worldX * s;
    ty = anchorY - worldY * s;
    scale = s;
  }

  let zoomAnim = 0;
  // Animate the scale toward `target`, zooming on the viewport center.
  function animateZoom(target: number) {
    const s = clampScale(target);
    const cx = W / 2;
    const cy = H / 2;
    if (prefersReducedMotion()) {
      zoomTo(s, cx, cy);
      return;
    }
    if (zoomAnim) cancelAnimationFrame(zoomAnim);
    const from = scale;
    const start = performance.now();
    const DUR = 160;
    const step = (now: number) => {
      const t = Math.min((now - start) / DUR, 1);
      // easeOutCubic
      const e = 1 - Math.pow(1 - t, 3);
      zoomTo(from + (s - from) * e, cx, cy);
      if (t < 1) zoomAnim = requestAnimationFrame(step);
      else zoomAnim = 0;
    };
    zoomAnim = requestAnimationFrame(step);
  }

  function onWheel(ev: WheelEvent) {
    if (!svgEl) return;
    ev.preventDefault();
    const { x, y } = toSvg(ev);
    // Exponential zoom keeps the feel consistent across scroll magnitudes.
    const factor = Math.exp(-ev.deltaY * 0.0015);
    zoomTo(scale * factor, x, y);
  }

  function zoomIn() {
    animateZoom(scale * 1.2);
  }
  function zoomOut() {
    animateZoom(scale / 1.2);
  }
  function resetView() {
    if (prefersReducedMotion()) {
      scale = 1;
      tx = 0;
      ty = 0;
      return;
    }
    if (zoomAnim) cancelAnimationFrame(zoomAnim);
    const from = { s: scale, tx, ty };
    const start = performance.now();
    const DUR = 200;
    const step = (now: number) => {
      const t = Math.min((now - start) / DUR, 1);
      const e = 1 - Math.pow(1 - t, 3);
      scale = from.s + (1 - from.s) * e;
      tx = from.tx + (0 - from.tx) * e;
      ty = from.ty + (0 - from.ty) * e;
      if (t < 1) zoomAnim = requestAnimationFrame(step);
      else zoomAnim = 0;
    };
    zoomAnim = requestAnimationFrame(step);
  }

  function tick() {
    const n = nodes.length;
    // Pairwise repulsion (O(n²) — fine for workspace-sized graphs).
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const a = nodes[i];
        const b = nodes[j];
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 1) {
          // Coincident nodes: nudge apart deterministically.
          dx = (i - j) * 0.1;
          dy = 0.1;
          d2 = dx * dx + dy * dy;
        }
        const f = Math.min((1800 / d2) * alpha, 12);
        const d = Math.sqrt(d2);
        const fx = (dx / d) * f;
        const fy = (dy / d) * f;
        a.vx -= fx;
        a.vy -= fy;
        b.vx += fx;
        b.vy += fy;
      }
    }
    // Edge springs toward a rest length.
    const REST = 110;
    for (const e of edges) {
      const a = nodes[e.a];
      const b = nodes[e.b];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
      const f = (d - REST) * 0.02 * alpha;
      const fx = (dx / d) * f;
      const fy = (dy / d) * f;
      a.vx += fx;
      a.vy += fy;
      b.vx -= fx;
      b.vy -= fy;
    }
    // Center gravity + integration with damping.
    for (const node of nodes) {
      node.vx += (W / 2 - node.x) * 0.012 * alpha;
      node.vy += (H / 2 - node.y) * 0.012 * alpha;
      node.vx *= 0.85;
      node.vy *= 0.85;
      node.x += node.vx;
      node.y += node.vy;
      node.x = Math.min(Math.max(node.x, 16), W - 16);
      node.y = Math.min(Math.max(node.y, 16), H - 16);
    }
    alpha *= 0.985;
  }

  function loop() {
    if (alpha > 0.02 || dragging) {
      tick();
      raf = requestAnimationFrame(loop);
    } else {
      raf = 0;
    }
  }

  function reheat(a = 0.4) {
    alpha = Math.max(alpha, a);
    if (!raf) raf = requestAnimationFrame(loop);
  }

  // --- data → sim --------------------------------------------------------------

  async function load() {
    loading = true;
    error = "";
    if (!root) {
      nodes = [];
      edges = [];
      loading = false;
      return;
    }
    try {
      const graph = await buildLinkGraph(root);

      const sim: SimNode[] = [];
      const byId = new Map<string, number>();
      for (const node of graph.nodes) {
        byId.set(node.id, sim.length);
        sim.push({
          id: node.id,
          label: node.title,
          ghost: false,
          current: node.id === activePath,
          degree: node.linksOut + node.linksIn,
          // Deterministic starting ring (golden-angle spread) so layouts are stable-ish.
          x: W / 2 + 180 * Math.cos(sim.length * 2.39996),
          y: H / 2 + 140 * Math.sin(sim.length * 2.39996),
          vx: 0,
          vy: 0,
        });
      }
      const simEdges: SimEdge[] = [];
      for (const e of graph.edges) {
        const a = byId.get(e.src);
        const b = byId.get(e.dst);
        if (a === undefined || b === undefined || a === b) continue;
        simEdges.push({ a, b, ghost: false });
      }
      // One ghost node per distinct unresolved target (keyed by its slugified form
      // so [[Ghost]] and [[ghost]] collapse), dashed-linked from every note naming it.
      const ghosts = new Map<string, number>();
      for (const u of graph.unresolved) {
        const src = byId.get(u.src);
        if (src === undefined) continue;
        const key = slugify(u.rawTarget) || u.rawTarget;
        let gi = ghosts.get(key);
        if (gi === undefined) {
          gi = sim.length;
          ghosts.set(key, gi);
          sim.push({
            id: `ghost:${key}`,
            label: u.rawTarget,
            ghost: true,
            current: false,
            degree: 0,
            x: W / 2 + 240 * Math.cos(sim.length * 2.39996),
            y: H / 2 + 180 * Math.sin(sim.length * 2.39996),
            vx: 0,
            vy: 0,
          });
        }
        sim[gi].degree += 1;
        simEdges.push({ a: src, b: gi, ghost: true });
      }
      nodes = sim;
      edges = simEdges;
      alpha = 1;
      reheat(1);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  // --- interaction ---------------------------------------------------------------

  // Pointer → world coords (the space nodes live in, inside the transformed <g>).
  function toWorld(ev: { clientX: number; clientY: number }): { x: number; y: number } {
    const { x, y } = toSvg(ev);
    return { x: (x - tx) / scale, y: (y - ty) / scale };
  }

  function onNodeDown(index: number, ev: PointerEvent) {
    ev.stopPropagation();
    dragging = { index, moved: 0 };
    (ev.currentTarget as Element).setPointerCapture(ev.pointerId);
    reheat(0.3);
  }

  function onPointerMove(ev: PointerEvent) {
    if (dragging) {
      if (!svgEl) return;
      const { x, y } = toWorld(ev);
      const node = nodes[dragging.index];
      dragging.moved += Math.abs(x - node.x) + Math.abs(y - node.y);
      node.x = x;
      node.y = y;
      node.vx = 0;
      node.vy = 0;
      reheat(0.3);
    } else if (panning) {
      const rect = svgEl!.getBoundingClientRect();
      const dx = ((ev.clientX - panning.startX) / rect.width) * W;
      const dy = ((ev.clientY - panning.startY) / rect.height) * H;
      tx = panning.tx0 + dx;
      ty = panning.ty0 + dy;
    }
  }

  function onCanvasDown(ev: PointerEvent) {
    if (dragging) return;
    panning = { startX: ev.clientX, startY: ev.clientY, tx0: tx, ty0: ty };
    (ev.currentTarget as Element).setPointerCapture(ev.pointerId);
  }

  function onPointerUp() {
    dragging = null;
    panning = null;
  }

  function onNodeUp(index: number) {
    const wasDrag = dragging !== null && dragging.moved > 6;
    dragging = null;
    if (wasDrag) return;
    const node = nodes[index];
    // Ghosts have no backing file; the current note is already open.
    if (node.ghost || node.id === activePath) return;
    onOpen(node.id);
  }

  onMount(() => {
    void load();
    return () => {
      if (raf) cancelAnimationFrame(raf);
      if (zoomAnim) cancelAnimationFrame(zoomAnim);
    };
  });

  const docTotal = $derived(nodes.filter((n) => !n.ghost).length);
  const linkTotal = $derived(edges.filter((e) => !e.ghost).length);
  const ghostTotal = $derived(nodes.filter((n) => n.ghost).length);
</script>

<div class="flex h-full flex-col">
  <div class="flex items-center justify-between border-b border-base-300 px-4 py-2">
    <div class="text-sm">
      <span class="font-semibold">Graph</span>
      {#if !loading && !error}
        <span class="opacity-60">
          · {docTotal}
          {docTotal === 1 ? "note" : "notes"} ·
          {linkTotal}
          {linkTotal === 1 ? "link" : "links"}
          {#if ghostTotal > 0}
            · {ghostTotal} unresolved
          {/if}
        </span>
      {/if}
    </div>
  </div>

  <div class="min-h-0 flex-1 overflow-hidden bg-base-100">
    {#if loading}
      <div class="flex h-full items-center justify-center">
        <span class="loading loading-spinner loading-lg opacity-40"></span>
      </div>
    {:else if error}
      <div class="flex h-full items-center justify-center px-8 text-center text-sm opacity-60">
        {error}
      </div>
    {:else if nodes.length === 0}
      <div class="flex h-full items-center justify-center text-sm opacity-50">
        No notes to graph yet — add some <code class="mx-1">[[wikilinks]]</code> between notes.
      </div>
    {:else}
      <div class="relative h-full w-full">
        <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
        <svg
          bind:this={svgEl}
          viewBox="0 0 {W} {H}"
          class="h-full w-full touch-none select-none"
          class:cursor-grabbing={panning}
          class:cursor-grab={!panning}
          role="img"
          aria-label="Link graph"
          onwheel={onWheel}
          onpointerdown={onCanvasDown}
          onpointermove={onPointerMove}
          onpointerup={onPointerUp}
          onpointerleave={onPointerUp}
        >
          <defs>
            <!-- Faint dot grid, in world units, so it lives inside the transformed
                 <g> and pans/zooms with the nodes (n8n-style surface). Color derives
                 from the semantic base-content token at low alpha → theme-aware. -->
            <pattern
              id="graph-dot-grid"
              x="0"
              y="0"
              width="28"
              height="28"
              patternUnits="userSpaceOnUse"
            >
              <circle
                cx="1.4"
                cy="1.4"
                r="1.4"
                fill="var(--color-base-content)"
                fill-opacity="0.08"
              />
            </pattern>
          </defs>

          <g transform="translate({tx} {ty}) scale({scale})">
            <!-- Background surface, large enough to cover well past the layout at any
                 sane pan. pointer-events stay on the parent <svg> for canvas panning. -->
            <rect
              x={-2 * W}
              y={-2 * H}
              width={5 * W}
              height={5 * H}
              fill="url(#graph-dot-grid)"
              class="pointer-events-none"
            />

            {#each edges as e, i (i)}
              <line
                x1={nodes[e.a].x}
                y1={nodes[e.a].y}
                x2={nodes[e.b].x}
                y2={nodes[e.b].y}
                stroke="var(--color-base-content)"
                stroke-opacity={e.ghost ? 0.18 : 0.3}
                stroke-width="1.2"
                stroke-dasharray={e.ghost ? "4 4" : undefined}
              />
            {/each}
            {#each nodes as node, i (node.id)}
              <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
              <g
                class={node.ghost ? "opacity-70" : "cursor-pointer"}
                onpointerdown={(ev) => onNodeDown(i, ev)}
                onpointerup={() => onNodeUp(i)}
                onpointerenter={() => (hovered = node.id)}
                onpointerleave={() => (hovered = null)}
              >
                <circle
                  cx={node.x}
                  cy={node.y}
                  r={radius(node)}
                  fill={node.ghost
                    ? "var(--color-base-200)"
                    : node.current
                      ? "var(--color-primary)"
                      : "var(--color-base-content)"}
                  fill-opacity={node.ghost ? 0.4 : node.current ? 1 : 0.55}
                  stroke={node.current ? "var(--color-primary)" : "var(--color-base-content)"}
                  stroke-opacity={node.current ? 0.9 : 0.5}
                  stroke-width={node.current ? 2 : 1}
                  stroke-dasharray={node.ghost ? "3 3" : undefined}
                />
                {#if alwaysLabel || hovered === node.id}
                  <text
                    x={node.x}
                    y={node.y + radius(node) + 12}
                    text-anchor="middle"
                    class="pointer-events-none"
                    font-size="11"
                    fill="var(--color-base-content)"
                    fill-opacity={node.ghost ? 0.5 : 0.8}
                    font-style={node.ghost ? "italic" : undefined}
                  >
                    {node.label}
                  </text>
                {/if}
              </g>
            {/each}
          </g>
        </svg>

        <!-- Zoom controls, pinned bottom-left. daisyUI arc tokens; concentric radius. -->
        <div
          class="absolute bottom-3 left-3 flex flex-col overflow-hidden rounded-box border border-base-300 bg-base-100"
          style="box-shadow: var(--shadow-card);"
        >
          <button
            type="button"
            aria-label="Zoom in"
            title="Zoom in"
            class="flex h-10 w-10 items-center justify-center text-lg leading-none text-base-content/70 transition-transform hover:bg-base-200 hover:text-base-content active:scale-[0.96]"
            onclick={zoomIn}
          >
            +
          </button>
          <button
            type="button"
            aria-label="Reset zoom"
            title="Reset view"
            class="flex h-10 w-10 items-center justify-center border-y border-base-300 text-[11px] font-medium text-base-content/70 transition-transform hover:bg-base-200 hover:text-base-content active:scale-[0.96]"
            onclick={resetView}
          >
            1:1
          </button>
          <button
            type="button"
            aria-label="Zoom out"
            title="Zoom out"
            class="flex h-10 w-10 items-center justify-center text-lg leading-none text-base-content/70 transition-transform hover:bg-base-200 hover:text-base-content active:scale-[0.96]"
            onclick={zoomOut}
          >
            −
          </button>
        </div>
      </div>
    {/if}
  </div>

  <div class="flex items-center gap-4 border-t border-base-300 px-4 py-1.5 text-xs opacity-60">
    <span class="flex items-center gap-1">
      <span class="inline-block h-2.5 w-2.5 rounded-full bg-primary"></span>
      Current note
    </span>
    <span class="flex items-center gap-1">
      <span
        class="inline-block h-2.5 w-2.5 rounded-full border border-dashed border-base-content/60"
      ></span>
      Unresolved
    </span>
    <span class="ml-auto">Drag to move · click to open</span>
  </div>
</div>
