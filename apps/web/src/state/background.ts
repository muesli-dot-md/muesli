// User-adjustable background tint — React/zustand port of
// src/background.svelte.ts (adapted from the desktop's state/background.ts,
// MINUS translucency: the web has no window vibrancy, so the wash lands flat
// on the page floor instead). Persists to localStorage under
// "muesli:background" and drives the CSS vars --floor-c (chroma) / --floor-h
// (hue) that app.css composes into --floor per theme — the floor-only token
// behind the full-page shells; base-200 itself stays untinted so popover/menu/
// hover surfaces never pick up the wash (see the scoping invariant in
// app.css). Lightness stays theme-controlled. At tint 0 the vars are REMOVED,
// so the theme blocks' untouched fallbacks render exactly today's default
// background. Yjs-free, self-applying on import like theme.ts / accent.ts.
// Svelte property setters become setHue/setTint actions.

import { createStore } from "zustand/vanilla";
import { useStore } from "zustand";

const KEY = "muesli:background";
// tint=100 → this much chroma. Same ceiling as the desktop's MAX_CHROMA
// (state/background.ts) so a synced tint_strength reads equally strong.
const MAX_CHROMA = 0.05;

// Hue matches the desktop's default (244, blue); tint defaults 0 — the web
// ships untinted today, and the synced prefs object is sparse, so this default
// holds until the user actually picks a strength.
const DEFAULTS = { hue: 244, tint: 0 };

function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return Math.max(lo, Math.min(hi, Math.round(v)));
}

function load(): { hue: number; tint: number } {
  if (typeof localStorage === "undefined") return { ...DEFAULTS };
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

export interface BackgroundState {
  /** 0–360 */
  hue: number;
  /** 0 = today's neutral floor, 100 = max chroma */
  tint: number;
  setHue(v: number): void;
  setTint(v: number): void;
  /** Apply persisted values to the DOM (idempotent). */
  init(): void;
  reset(): void;
}

export const backgroundStore = createStore<BackgroundState>()((set, get) => {
  function apply() {
    if (typeof document === "undefined") return;
    const { hue, tint } = get();
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
    if (typeof localStorage === "undefined") return;
    try {
      const { hue, tint } = get();
      localStorage.setItem(KEY, JSON.stringify({ hue, tint }));
    } catch {
      // applies for this page either way
    }
  }

  return {
    ...load(),
    setHue(v) {
      set({ hue: clamp(v, 0, 360) });
      apply();
      persist();
    },
    setTint(v) {
      set({ tint: clamp(v, 0, 100) });
      apply();
      persist();
    },
    init() {
      apply();
    },
    reset() {
      set({ ...DEFAULTS });
      apply();
      persist();
    },
  };
});

// Self-applying on import, like the Svelte original.
if (typeof document !== "undefined") backgroundStore.getState().init();

export const useBackground = <T>(sel: (s: BackgroundState) => T): T =>
  useStore(backgroundStore, sel);
