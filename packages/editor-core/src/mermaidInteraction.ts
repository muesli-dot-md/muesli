// DOM wiring that turns a rendered mermaid block into an interactive,
// pannable/zoomable surface with a floating +/1:1/- control cluster. Shared by
// both apps' live-preview MermaidWidget (the only per-app difference is the
// control labels, which the webapp localizes and the desktop hardcodes).
//
// The transform (pan + scroll-to-cursor zoom) lives entirely on a wrapper
// around the mermaid-generated <svg>; the SVG internals are never mutated, so
// the source-keyed render cache stays valid. Pan/zoom state is transient per
// widget instance — it is discarded when the widget re-renders after a source
// edit (expected, per the design).
//
// dblclick-to-edit is NOT handled here: it needs the CodeMirror view to map the
// widget DOM to a doc position, so each app wires it in its livePreview/index.ts
// dblclick domEventHandler. Here we only own pan/zoom and swallow single
// clicks/drags so they never bubble into a cursor move that would reveal source.

import { clampScale, easeStep, zoomAtPoint, type ZoomState } from "./zoom";

export interface MermaidControlLabels {
  zoomIn: string;
  reset: string;
  zoomOut: string;
}

const MIN_SCALE = 0.3;
const MAX_SCALE = 4;
const IDENTITY: ZoomState = { scale: 1, tx: 0, ty: 0 };

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * Wire pan + scroll-zoom + a +/1:1/- control cluster onto a mermaid widget.
 * `root` is the `.cm-live-mermaid` container; `holder` is the `.mermaid-block`
 * that holds the rendered `<svg>`. Returns nothing — state is captured in the
 * closure and torn down via the AbortController on the root (CM drops the DOM
 * when the widget is replaced, so listeners on `root`/its children are GC'd
 * with it; the wheel listener is on `holder` and goes the same way).
 */
