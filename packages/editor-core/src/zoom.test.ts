import { describe, it, expect } from "vitest";
import { clampScale, zoomAtPoint, easeStep, easeOutCubic, type ZoomState } from "./zoom";

const at = (scale: number, tx = 0, ty = 0): ZoomState => ({ scale, tx, ty });

describe("clampScale", () => {
  it("clamps below min and above max", () => {
    expect(clampScale(0.05, 0.3, 4)).toBe(0.3);
    expect(clampScale(10, 0.3, 4)).toBe(4);
    expect(clampScale(1, 0.3, 4)).toBe(1);
  });
});

describe("zoomAtPoint", () => {
  it("keeps the anchored content point under the cursor when zooming in", () => {
    const state = at(1, 0, 0);
    const pointer = { x: 100, y: 50 };
    // content coords under the pointer BEFORE the zoom: (p - t) / scale
    const worldX = (pointer.x - state.tx) / state.scale;
    const worldY = (pointer.y - state.ty) / state.scale;
    const next = zoomAtPoint(state, 2, pointer, 0.3, 4);
    // After zoom, the same world point must still map under the pointer:
    // p = t' + world * scale'
    expect(next.tx + worldX * next.scale).toBeCloseTo(pointer.x, 6);
    expect(next.ty + worldY * next.scale).toBeCloseTo(pointer.y, 6);
    expect(next.scale).toBe(2);
  });

  it("keeps the anchor under the cursor with a non-zero starting translate", () => {
    const state = at(1.5, 40, -20);
    const pointer = { x: 220, y: 130 };
    const worldX = (pointer.x - state.tx) / state.scale;
    const worldY = (pointer.y - state.ty) / state.scale;
    const next = zoomAtPoint(state, 0.5, pointer, 0.3, 4);
    expect(next.tx + worldX * next.scale).toBeCloseTo(pointer.x, 6);
    expect(next.ty + worldY * next.scale).toBeCloseTo(pointer.y, 6);
  });

  it("clamps the scale at the bounds and leaves translate unchanged when no zoom happens", () => {
    const state = at(4, 12, 34);
    // factor would push past max -> scale stays at 4, translate unchanged
    const next = zoomAtPoint(state, 2, { x: 10, y: 10 }, 0.3, 4);
    expect(next.scale).toBe(4);
    expect(next.tx).toBe(12);
    expect(next.ty).toBe(34);
  });

  it("respects the lower clamp", () => {
    const state = at(0.3, 0, 0);
    const next = zoomAtPoint(state, 0.5, { x: 50, y: 50 }, 0.3, 4);
    expect(next.scale).toBe(0.3);
  });
});

describe("easeOutCubic", () => {
  it("maps 0->0, 1->1 and is monotonic increasing", () => {
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
    let prev = -1;
    for (let t = 0; t <= 1.0001; t += 0.1) {
      const e = easeOutCubic(Math.min(t, 1));
      expect(e).toBeGreaterThanOrEqual(prev);
      prev = e;
    }
  });
});

describe("easeStep", () => {
  it("interpolates monotonically toward the target and lands exactly at t=1", () => {
    const from = at(1, 0, 0);
    const to = at(2.5, 100, -40);
    let prevScale = from.scale;
    for (let t = 0; t <= 1.0001; t += 0.25) {
      const s = easeStep(from, to, Math.min(t, 1));
      expect(s.scale).toBeGreaterThanOrEqual(prevScale - 1e-9);
      prevScale = s.scale;
    }
    const end = easeStep(from, to, 1);
    expect(end.scale).toBeCloseTo(2.5, 9);
    expect(end.tx).toBeCloseTo(100, 9);
    expect(end.ty).toBeCloseTo(-40, 9);
    const begin = easeStep(from, to, 0);
    expect(begin.scale).toBeCloseTo(1, 9);
    expect(begin.tx).toBeCloseTo(0, 9);
    expect(begin.ty).toBeCloseTo(0, 9);
  });
});
