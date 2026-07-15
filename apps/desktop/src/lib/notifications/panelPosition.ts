// Viewport-clamped positioning for the notifications panel (and any other anchored popover
// that can open near a window edge). The desktop's bell sits in the sidebar header, close to
// the window's left edge, so daisyUI's `dropdown-end` (right edges aligned, growing leftward)
// pushed the panel's left portion past the window boundary — same failure mode ContextMenu.svelte
// solves for context menus. This is the same fix, extracted so the geometry is unit-testable
// without mounting a component.

/** Clamp the panel's left edge into [margin, viewportWidth - panelWidth - margin]. Preferring
 * `preferredLeft` (typically the anchor's right edge minus the panel width, mirroring
 * `dropdown-end`'s right-aligned look) keeps the panel tucked under the anchor whenever there's
 * room; the clamp only kicks in near a window edge. */
export function clampPanelLeft(
  preferredLeft: number,
  panelWidth: number,
  viewportWidth: number,
  margin = 8,
): number {
  const max = Math.max(margin, viewportWidth - panelWidth - margin);
  return Math.min(Math.max(preferredLeft, margin), max);
}

/** Clamp the panel's top edge into [margin, viewportHeight - panelHeight - margin]. Preferring
 * `preferredTop` (typically the anchor's bottom edge plus a small gap) keeps the panel directly
 * under the anchor whenever there's room below; in a short window (or an anchor near the
 * bottom) the clamp pulls it back up so it never renders below the viewport — the vertical
 * counterpart of `clampPanelLeft`, mirroring ContextMenu.svelte's top clamp. */
export function clampPanelTop(
  preferredTop: number,
  panelHeight: number,
  viewportHeight: number,
  margin = 8,
): number {
  const max = Math.max(margin, viewportHeight - panelHeight - margin);
  return Math.min(Math.max(preferredTop, margin), max);
}

/** Clamp the panel's max-height to whatever vertical room is actually left below `top` in a
 * `viewportHeight`-tall window, never exceeding `cap` (the panel's own preferred cap, 384px /
 * `max-h-96`). `clampPanelTop` only repositions the panel — it does not shrink it — so a short
 * window can still ask for more room than exists below `top` (or even than the viewport itself
 * has, once `top` is pinned at `margin`). Without this, a short-enough window makes part of the
 * notification list permanently unreachable: the fixed-position panel has no page scroll to fall
 * back on. Always returns at least 0 (a pathological viewport shorter than 2×margin) so the
 * caller never sets a negative CSS max-height. */
export function clampPanelMaxHeight(
  top: number,
  viewportHeight: number,
  cap = 384,
  margin = 8,
): number {
  return Math.max(0, Math.min(cap, viewportHeight - top - margin));
}
