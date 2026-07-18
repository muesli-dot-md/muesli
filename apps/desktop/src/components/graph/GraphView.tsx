// Obsidian-style "universe" graph view (ADR 0015). React port of
// src/lib/GraphView.svelte: the Rust `build_link_graph` command scans the open
// workspace's `.md` files for [[wikilinks]] and returns {nodes, edges,
// unresolved}. Every note is a node, resolved wikilinks are edges, unresolved
// targets render as dashed ghost nodes. Clicking a real node opens that note.
//
// Hand-rolled force layout (pairwise repulsion + edge springs + center
// gravity, alpha-decayed — no d3). ALL simulation state lives in refs; the rAF
// loop mutates in place and bumps a frame counter so React re-renders the SVG
// at most once per animation frame (a keystroke-safe, remount-free loop).

import { useEffect, useReducer, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Minus, Plus } from "lucide-react";

import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { buildLinkGraph } from "@/services/tauri";
import { slugify } from "@muesli/editor-core/render";

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
const MIN_SCALE = 0.2;
const MAX_SCALE = 4;

const prefersReducedMotion = () =>
  typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

const clampScale = (s: number) => Math.min(Math.max(s, MIN_SCALE), MAX_SCALE);

const radius = (n: SimNode) => 5 + 2.5 * Math.sqrt(n.degree);

