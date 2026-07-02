// User-adjustable window background (the translucent floor over the macOS
// vibrancy). Persists to localStorage and drives the CSS vars --floor-a /
// --floor-h / --floor-c (composed into --floor-tint in app.css). --floor-l
// (lightness) stays theme-controlled so the tint adapts to light/dark.

const KEY = "muesli:background";
const MAX_CHROMA = 0.05; // tint=100 → this much chroma

const DEFAULTS = { translucency: 70, hue: 295, tint: 36 };

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.round(v)));
}

function load(): { translucency: number; hue: number; tint: number } {
  if (typeof localStorage === "undefined") return { ...DEFAULTS };
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    const p = JSON.parse(raw);
    return {
      translucency: clamp(p.translucency ?? DEFAULTS.translucency, 0, 100),
      hue: clamp(p.hue ?? DEFAULTS.hue, 0, 360),
      tint: clamp(p.tint ?? DEFAULTS.tint, 0, 100),
    };
  } catch {
    return { ...DEFAULTS };
  }
}

function createBackground() {
  const init = load();
  let translucency = $state(init.translucency); // 0 = opaque, 100 = fully clear
  let hue = $state(init.hue); // 0–360
  let tint = $state(init.tint); // 0 = neutral gray, 100 = max chroma

  function apply() {
    if (typeof document === "undefined") return;
    const el = document.documentElement;
    el.style.setProperty("--floor-a", ((100 - translucency) / 100).toFixed(3));
    el.style.setProperty("--floor-h", String(hue));
    el.style.setProperty("--floor-c", ((tint / 100) * MAX_CHROMA).toFixed(4));
  }

  function persist() {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(KEY, JSON.stringify({ translucency, hue, tint }));
    }
  }

  return {
    get translucency() {
      return translucency;
    },
    set translucency(v: number) {
      translucency = clamp(v, 0, 100);
      apply();
      persist();
    },
    get hue() {
      return hue;
    },
    set hue(v: number) {
      hue = clamp(v, 0, 360);
      apply();
      persist();
    },
    get tint() {
      return tint;
    },
    set tint(v: number) {
      tint = clamp(v, 0, 100);
      apply();
      persist();
    },
    /** Apply persisted values to the DOM (call once on app start). */
    init() {
      apply();
    },
    reset() {
      translucency = DEFAULTS.translucency;
      hue = DEFAULTS.hue;
      tint = DEFAULTS.tint;
      apply();
      persist();
    },
  };
}

export const background = createBackground();
