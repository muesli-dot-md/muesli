// Pure color-hue helpers shared by the tint and folder-color bubble pickers
// (ColorBubbleRow.svelte) and their preset palettes. Every preset bubble
// renders as oklch(<l> <c> <hue>) — a fixed lightness/chroma so only hue
// varies and each row reads as one consistent set of swatches (the Tint row
// and the Folder row use different fixed L/C — see TINT_SWATCH_L/
// TINT_SWATCH_C below). The stores that actually apply a chosen hue
// (background.svelte.ts, folderColor.svelte.ts) re-derive their own
// theme-appropriate lightness/chroma from just that hue — see --floor-l and
// --folder-l/--folder-c in app.css.
//
// hexToHue/hueToHex exist only to bridge the native `<input type="color">`
// (which speaks hex) to the app's hue-only storage: hexToHue converts a picked
// color to the hue that gets stored; hueToHex seeds the input's starting value
// so the OS picker opens on a color matching the swatch.

export interface HuePreset {
  readonly hue: number;
  readonly label: string;
}

const SWATCH_L = 0.7;
const SWATCH_C = 0.16;

// The Tint hue row swatches at a softer L/C than SWATCH_L/SWATCH_C. The
// applied floor tint (app.css --floor-l, and --floor-c which tops out at 0.05
// even at 100% strength — see MAX_CHROMA in background.svelte.ts) is a very
// pale wash; swatching at the full 0.7/0.16 oversold the outcome — at the
// default strength, most presets produced nearly the same faint result once
// applied. L 0.82 / C 0.09 is a judgment call: pale enough to read as
// roughly what you'll get, saturated enough that all 7 hues still look
// clearly distinct from each other. (Selection still applies instantly to
// the app background, which is itself the real live preview — these
// swatches are only ever an approximation of that.) The Folder color row
// keeps SWATCH_L/SWATCH_C: its applied color (--folder-l/--folder-c in
// app.css) renders close to full swatch saturation, so there's no
// discrepancy to soften there.
export const TINT_SWATCH_L = 0.82;
export const TINT_SWATCH_C = 0.09;

/** The oklch() string every bubble swatch (preset or custom) renders with. */
export function swatchColor(hue: number, l = SWATCH_L, c = SWATCH_C): string {
  return `oklch(${l} ${c} ${hue})`;
}

// 7 hues around the wheel, anchored on the tint's existing default (295,
// violet — background.svelte.ts DEFAULTS.hue) so existing users' saved value
// is exactly one of the bubbles. Not evenly spaced: the two greens (Lime,
// Green) sit closer together than the ~51° an even 360/7 split would give,
// so they're pulled apart from each other and pushed away from their Amber
// and Teal neighbors to keep every adjacent pair >= ~30° apart — at bubble
// size, anything tighter reads as near-duplicate swatches rather than
// distinct colors (this is what the round-2 a11y review flagged: the
// original 118°/141° pair was only 23° apart). At this row's pale swatch
// L/C (TINT_SWATCH_L/TINT_SWATCH_C below), the sRGB gamut is barely clipped
// anywhere on the wheel, so — unlike the Folder palette below — hue choice
// here isn't constrained by a muddy/desaturated band.
export const TINT_HUE_PRESETS: HuePreset[] = [
  { hue: 295, label: "Violet" },
  { hue: 346, label: "Rose" },
  { hue: 38, label: "Amber" },
  { hue: 100, label: "Lime" },
  { hue: 140, label: "Green" },
  { hue: 192, label: "Teal" },
  { hue: 244, label: "Blue" },
];