export function GraphView({
  root,
  activePath = null,
  onOpen,
}: {
  /** Workspace root to scan; null renders the empty state. */
  root: string | null;
  /** Absolute path of the active note, highlighted as the current node. */
  activePath?: string | null;
  /** Open a note (switches back to the editor). */
  onOpen: (path: string, name: string) => void;
}) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [hovered, setHovered] = useState<string | null>(null);
  // One render per simulation/pan/zoom frame: the SVG reads the refs below.
  const [, bump] = useReducer((c: number) => c + 1, 0);

  const svgRef = useRef<SVGSVGElement | null>(null);
  const nodesRef = useRef<SimNode[]>([]);
  const edgesRef = useRef<SimEdge[]>([]);
  const alphaRef = useRef(1);
  const rafRef = useRef(0);
  const zoomAnimRef = useRef(0);
  const draggingRef = useRef<{ index: number; moved: number } | null>(null);
  const panningRef = useRef<{ startX: number; startY: number; tx0: number; ty0: number } | null>(
    null,
  );
  // Zoom/pan: a scale+translate transform applied to the inner <g> (in viewBox
  // units). The dot-grid background lives inside the same <g>, so it pans and
  // zooms as one surface.
  const viewRef = useRef({ scale: 1, tx: 0, ty: 0 });
  const activePathRef = useRef(activePath);
  activePathRef.current = activePath;

  // --- simulation -------------------------------------------------------------

  function tick() {
    const nodes = nodesRef.current;
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
        const f = Math.min((1800 / d2) * alphaRef.current, 12);
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
    for (const e of edgesRef.current) {
      const a = nodes[e.a];
      const b = nodes[e.b];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
      const f = (d - REST) * 0.02 * alphaRef.current;
      const fx = (dx / d) * f;
      const fy = (dy / d) * f;
      a.vx += fx;
      a.vy += fy;
      b.vx -= fx;
      b.vy -= fy;
    }
    // Center gravity + integration with damping.
    for (const node of nodes) {
      node.vx += (W / 2 - node.x) * 0.012 * alphaRef.current;
      node.vy += (H / 2 - node.y) * 0.012 * alphaRef.current;
      node.vx *= 0.85;
      node.vy *= 0.85;
      node.x += node.vx;
      node.y += node.vy;
      node.x = Math.min(Math.max(node.x, 16), W - 16);
      node.y = Math.min(Math.max(node.y, 16), H - 16);
    }
    alphaRef.current *= 0.985;
  }

  function loop() {
    if (alphaRef.current > 0.02 || draggingRef.current) {
      tick();
      bump();
      rafRef.current = requestAnimationFrame(loop);
    } else {
      rafRef.current = 0;
    }
  }

  function reheat(a = 0.4) {
    alphaRef.current = Math.max(alphaRef.current, a);
    if (!rafRef.current) rafRef.current = requestAnimationFrame(loop);
  }

  // --- zoom / pan --------------------------------------------------------------

  // Convert a pointer event to viewBox units (pre-transform, i.e. the SVG's own
  // coordinate space spanning 0..W / 0..H).
  function toSvg(ev: { clientX: number; clientY: number }): { x: number; y: number } {
    const rect = svgRef.current!.getBoundingClientRect();
    return {
      x: ((ev.clientX - rect.left) / rect.width) * W,
      y: ((ev.clientY - rect.top) / rect.height) * H,
    };
  }

  // Zoom toward an anchor point (in viewBox units) so that point stays put.
  function zoomTo(nextScale: number, anchorX: number, anchorY: number) {
    const v = viewRef.current;
    const s = clampScale(nextScale);
    if (s === v.scale) return;
    // World coords under the anchor before the change: (anchor - t) / scale.
    // Keep them fixed: anchor = t' + world * s  =>  t' = anchor - world * s.
    const worldX = (anchorX - v.tx) / v.scale;
    const worldY = (anchorY - v.ty) / v.scale;
    v.tx = anchorX - worldX * s;
    v.ty = anchorY - worldY * s;
    v.scale = s;
    bump();
  }

  // Animate the scale toward `target`, zooming on the viewport center.
  function animateZoom(target: number) {
    const s = clampScale(target);
    const cx = W / 2;
    const cy = H / 2;
    if (prefersReducedMotion()) {
      zoomTo(s, cx, cy);
      return;
    }
    if (zoomAnimRef.current) cancelAnimationFrame(zoomAnimRef.current);
    const from = viewRef.current.scale;
    const start = performance.now();
    const DUR = 160;
    const step = (now: number) => {
      const t = Math.min((now - start) / DUR, 1);
      // easeOutCubic
      const e = 1 - Math.pow(1 - t, 3);
      zoomTo(from + (s - from) * e, cx, cy);
      if (t < 1) zoomAnimRef.current = requestAnimationFrame(step);
      else zoomAnimRef.current = 0;
    };
    zoomAnimRef.current = requestAnimationFrame(step);
  }

  const zoomIn = () => animateZoom(viewRef.current.scale * 1.2);
  const zoomOut = () => animateZoom(viewRef.current.scale / 1.2);

  function resetView() {
    const v = viewRef.current;
    if (prefersReducedMotion()) {
      v.scale = 1;
      v.tx = 0;
      v.ty = 0;
      bump();
      return;
    }
    if (zoomAnimRef.current) cancelAnimationFrame(zoomAnimRef.current);
    const from = { s: v.scale, tx: v.tx, ty: v.ty };
    const start = performance.now();
    const DUR = 200;
    const step = (now: number) => {
      const t = Math.min((now - start) / DUR, 1);
      const e = 1 - Math.pow(1 - t, 3);
      v.scale = from.s + (1 - from.s) * e;
      v.tx = from.tx + (0 - from.tx) * e;
      v.ty = from.ty + (0 - from.ty) * e;
      bump();
      if (t < 1) zoomAnimRef.current = requestAnimationFrame(step);
      else zoomAnimRef.current = 0;
    };
    zoomAnimRef.current = requestAnimationFrame(step);
  }

  // --- data → sim --------------------------------------------------------------

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError("");
      if (!root) {
        nodesRef.current = [];
        edgesRef.current = [];
        setLoading(false);
        return;
      }
      try {
        const graph = await buildLinkGraph(root);
        if (cancelled) return;

        const sim: SimNode[] = [];
        const byId = new Map<string, number>();
        for (const node of graph.nodes) {
          byId.set(node.id, sim.length);
          sim.push({
            id: node.id,
            label: node.title,
            ghost: false,
            current: node.id === activePathRef.current,
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
        // One ghost node per distinct unresolved target (keyed by its slugified
        // form so [[Ghost]] and [[ghost]] collapse), dashed-linked from every
        // note naming it.
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
        nodesRef.current = sim;
        edgesRef.current = simEdges;
        alphaRef.current = 1;
        reheat(1);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
      if (zoomAnimRef.current) cancelAnimationFrame(zoomAnimRef.current);
      zoomAnimRef.current = 0;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- activePath is read at load time only (highlight tracks it separately below)
  }, [root]);

  // Keep the "current note" highlight in sync without re-running the layout.
  useEffect(() => {
    for (const n of nodesRef.current) n.current = !n.ghost && n.id === activePath;
    bump();
  }, [activePath]);

  const hasNodes = nodesRef.current.length > 0;

  // Wheel zoom needs a NON-passive listener (React attaches root wheel handlers
  // passively, so ev.preventDefault() in onWheel is ignored and the page would
  // rubber-band instead of zooming).
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const onWheel = (ev: WheelEvent) => {
      ev.preventDefault();
      const { x, y } = toSvg(ev);
      // Exponential zoom keeps the feel consistent across scroll magnitudes.
      const factor = Math.exp(-ev.deltaY * 0.0015);
      zoomTo(viewRef.current.scale * factor, x, y);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-attach when the <svg> (re)mounts
  }, [loading, error, hasNodes]);

  // --- interaction ---------------------------------------------------------------

  // Pointer → world coords (the space nodes live in, inside the transformed <g>).
  function toWorld(ev: { clientX: number; clientY: number }): { x: number; y: number } {
    const { x, y } = toSvg(ev);
    const v = viewRef.current;
    return { x: (x - v.tx) / v.scale, y: (y - v.ty) / v.scale };
  }

  function onNodeDown(index: number, ev: ReactPointerEvent) {
    ev.stopPropagation();
    draggingRef.current = { index, moved: 0 };
    (ev.currentTarget as Element).setPointerCapture(ev.pointerId);
    reheat(0.3);
  }

  function onPointerMove(ev: ReactPointerEvent) {
    const dragging = draggingRef.current;
    const panning = panningRef.current;
    if (dragging) {
      if (!svgRef.current) return;
      const { x, y } = toWorld(ev);
      const node = nodesRef.current[dragging.index];
      dragging.moved += Math.abs(x - node.x) + Math.abs(y - node.y);
      node.x = x;
      node.y = y;
      node.vx = 0;
      node.vy = 0;
      reheat(0.3);
    } else if (panning) {
      const rect = svgRef.current!.getBoundingClientRect();
      const dx = ((ev.clientX - panning.startX) / rect.width) * W;
      const dy = ((ev.clientY - panning.startY) / rect.height) * H;
      viewRef.current.tx = panning.tx0 + dx;
      viewRef.current.ty = panning.ty0 + dy;
      bump();
    }
  }

  function onCanvasDown(ev: ReactPointerEvent) {
    if (draggingRef.current) return;
    panningRef.current = {
      startX: ev.clientX,
      startY: ev.clientY,
      tx0: viewRef.current.tx,
      ty0: viewRef.current.ty,
    };
    (ev.currentTarget as Element).setPointerCapture(ev.pointerId);
    bump(); // cursor: grab → grabbing
  }

  function onPointerUp() {
    draggingRef.current = null;
    panningRef.current = null;
    bump();
  }

  function onNodeUp(index: number) {
    const dragging = draggingRef.current;
    const wasDrag = dragging !== null && dragging.moved > 6;
    draggingRef.current = null;
    if (wasDrag) return;
    const node = nodesRef.current[index];
    // Ghosts have no backing file; the current note is already open.
    if (node.ghost || node.id === activePath) return;
    onOpen(node.id, node.label);
  }

  // --- render -------------------------------------------------------------------

  const nodes = nodesRef.current;
  const edges = edgesRef.current;
  const { scale, tx, ty } = viewRef.current;
  const alwaysLabel = nodes.length < 30;
  const docTotal = nodes.filter((n) => !n.ghost).length;
  const linkTotal = edges.filter((e) => !e.ghost).length;
  const ghostTotal = nodes.length - docTotal;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-surface-border px-4 py-2">
        <div className="text-sm">
          <span className="font-semibold">Graph</span>
          {!loading && !error ? (
            <span className="text-muted-foreground">
              {" "}
              · {docTotal} {docTotal === 1 ? "note" : "notes"} · {linkTotal}{" "}
              {linkTotal === 1 ? "link" : "links"}
              {ghostTotal > 0 ? <> · {ghostTotal} unresolved</> : null}
            </span>
          ) : null}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        {loading ? (
          <div className="flex h-full items-center justify-center">
            <Spinner className="size-8 text-muted-foreground" />
          </div>
        ) : error ? (
          <div className="flex h-full items-center justify-center px-8 text-center text-sm text-muted-foreground">
            {error}
          </div>
        ) : nodes.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            No notes to graph yet — add some{" "}
            <code className="mx-1 rounded bg-muted px-1 font-mono text-xs">[[wikilinks]]</code>{" "}
            between notes.
          </div>
        ) : (
          <div className="relative h-full w-full">
            <svg
              ref={svgRef}
              viewBox={`0 0 ${W} ${H}`}
              className={cn(
                "h-full w-full touch-none select-none",
                panningRef.current ? "cursor-grabbing" : "cursor-grab",
              )}
              role="img"
              aria-label="Link graph"
              onPointerDown={onCanvasDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerLeave={onPointerUp}
            >
              <defs>
                {/* Faint dot grid, in world units, so it lives inside the
                    transformed <g> and pans/zooms with the nodes (n8n-style
                    surface). Color derives from the foreground token at low
                    alpha → theme-aware. */}
                <pattern
                  id="graph-dot-grid"
                  x="0"
                  y="0"
                  width="28"
                  height="28"
                  patternUnits="userSpaceOnUse"
                >
                  <circle cx="1.4" cy="1.4" r="1.4" fill="var(--foreground)" fillOpacity="0.08" />
                </pattern>
              </defs>

              <g transform={`translate(${tx} ${ty}) scale(${scale})`}>
                {/* Background surface, large enough to cover well past the
                    layout at any sane pan. pointer-events stay on the parent
                    <svg> for canvas panning. */}
                <rect
                  x={-2 * W}
                  y={-2 * H}
                  width={5 * W}
                  height={5 * H}
                  fill="url(#graph-dot-grid)"
                  className="pointer-events-none"
                />

                {edges.map((e, i) => (
                  <line
                    key={i}
                    x1={nodes[e.a].x}
                    y1={nodes[e.a].y}
                    x2={nodes[e.b].x}
                    y2={nodes[e.b].y}
                    stroke="var(--foreground)"
                    strokeOpacity={e.ghost ? 0.18 : 0.3}
                    strokeWidth="1.2"
                    strokeDasharray={e.ghost ? "4 4" : undefined}
                  />
                ))}
                {nodes.map((node, i) => (
                  <g
                    key={node.id}
                    className={node.ghost ? "opacity-70" : "cursor-pointer"}
                    onPointerDown={(ev) => onNodeDown(i, ev)}
                    onPointerUp={() => onNodeUp(i)}
                    onPointerEnter={() => setHovered(node.id)}
                    onPointerLeave={() => setHovered(null)}
                  >
                    <circle
                      cx={node.x}
                      cy={node.y}
                      r={radius(node)}
                      fill={
                        node.ghost
                          ? "var(--muted)"
                          : node.current
                            ? "var(--brand)"
                            : "var(--foreground)"
                      }
                      fillOpacity={node.ghost ? 0.4 : node.current ? 1 : 0.55}
                      stroke={node.current ? "var(--brand)" : "var(--foreground)"}
                      strokeOpacity={node.current ? 0.9 : 0.5}
                      strokeWidth={node.current ? 2 : 1}
                      strokeDasharray={node.ghost ? "3 3" : undefined}
                    />
                    {alwaysLabel || hovered === node.id ? (
                      <text
                        x={node.x}
                        y={node.y + radius(node) + 12}
                        textAnchor="middle"
                        className="pointer-events-none"
                        fontSize="11"
                        fill="var(--foreground)"
                        fillOpacity={node.ghost ? 0.5 : 0.8}
                        fontStyle={node.ghost ? "italic" : undefined}
                      >
                        {node.label}
                      </text>
                    ) : null}
                  </g>
                ))}
              </g>
            </svg>

            {/* Zoom controls, pinned bottom-left (Multica surface: raised card,
                hairline ring, menu-tier shadow). */}
            <div className="absolute bottom-3 left-3 flex flex-col overflow-hidden rounded-lg bg-surface-raised shadow-[var(--menu-shadow)] ring-1 ring-surface-border">
              <button
                type="button"
                aria-label="Zoom in"
                title="Zoom in"
                className="flex size-9 items-center justify-center text-muted-foreground transition-colors hover:bg-surface-hover hover:text-foreground active:translate-y-px"
                onClick={zoomIn}
              >
                <Plus className="size-4" />
              </button>
              <button
                type="button"
                aria-label="Reset zoom"
                title="Reset view"
                className="flex size-9 items-center justify-center border-y border-surface-border text-[11px] font-medium text-muted-foreground transition-colors hover:bg-surface-hover hover:text-foreground active:translate-y-px"
                onClick={resetView}
              >
                1:1
              </button>
              <button
                type="button"
                aria-label="Zoom out"
                title="Zoom out"
                className="flex size-9 items-center justify-center text-muted-foreground transition-colors hover:bg-surface-hover hover:text-foreground active:translate-y-px"
                onClick={zoomOut}
              >
                <Minus className="size-4" />
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="flex items-center gap-4 border-t border-surface-border px-4 py-1.5 text-xs text-muted-foreground">
        <span className="flex items-center gap-1">
          <span className="inline-block size-2.5 rounded-full bg-brand" />
          Current note
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block size-2.5 rounded-full border border-dashed border-foreground/60" />
          Unresolved
        </span>
        <span className="ml-auto">Drag to move · click to open</span>
      </div>
    </div>
  );
}

// AppShell (F1) imports this as a default export; keep both forms.
export default GraphView;
