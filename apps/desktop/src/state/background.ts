// User-adjustable window background (the translucent floor over the macOS
// vibrancy). Port of src/lib/background.svelte.ts. Persists to localStorage and
// drives the CSS vars --floor-a / --floor-h / --floor-c (composed into
// --floor-tint in app.css). --floor-l (lightness) stays theme-controlled so the
// tint adapts to light/dark.
// Svelte property setters become setTranslucency/setHue/setTint actions.

import { createStore } from "zustand/vanilla";
import { useStore } from "zustand";

const KEY = "muesli:background";
const MAX_CHROMA = 0.05; // tint=100 → this much chroma

const DEFAULTS = { translucency: 70, hue: 244, tint: 36 };

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

export interface BackgroundState {
  /** 0 = opaque, 100 = fully clear */
  translucency: number;
  /** 0–360 */
  hue: number;
  /** 0 = neutral gray, 100 = max chroma */
  tint: number;
  setTranslucency(v: number): void;
  setHue(v: number): void;
  setTint(v: number): void;
  /** Apply persisted values to the DOM (call once on app start). */
  init(): void;
  reset(): void;
}

export const backgroundStore = createStore<BackgroundState>()((set, get) => {
  function apply() {
    if (typeof document === "undefined") return;
    const { translucency, hue, tint } = get();
    const el = document.documentElement;
    el.style.setProperty("--floor-a", ((100 - translucency) / 100).toFixed(3));
    el.style.setProperty("--floor-h", String(hue));
    el.style.setProperty("--floor-c", ((tint / 100) * MAX_CHROMA).toFixed(4));
  }

  function persist() {
    if (typeof localStorage !== "undefined") {
      const { translucency, hue, tint } = get();
      localStorage.setItem(KEY, JSON.stringify({ translucency, hue, tint }));
    }
  }

  return {
    ...load(),
    setTranslucency(v) {
      set({ translucency: clamp(v, 0, 100) });
      apply();
      persist();
    },
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

export const useBackground = <T>(sel: (s: BackgroundState) => T): T =>
  useStore(backgroundStore, sel);
