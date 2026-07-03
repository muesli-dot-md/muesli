<script lang="ts">
  // Obsidian-style "universe" graph view (ADR 0015): every visible document is a node,
  // wikilinks / relative md links are edges, unresolved targets render as dashed ghost
  // nodes. The force layout is a small hand-rolled simulation (pairwise repulsion +
  // edge springs + center gravity, alpha-decayed) — no d3.
  import X from "@lucide/svelte/icons/x";
  import { onMount } from "svelte";
  import { createGraphApi, GraphApiError } from "./graphApi";
  import { t } from "./i18n/index.svelte";
  // identity/route, not session: the home screen embeds this view and must not
  // pull in yjs / open a doc room as a side effect.
  import { httpBase } from "./identity";
  import { gotoDoc, route } from "./route.svelte";
  import { slugify } from "@muesli/editor-core/render";
  import { inWorkspace } from "./homeWorkspace";

  // embedded: rendered inside the home screen's content pane instead of as a modal.
  // selectedWorkspaceId/personalWorkspaceId: scope the graph to the sidebar's current
  // workspace (Home.svelte owns the selection), same inWorkspace() semantics as the
  // document browser — otherwise every workspace the caller can see gets drawn as one
  // "universe" graph. Both null (the non-embedded per-document modal, opened from
  // inside a doc with no workspace picker in scope) means "don't filter".
  let {
    onclose = () => {},
    embedded = false,
    selectedWorkspaceId = null,
    personalWorkspaceId = null,
  }: {
    onclose?: () => void;
    embedded?: boolean;
    selectedWorkspaceId?: string | null;
    personalWorkspaceId?: string | null;
  } = $props();

  // Captured at mount: the view remounts on navigation (DocApp is keyed per doc,
  // the home embeds a fresh instance), so a snapshot is always current.
  const docId = route.current.kind === "doc" ? route.current.docId : "";
  const shareToken = route.current.kind === "doc" ? route.current.shareToken : null;

  type SimNode = {
    id: string; // document_id, or "ghost:<key>" for unresolved targets
    slug: string; // navigation slug ("" for ghosts that don't slugify)
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
    try {
      const api = createGraphApi({ httpBase, shareToken });
      const graph = await api.getGraph();

      // Scope to the current workspace: edges/ghosts naturally follow since the
      // lookups below (byId.get(...)) skip anything not built into `sim`.
      const scopedNodes = graph.nodes.filter((n) =>
        inWorkspace(n.workspace_id, selectedWorkspaceId, personalWorkspaceId),
      );
      const sim: SimNode[] = [];
      const byId = new Map<string, number>();
      for (const node of scopedNodes) {
        byId.set(node.document_id, sim.length);
        sim.push({
          id: node.document_id,
          slug: node.slug,
          label: node.title || node.slug,
          ghost: false,
          current: node.slug === docId,
          degree: node.links_out + node.links_in,
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
      // One ghost node per distinct unresolved target (keyed by its slugified form so
      // [[Ghost]] and [[ghost]] collapse), dashed-linked from every document naming it.
      const ghosts = new Map<string, number>();
      for (const u of graph.unresolved) {
        const src = byId.get(u.src);
        if (src === undefined) continue;
        const key = slugify(u.raw_target) || u.raw_target;
        let gi = ghosts.get(key);
        if (gi === undefined) {
          gi = sim.length;
          ghosts.set(key, gi);
          sim.push({
            id: `ghost:${key}`,
            slug: "",
            label: u.raw_target,
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
      error =
        e instanceof GraphApiError && e.status === 503
          ? t("graph.volatile")
          : e instanceof GraphApiError && (e.status === 401 || e.status === 403)
            ? t("graph.signInToSee")
            : t("common.errorWithDetail", {
                detail: e instanceof Error ? e.message : String(e),
              });
    } finally {
      loading = false;
    }
  }

  // --- interaction ---------------------------------------------------------------

  function toViewBox(ev: PointerEvent): { x: number; y: number } {
    const rect = svgEl!.getBoundingClientRect();
    return {
      x: ((ev.clientX - rect.left) / rect.width) * W,
      y: ((ev.clientY - rect.top) / rect.height) * H,
    };
  }

  function onNodeDown(index: number, ev: PointerEvent) {
    dragging = { index, moved: 0 };
    (ev.currentTarget as Element).setPointerCapture(ev.pointerId);
    reheat(0.3);
  }

  function onPointerMove(ev: PointerEvent) {
    if (!dragging || !svgEl) return;
    const { x, y } = toViewBox(ev);
    const node = nodes[dragging.index];
    dragging.moved += Math.abs(x - node.x) + Math.abs(y - node.y);
    node.x = x;
    node.y = y;
    node.vx = 0;
    node.vy = 0;
    reheat(0.3);
  }

  function onNodeUp(index: number) {
    const wasDrag = dragging !== null && dragging.moved > 6;
    dragging = null;
    if (wasDrag) return;
    const node = nodes[index];
    if (node.ghost || !node.slug || node.slug === docId) return;
    gotoDoc(node.slug);
  }

  onMount(() => {
    void load();
    return () => {
      if (raf) cancelAnimationFrame(raf);
    };
  });
</script>

<div
  class={embedded ? "flex h-full flex-col" : "modal modal-open"}
  role={embedded ? "region" : "dialog"}
  aria-label={t("doc.linkGraph")}
>
  <div
    class={embedded
      ? "flex min-h-0 flex-1 flex-col"
      : "modal-box flex h-[88vh] max-h-[88vh] w-11/12 max-w-6xl flex-col p-0"}
  >
    <div class="flex items-center justify-between border-b border-base-300 px-4 py-2">
      <div class="text-sm">
        <span class="font-semibold">{t("graph.title")}</span>
        {#if !loading && !error}
          {@const docTotal = nodes.filter((n) => !n.ghost).length}
          {@const linkTotal = edges.filter((e) => !e.ghost).length}
          {@const ghostTotal = nodes.filter((n) => n.ghost).length}
          <span class="opacity-60">
            · {t(docTotal === 1 ? "common.documentCount.one" : "common.documentCount.other", {
              count: docTotal,
            })} ·
            {t(linkTotal === 1 ? "graph.linkCount.one" : "graph.linkCount.other", {
              count: linkTotal,
            })}
            {#if ghostTotal > 0}
              · {t(ghostTotal === 1 ? "graph.unresolvedCount.one" : "graph.unresolvedCount.other", {
                count: ghostTotal,
              })}
            {/if}
          </span>
        {/if}
      </div>
      {#if !embedded}
        <button class="btn btn-ghost btn-sm" title={t("graph.close")} onclick={onclose}>
          <X class="h-4 w-4" aria-hidden="true" />
        </button>
      {/if}
    </div>

    <!-- Embedded in Home's white card surface: paint the canvas on base-100 so
         the graph sits on the same surface as the rest of the main space (the
         arc base-200 is the lavender floor and made the graph look unhosted). -->
    <div class="min-h-0 flex-1 overflow-hidden {embedded ? 'bg-base-100' : 'bg-base-200'}">
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
          {t("graph.empty")}
        </div>
      {:else}
        <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
        <svg
          bind:this={svgEl}
          viewBox="0 0 {W} {H}"
          class="h-full w-full touch-none select-none"
          role="img"
          aria-label={t("graph.svgLabel")}
          onpointermove={onPointerMove}
          onpointerup={() => (dragging = null)}
        >
          {#each edges as e}
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
                stroke={node.current
                  ? "var(--color-primary)"
                  : "var(--color-base-content)"}
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
        </svg>
      {/if}
    </div>

    <div class="flex items-center gap-4 border-t border-base-300 px-4 py-1.5 text-xs opacity-60">
      <span class="flex items-center gap-1">
        <span class="inline-block h-2.5 w-2.5 rounded-full bg-primary"></span>
        {t("graph.legendCurrent")}
      </span>
      <span class="flex items-center gap-1">
        <span
          class="inline-block h-2.5 w-2.5 rounded-full border border-dashed border-base-content/60"
        ></span>
        {t("graph.legendUnresolved")}
      </span>
      <span class="ml-auto">{t("graph.legendHint")}</span>
    </div>
  </div>
  {#if !embedded}
    <button class="modal-backdrop" aria-label={t("graph.close")} onclick={onclose}></button>
  {/if}
</div>
