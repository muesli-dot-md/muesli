import { describe, it, expect } from "vitest";
import { folderColor, FOLDER_DEFAULT_HUE } from "./folderColor.svelte";

// Node test env has no localStorage, so the store constructs from
// FOLDER_DEFAULT_HUE and persist() is a guarded no-op — same pattern as
// settings.test.ts / theme.test.ts.
describe("folderColor default", () => {
  it("defaults to the current --arc-accent hue (262)", () => {
    expect(folderColor.hue).toBe(FOLDER_DEFAULT_HUE);
    expect(FOLDER_DEFAULT_HUE).toBe(262);
  });
});

describe("folderColor.hue setter", () => {
  it("round-trips a value written through the setter", () => {
    folderColor.hue = 44;
    expect(folderColor.hue).toBe(44);
  });

  it("clamps to [0, 360]", () => {
    folderColor.hue = -20;
    expect(folderColor.hue).toBe(0);
    folderColor.hue = 999;
    expect(folderColor.hue).toBe(360);
  });

  it("rounds fractional input", () => {
    folderColor.hue = 199.6;
    expect(folderColor.hue).toBe(200);
  });
});

describe("folderColor.hue setter guards against non-finite input", () => {
  it("falls back to the default for NaN", () => {
    folderColor.hue = NaN;
    expect(folderColor.hue).toBe(FOLDER_DEFAULT_HUE);
  });

  it('falls back to the default for a non-numeric value, e.g. corrupted localStorage like {"hue":"blue"}', () => {
    // clampHue is shared by both the setter and the localStorage loader
    // (load()), so driving a non-numeric value through the setter exercises
    // the exact same guard that protects a corrupted persisted value from
    // writing --folder-h: NaN.
    folderColor.hue = "blue" as unknown as number;
    expect(folderColor.hue).toBe(FOLDER_DEFAULT_HUE);
  });
});

describe("folderColor.reset", () => {
  it("restores the default hue", () => {
    folderColor.hue = 44;
    folderColor.reset();
    expect(folderColor.hue).toBe(FOLDER_DEFAULT_HUE);
  });
});