export function attachMermaidInteraction(
  root: HTMLElement,
  holder: HTMLElement,
  labels: MermaidControlLabels,
): void {
  // The transform layer wraps the SVG so the SVG itself is never touched.
  const layer = document.createElement("div");
  layer.className = "mermaid-pan-layer";
  layer.style.transformOrigin = "0 0";
  layer.style.willChange = "transform";
  // Move the rendered SVG (or error box) into the layer.
  while (holder.firstChild) layer.appendChild(holder.firstChild);
  holder.appendChild(layer);
  holder.classList.add("mermaid-interactive");

  let state: ZoomState = { ...IDENTITY };

  const apply = () => {
    layer.style.transform = `translate(${state.tx}px, ${state.ty}px) scale(${state.scale})`;
  };

  // --- animation (buttons / reset) ------------------------------------------
  let raf = 0;
  const cancelAnim = () => {
    if (raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
  };
  const animateTo = (target: ZoomState) => {
    if (prefersReducedMotion()) {
      state = target;
      apply();
      return;
    }
    cancelAnim();
    const from = state;
    const start = performance.now();
    const DUR = 160;
    const tick = (now: number) => {
      const t = Math.min((now - start) / DUR, 1);
      state = easeStep(from, target, t);
      apply();
      raf = t < 1 ? requestAnimationFrame(tick) : 0;
    };
    raf = requestAnimationFrame(tick);
  };

  // Center of the viewport in local pixel space, for button zoom anchoring.
  const viewportCenter = () => {
    const r = holder.getBoundingClientRect();
    return { x: r.width / 2, y: r.height / 2 };
  };

  const zoomByButton = (factor: number) => {
    const center = viewportCenter();
    const next = zoomAtPoint(state, factor, center, MIN_SCALE, MAX_SCALE);
    animateTo(next);
  };

  // --- wheel zoom (scoped to the diagram) -----------------------------------
  // preventDefault ONLY while the pointer is over the diagram, so page/editor
  // scroll elsewhere is never hijacked. Non-passive so preventDefault works.
  holder.addEventListener(
    "wheel",
    (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      cancelAnim();
      const r = holder.getBoundingClientRect();
      const pointer = { x: e.clientX - r.left, y: e.clientY - r.top };
      const factor = Math.exp(-e.deltaY * 0.0015);
      state = zoomAtPoint(state, factor, pointer, MIN_SCALE, MAX_SCALE);
      apply();
    },
    { passive: false },
  );

  // --- pan (pointer drag) ---------------------------------------------------
  // Single click/drag pans and is swallowed (no cursor move -> no source
  // reveal). dblclick is left to bubble so index.ts can reveal the source.
  let pan: { startX: number; startY: number; tx0: number; ty0: number } | null = null;
  let moved = 0;

  holder.addEventListener("pointerdown", (e: PointerEvent) => {
    if (e.button !== 0) return;
    // Ignore clicks on the control cluster (handled by their own listeners).
    if ((e.target as HTMLElement | null)?.closest(".mermaid-controls")) return;
    e.preventDefault();
    e.stopPropagation();
    cancelAnim();
    pan = { startX: e.clientX, startY: e.clientY, tx0: state.tx, ty0: state.ty };
    moved = 0;
    holder.setPointerCapture(e.pointerId);
    holder.classList.add("mermaid-panning");
  });
  holder.addEventListener("pointermove", (e: PointerEvent) => {
    if (!pan) return;
    const dx = e.clientX - pan.startX;
    const dy = e.clientY - pan.startY;
    moved += Math.abs(dx) + Math.abs(dy);
    state = { ...state, tx: pan.tx0 + dx, ty: pan.ty0 + dy };
    apply();
  });
  const endPan = (e: PointerEvent) => {
    if (!pan) return;
    pan = null;
    holder.classList.remove("mermaid-panning");
    try {
      holder.releasePointerCapture(e.pointerId);
    } catch {
      /* capture may already be gone */
    }
  };
  holder.addEventListener("pointerup", endPan);
  holder.addEventListener("pointercancel", endPan);
  // Swallow the single click that follows a pan so it never reaches CM (which
  // would move the cursor into the block and reveal source). dblclick is a
  // separate event and still fires.
  holder.addEventListener("click", (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
  });

  // --- control cluster (+/1:1/-) --------------------------------------------
  // Pinned to the diagram's bottom-right corner, OVERLAYING it like a map's
  // zoom control. Structural positioning/styling lives in each app's app.css
  // (`.mermaid-controls`) so it does not depend on Tailwind scanning this shared
  // package — the previous Tailwind utility classes were not always generated,
  // which left the cluster un-positioned and floating below the diagram.
  const controls = document.createElement("div");
  controls.className = "mermaid-controls";

  const mkBtn = (label: string, glyph: string, cls: string, onClick: () => void) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.setAttribute("aria-label", label);
    btn.title = label;
    btn.textContent = glyph;
    btn.className = `mermaid-control-btn ${cls}`;
    // Don't let button presses start a pan or bubble to CM.
    btn.addEventListener("pointerdown", (e) => e.stopPropagation());
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      onClick();
    });
    return btn;
  };

  controls.appendChild(mkBtn(labels.zoomIn, "+", "mermaid-control-glyph", () => zoomByButton(1.2)));
  controls.appendChild(
    mkBtn(labels.reset, "1:1", "mermaid-control-reset", () => animateTo({ ...IDENTITY })),
  );
  controls.appendChild(
    mkBtn(labels.zoomOut, "−", "mermaid-control-glyph", () => zoomByButton(1 / 1.2)),
  );

  // Append to the holder (the positioned, overflow-hidden .mermaid-block) so the
  // cluster anchors to the diagram box itself and sits above the panned SVG.
  holder.appendChild(controls);
  // Avoid an initial clamp surprise if some caller passes an out-of-range state.
  state = { ...state, scale: clampScale(state.scale, MIN_SCALE, MAX_SCALE) };
  apply();
}
