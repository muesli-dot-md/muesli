// Pins the desktop's "nothing changes until the user picks" invariant: the
// default blue preset must equal the stock --arc-primary /
// --arc-primary-content tokens EXACTLY, light and dark, because app.css falls
// back to those whenever the accent vars are unset. The values are parsed out
// of shared/palette.css itself, so a palette retune can no longer drift away
// from the preset (or vice versa) silently.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ACCENT_PRESETS } from "./accent.svelte";

const palette = readFileSync(
  fileURLToPath(new URL("../../../../shared/palette.css", import.meta.url)),
  "utf8",
);

/** All values of `--<name>: ...;` in palette order — the light (:root) block
 *  precedes the [data-theme$="-dark"] overrides, so index 0 is light, 1 dark. */
function tokenValues(name: string): string[] {
  return [...palette.matchAll(new RegExp(`--${name}:\\s*([^;]+);`, "g"))].map((m) => m[1].trim());
}

/** Numeric L/C/H of an `oklch(l c h)` literal — compared as numbers so a
 *  cosmetic 0.70 vs 0.7 difference is not a failure, but any real component
 *  drift is. */
function oklch(value: string): [number, number, number] {
  const m = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)$/.exec(value);
  if (!m) throw new Error(`not a plain oklch() literal: ${value}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

describe("blue preset vs shared palette", () => {
  it("equals --arc-primary/--arc-primary-content exactly, light and dark", () => {
    const blue = ACCENT_PRESETS.find((p) => p.id === "blue");
    expect(blue).toBeDefined();

    const primary = tokenValues("arc-primary");
    const content = tokenValues("arc-primary-content");
    expect(primary).toHaveLength(2);
    expect(content).toHaveLength(2);

    expect(oklch(blue!.light)).toEqual(oklch(primary[0]));
    expect(oklch(blue!.lightContent)).toEqual(oklch(content[0]));
    expect(oklch(blue!.dark)).toEqual(oklch(primary[1]));
    expect(oklch(blue!.darkContent)).toEqual(oklch(content[1]));
  });
});
