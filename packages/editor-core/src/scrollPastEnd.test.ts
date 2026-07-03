import { describe, it, expect } from "vitest";
import { scrollPastEndPadding } from "./scrollPastEnd";

describe("scrollPastEndPadding", () => {
  it("lets the last line scroll to near the top: viewport minus one line", () => {
    // VSCode "scroll beyond last line": the bottom padding is sized so the last
    // line can sit one line-height below the top of the viewport.
    expect(scrollPastEndPadding(800, 20)).toBe(780);
    expect(scrollPastEndPadding(500, 24)).toBe(476);
  });

  it("is bounded (never larger than the viewport, never infinite)", () => {
    const pad = scrollPastEndPadding(640, 18);
    expect(pad).toBeLessThan(640);
    expect(Number.isFinite(pad)).toBe(true);
  });

  it("never returns a negative padding for tiny/degenerate viewports", () => {
    expect(scrollPastEndPadding(0, 20)).toBe(0);
    expect(scrollPastEndPadding(10, 20)).toBe(0);
    expect(scrollPastEndPadding(-5, 20)).toBe(0);
  });

  it("falls back to a sane value when geometry is missing (0/NaN inputs)", () => {
    expect(scrollPastEndPadding(0, 0)).toBe(0);
    expect(scrollPastEndPadding(NaN, 20)).toBe(0);
    expect(scrollPastEndPadding(600, NaN)).toBeGreaterThan(0);
  });
});
