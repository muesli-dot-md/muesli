// User-adjustable background tint: the web counterpart of the desktop's floor
// tint (apps/desktop/src/lib/background.svelte.ts), minus translucency — the
// web has no window vibrancy, so the wash lands flat on the page floor instead.
// Persists to localStorage under "muesli:background" and drives the CSS vars
// --floor-c (chroma) / --floor-h (hue) that app.css composes into --floor per
// theme — the floor-only token behind the full-page shells; base-200 itself
// stays untinted so popover/menu/hover surfaces never pick up the wash (see
// the scoping invariant in app.css). Lightness stays theme-controlled, exactly
// like the desktop keeps --floor-l per theme. At tint 0 the vars are REMOVED,
// so the theme blocks' untouched fallbacks render exactly today's default
// background. Yjs-free, self-applying like theme.svelte.ts / accent.svelte.ts.

const KEY = "muesli:background";
// tint=100 → this much chroma. Same ceiling as the desktop's MAX_CHROMA
// (background.svelte.ts) so a synced tint_strength reads equally strong.
const MAX_CHROMA = 0.05;

// Hue matches the desktop's default (295, violet); tint defaults 0 — the web
// ships untinted today, and the synced prefs object is sparse, so this default
// holds until the user actually picks a strength.
const DEFAULTS = { hue: 295, tint: 0 };

function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return Math.max(lo, Math.min(hi, Math.round(v)));
}

function load(): { hue: number; tint: number } {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    const p = JSON.parse(raw);
    return {
      hue: clamp(p.hue ?? DEFAULTS.hue, 0, 360),
      tint: clamp(p.tint ?? DEFAULTS.tint, 0, 100),
    };
  } catch {
    return { ...DEFAULTS };
  }
}

const init = load();
let hue = $state(init.hue); // 0–360
let tint = $state(init.tint); // 0 = today's neutral floor, 100 = max chroma

function apply() {
  const el = document.documentElement;
  if (tint === 0) {
    // Fall back to the theme blocks' own defaults — bit-exact "today" colors
    // (the dark floor carries a tiny built-in chroma a composed 0 would lose).
    el.style.removeProperty("--floor-c");
    el.style.removeProperty("--floor-h");
    return;
  }
  el.style.setProperty("--floor-c", ((tint / 100) * MAX_CHROMA).toFixed(4));
  el.style.setProperty("--floor-h", String(hue));
}

function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify({ hue, tint }));
  } catch {
    // applies for this page either way
  }
}

apply();

export const background = {
  get hue(): number {
    return hue;
  },
  set hue(v: number) {
    hue = clamp(v, 0, 360);
    apply();
    persist();
  },
  get tint(): number {
    return tint;
  },
  set tint(v: number) {
    tint = clamp(v, 0, 100);
    apply();
    persist();
  },
  reset() {
    hue = DEFAULTS.hue;
    tint = DEFAULTS.tint;
    apply();
    persist();
  },
};
