import { describe, it, expect } from "vitest";
import {
  hexToHue,
  hueToHex,
  matchesPreset,
  swatchColor,
  TINT_HUE_PRESETS,
  FOLDER_HUE_PRESETS,
  TINT_SWATCH_L,
  TINT_SWATCH_C,
} from "./colorBubbles";

describe("hexToHue", () => {
  it("matches known OKLCH hues for primary colors", () => {
    // Reference values from the standard OKLab sRGB matrices (Björn Ottosson).
    expect(hexToHue("#ff0000")).toBeCloseTo(29.23, 1);
    expect(hexToHue("#00ff00")).toBeCloseTo(142.5, 1);
    expect(hexToHue("#0000ff")).toBeCloseTo(264.05, 1);
  });

  it("falls back to 0 for achromatic colors instead of a noisy atan2 result", () => {
    expect(hexToHue("#ffffff")).toBe(0);
    expect(hexToHue("#888888")).toBe(0);
    expect(hexToHue("#000000")).toBe(0);
  });

  it("accepts 3-digit shorthand hex", () => {
    expect(hexToHue("#f00")).toBeCloseTo(hexToHue("#ff0000"), 5);
  });

  it("is case-insensitive and tolerates a missing #", () => {
    expect(hexToHue("FF0000")).toBeCloseTo(hexToHue("#ff0000"), 5);
  });
});

describe("hueToHex / hexToHue round trip", () => {
  // The actual product invariant: ColorBubbleRow seeds the native color
  // picker via hueToHex(currentHue), and reopening it (even without picking a
  // new color) can round-trip that hue through hexToHue. Whatever drift that
  // round trip introduces must still satisfy matchesPreset for every preset
  // — otherwise reopening the picker on an already-chosen preset silently
  // reclassifies the selection as "custom". A loose "within 4 degrees" check
  // hid a real bug here (naive per-channel clamping drifted hues 89/96/199 by
  // up to ~2.8°, well past matchesPreset's old 0.5° tolerance); asserting
  // matchesPreset directly is the real requirement that tolerance exists to
  // protect, for every preset in both palettes.
  it.each(TINT_HUE_PRESETS.map((p) => [p.label, p.hue] as const))(
    "Tint preset %s (%d°) still matches its own preset after a hex round trip",
    (_label, hue) => {
      const recovered = hexToHue(hueToHex(hue, TINT_SWATCH_L, TINT_SWATCH_C));
      expect(matchesPreset(recovered, TINT_HUE_PRESETS)).toBe(true);
    },
  );

  it.each(FOLDER_HUE_PRESETS.map((p) => [p.label, p.hue] as const))(
    "Folder preset %s (%d°) still matches its own preset after a hex round trip",
    (_label, hue) => {
      const recovered = hexToHue(hueToHex(hue));
      expect(matchesPreset(recovered, FOLDER_HUE_PRESETS)).toBe(true);
    },
  );
});

describe("matchesPreset", () => {
  it("is true for an exact preset hue", () => {
    expect(matchesPreset(262, FOLDER_HUE_PRESETS)).toBe(true);
  });

  it("is true within floating-point tolerance", () => {
    expect(matchesPreset(261.6, FOLDER_HUE_PRESETS)).toBe(true);
  });

  it("is false for a hue that isn't a preset (custom)", () => {
    expect(matchesPreset(10, FOLDER_HUE_PRESETS)).toBe(false);
  });
});

describe("swatchColor", () => {
  it("renders a fixed-lightness/chroma oklch() string for any hue", () => {
    expect(swatchColor(180)).toBe("oklch(0.7 0.16 180)");
  });
});

describe("preset palettes", () => {
  it.each([
    ["TINT_HUE_PRESETS", TINT_HUE_PRESETS, 244],
    ["FOLDER_HUE_PRESETS", FOLDER_HUE_PRESETS, 262],
  ])(
    "%s has 7 distinct in-range hues with the current default first",
    (_name, presets, defaultHue) => {
      expect(presets).toHaveLength(7);
      expect(presets[0].hue).toBe(defaultHue);
      for (const { hue, label } of presets) {
        expect(hue).toBeGreaterThanOrEqual(0);
        expect(hue).toBeLessThan(360);
        expect(label.length).toBeGreaterThan(0);
      }
      const hues = presets.map((p) => p.hue);
      expect(new Set(hues).size).toBe(hues.length);
    },
  );
});