// Same spacing pattern, anchored on the tree's existing folder-icon hue (250
// — --arc-accent in shared/palette.css) so the current look is the first
// bubble. Chartreuse and Green are pulled apart to keep every adjacent pair
// >= ~30° (the original 132°/147° pair was only 15° apart — read as
// near-duplicate greens at bubble size, per the round-2 a11y review). Both
// land inside this row's one clean, fully-saturated band — roughly
// 116°-159° at SWATCH_L/SWATCH_C — so neither reads as the dull, muddy
// mustard/olive that hues in the ~65°-115° and ~160°-235° gamut-clipped
// bands (see the gamut note on hueToHex below) would produce at this L/C.
export const FOLDER_HUE_PRESETS: HuePreset[] = [
  { hue: 250, label: "Blue" },
  { hue: 301, label: "Purple" },
  { hue: 353, label: "Rose" },
  { hue: 44, label: "Amber" },
  { hue: 120, label: "Chartreuse" },
  { hue: 155, label: "Green" },
  { hue: 199, label: "Teal" },
];

// matchesPreset's tolerance must safely clear hueToHex's worst-case
// gamut-mapping round-trip drift. Measured across every preset in both
// palettes (colorBubbles.test.ts), the worst case is ~0.602° (the Tint
// Rose preset, 346°); Teal (192°/199°) is actually the best-behaved pair in
// both palettes, drifting well under a tenth of a degree. The stores round
// hues to integers before persisting, so that drift can surface as a full
// 1° offset (round(346.602) = 347) — the comparison is therefore inclusive
// (<=), while 1° stays far tighter than the ~30° minimum gap between any two
// presets in either palette, so it can never make two presets both "match".
const PRESET_TOLERANCE_DEG = 1;

function presetIndex(hue: number, presets: readonly HuePreset[]): number {
  return presets.findIndex((p) => Math.abs(p.hue - hue) <= PRESET_TOLERANCE_DEG);
}

/** Is `hue` close enough to one of `presets` to read as that preset (vs custom)? */
export function matchesPreset(hue: number, presets: readonly HuePreset[]): boolean {
  return presetIndex(hue, presets) !== -1;
}

/**
 * Index of the preset `hue` matches, or -1 if `hue` reads as custom. Routed
 * through the same `presetIndex` helper as matchesPreset (rather than
 * duplicating the tolerance literal) so the two can never disagree about
 * whether a hue is "checked".
 */
export function findPresetIndex(hue: number, presets: readonly HuePreset[]): number {
  return presetIndex(hue, presets);
}

function srgbChannelToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function linearChannelToSrgb(c: number): number {
  const clamped = Math.min(1, Math.max(0, c));
  return clamped <= 0.0031308 ? clamped * 12.92 : 1.055 * clamped ** (1 / 2.4) - 0.055;
}

