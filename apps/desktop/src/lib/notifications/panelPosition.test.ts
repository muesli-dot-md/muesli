import { describe, it, expect } from "vitest";
import { clampPanelLeft, clampPanelMaxHeight, clampPanelTop } from "./panelPosition";

describe("clampPanelLeft", () => {
  it("keeps the preferred position when there is room on both sides", () => {
    // Anchor toward the middle of a wide window: right-aligning under it fits fine.
    expect(clampPanelLeft(500, 320, 1200)).toBe(500);
  });

  it("clamps to the left margin when the anchor sits near the window's left edge", () => {
    // The desktop bell: anchor right edge ~60px in, panel 320px wide — preferred left is
    // negative (off-screen); the bug this reproduces (dropdown-end cut off past the window).
    const preferredLeft = 60 - 320;
    expect(preferredLeft).toBeLessThan(0);
    expect(clampPanelLeft(preferredLeft, 320, 1200)).toBe(8);
  });

  it("clamps to the right margin when the preferred position overshoots the window", () => {
    expect(clampPanelLeft(1150, 320, 1200)).toBe(1200 - 320 - 8);
  });

  it("respects a custom margin", () => {
    expect(clampPanelLeft(-100, 320, 1200, 16)).toBe(16);
  });

  it("never returns a value below margin even in a viewport narrower than the panel", () => {
    // Pathological: panel wider than the window. Left-clamp wins so the panel starts
    // fully on-screen rather than being pushed to a negative right-clamp target.
    expect(clampPanelLeft(-50, 500, 300)).toBe(8);
  });
});

describe("clampPanelTop", () => {
  it("keeps the preferred position when there is room below the anchor", () => {
    expect(clampPanelTop(60, 320, 900)).toBe(60);
  });

  it("clamps to the bottom margin when the anchor sits near the bottom of a short window", () => {
    // A short window: the bell's anchor.bottom + 4 would push a 320px-tall panel below
    // the viewport — the bug this reproduces.
    const preferredTop = 500;
    const viewportHeight = 600;
    expect(preferredTop + 320).toBeGreaterThan(viewportHeight);
    expect(clampPanelTop(preferredTop, 320, viewportHeight)).toBe(600 - 320 - 8);
  });

  it("clamps to the top margin when the preferred position is negative", () => {
    expect(clampPanelTop(-40, 320, 900)).toBe(8);
  });

  it("respects a custom margin", () => {
    expect(clampPanelTop(-100, 320, 900, 16)).toBe(16);
  });

  it("never returns a value below margin even in a viewport shorter than the panel", () => {
    // Pathological: panel taller than the window. Top-clamp wins so the panel starts
    // fully on-screen rather than being pushed to a negative bottom-clamp target.
    expect(clampPanelTop(-50, 500, 300)).toBe(8);
  });
});

describe("clampPanelMaxHeight", () => {
  it("keeps the cap when the window is tall enough for it", () => {
    expect(clampPanelMaxHeight(60, 900)).toBe(384);
  });

  it("shrinks below the cap in a short window — the bug this reproduces", () => {
    // top pinned at the 8px top margin (clampPanelTop already did its job), but the
    // window is only 300px tall: 384 would still run off the bottom.
    expect(clampPanelMaxHeight(8, 300)).toBe(300 - 8 - 8);
  });

  it("respects a custom cap", () => {
    expect(clampPanelMaxHeight(8, 900, 200)).toBe(200);
  });

  it("respects a custom margin", () => {
    expect(clampPanelMaxHeight(8, 300, 384, 16)).toBe(300 - 8 - 16);
  });

  it("never returns a negative max-height in a pathological viewport", () => {
    expect(clampPanelMaxHeight(50, 40)).toBe(0);
  });
});
