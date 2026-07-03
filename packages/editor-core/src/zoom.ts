// Shared pure pan/zoom math for transform-layer surfaces (the desktop graph
// view and the live-preview mermaid widget). A surface is described by a
// scale + translate applied to its content: a content point `world` maps to a
// screen/local point `p` via `p = t + world * scale`, and inversely
// `world = (p - t) / scale`. All functions here are DOM-free and headlessly
// testable; the consumers own the actual element/rAF/event wiring.
//
// DRY note: extracted from apps/desktop/src/lib/GraphView.svelte (zoomTo /
// easeOutCubic). GraphView is intentionally left consuming its own inline copy
// for now (its zoom is in viewBox units and battle-tested) — only the mermaid
// widget consumes this module, per the spec's low-risk DRY guidance.

export interface ZoomState {
  scale: number;
  /** translate-x in the surface's local pixel space */
  tx: number;
  /** translate-y in the surface's local pixel space */
  ty: number;
}

export interface Point {
  x: number;
  y: number;
}

/** Clamp a scale into [min, max]. */
export function clampScale(scale: number, min: number, max: number): number {
  return Math.min(Math.max(scale, min), max);
}

/**
 * Zoom by `factor` about a pointer position so the content point currently
 * under the pointer stays under it. `pointer` is in the surface's local pixel
 * space (i.e. relative to the same origin as `tx`/`ty`). The scale is clamped
 * into [min, max]; if the clamp leaves the scale unchanged the input state is
 * returned verbatim (no spurious translate jitter).
 */
export function zoomAtPoint(
  state: ZoomState,
  factor: number,
  pointer: Point,
  min: number,
  max: number,
): ZoomState {
  const next = clampScale(state.scale * factor, min, max);
  if (next === state.scale) return state;
  // Content coords under the pointer before the change.
  const worldX = (pointer.x - state.tx) / state.scale;
  const worldY = (pointer.y - state.ty) / state.scale;
  // Keep them fixed: pointer = t' + world * next  =>  t' = pointer - world * next.
  return {
    scale: next,
    tx: pointer.x - worldX * next,
    ty: pointer.y - worldY * next,
  };
}

/** easeOutCubic over [0,1]. */
export function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

/**
 * Eased interpolation of a full zoom state from `from` toward `to` at progress
 * `t` in [0,1] (easeOutCubic). Used by the +/- buttons and 1:1 reset to drive
 * an rAF animation; consumers should snap directly to `to` under
 * prefers-reduced-motion instead of stepping.
 */
export function easeStep(from: ZoomState, to: ZoomState, t: number): ZoomState {
  const e = easeOutCubic(t);
  return {
    scale: from.scale + (to.scale - from.scale) * e,
    tx: from.tx + (to.tx - from.tx) * e,
    ty: from.ty + (to.ty - from.ty) * e,
  };
}