/** Parse `#rgb` or `#rrggbb` into 0–255 channel bytes. */
function parseHex(hex: string): [number, number, number] {
  let h = hex.trim().replace(/^#/, "");
  if (h.length === 3) {
    h = h
      .split("")
      .map((ch) => ch + ch)
      .join("");
  }
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function byteToHex(n: number): string {
  return Math.min(255, Math.max(0, Math.round(n)))
    .toString(16)
    .padStart(2, "0");
}

/**
 * Derive the OKLCH hue (0–360) of a hex color, e.g. from the native color
 * picker's `<input type="color">` value. Uses OKLab (Björn Ottosson's sRGB↔OKLab
 * matrices) so the hue matches the same color space as --arc-accent and every
 * other token in shared/palette.css.
 */
export function hexToHue(hex: string): number {
  const [r8, g8, b8] = parseHex(hex);
  const r = srgbChannelToLinear(r8 / 255);
  const g = srgbChannelToLinear(g8 / 255);
  const b = srgbChannelToLinear(b8 / 255);

  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;

  const l_ = Math.cbrt(l);
  const m_ = Math.cbrt(m);
  const s_ = Math.cbrt(s);

  const a = 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_;
  const bLab = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_;

  // Grays (near-zero chroma) have an unstable/meaningless hue from atan2 of
  // two near-zero values — fall back to 0 instead of a noisy result.
  if (Math.hypot(a, bLab) < 1e-4) return 0;

  const deg = (Math.atan2(bLab, a) * 180) / Math.PI;
  return deg < 0 ? deg + 360 : deg;
}

/** OKLCH (given in degrees) -> linear-sRGB, unclamped (may fall outside 0–1). */
function oklchToLinearSrgb(l: number, c: number, hueDeg: number): [number, number, number] {
  const hr = (hueDeg * Math.PI) / 180;
  const a = c * Math.cos(hr);
  const bLab = c * Math.sin(hr);

  const l_ = l + 0.3963377774 * a + 0.2158037573 * bLab;
  const m_ = l - 0.1055613458 * a - 0.0638541728 * bLab;
  const s_ = l - 0.0894841775 * a - 1.291485548 * bLab;

  const ll = l_ ** 3;
  const mm = m_ ** 3;
  const ss = s_ ** 3;

  const r = 4.0767416621 * ll - 3.3077115913 * mm + 0.2309699292 * ss;
  const g = -1.2684380046 * ll + 2.6097574011 * mm - 0.3413193965 * ss;
  const b = -0.0041960863 * ll - 0.7034186147 * mm + 1.707614701 * ss;
  return [r, g, b];
}

const GAMUT_EPSILON = 1e-5;

/** Is this linear-sRGB triple representable without clipping any channel? */
function inSrgbGamut([r, g, b]: [number, number, number]): boolean {
  return (
    r >= -GAMUT_EPSILON &&
    r <= 1 + GAMUT_EPSILON &&
    g >= -GAMUT_EPSILON &&
    g <= 1 + GAMUT_EPSILON &&
    b >= -GAMUT_EPSILON &&
    b <= 1 + GAMUT_EPSILON
  );
}

/**
 * Inverse of hexToHue at a given lightness/chroma (SWATCH_L/SWATCH_C by
 * default — pass TINT_SWATCH_L/TINT_SWATCH_C for the Tint row) — used only
 * to seed the native color input's starting value so it opens on the color
 * the swatch already shows.
 *
 * L 0.7/C 0.16 (and the softer Tint L/C) both fall outside the sRGB gamut for
 * some hues — notably yellows (~65–115°) and cyans (~160–235°). Naively
 * clamping each R/G/B channel independently after the OKLCH->linear-sRGB
 * conversion drags the resulting hue off target by up to ~2.8° at the worst
 * hues (89°, 96°, 199°) — enough to fail matchesPreset's tolerance and make
 * reopening the color picker on an already-chosen preset silently reclassify
 * it as "custom". Instead, this reduces chroma at the same L/h via binary
 * search until the color lands in-gamut (CSS Color 4's "reduce chroma"
 * gamut-mapping algorithm) before converting. That keeps hue intact — worst
 * measured drift drops to ~0.66° (see colorBubbles.test.ts) — and, as a
 * side effect, produces a truer-looking seed color too.
 */
export function hueToHex(hue: number, l = SWATCH_L, c = SWATCH_C): string {
  let chroma = c;
  let rgb = oklchToLinearSrgb(l, chroma, hue);

  if (!inSrgbGamut(rgb)) {
    let lo = 0;
    let hi = chroma;
    // 24 halvings is far more precision than a hue picker needs; the loop
    // only runs at all for the minority of hues that clip, so the cost is
    // negligible either way.
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (inSrgbGamut(oklchToLinearSrgb(l, mid, hue))) {
        lo = mid;
      } else {
        hi = mid;
      }
    }
    chroma = lo;
    rgb = oklchToLinearSrgb(l, chroma, hue);
  }

  const [rLin, gLin, bLin] = rgb;
  const r8 = linearChannelToSrgb(rLin) * 255;
  const g8 = linearChannelToSrgb(gLin) * 255;
  const b8 = linearChannelToSrgb(bLin) * 255;

  return `#${byteToHex(r8)}${byteToHex(g8)}${byteToHex(b8)}`;
}
