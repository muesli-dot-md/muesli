// User-adjustable color for folder icons (Settings → Preferences → Folder
// color) — React/zustand port of src/folderColor.svelte.ts (same shape and
// localStorage key as the desktop's state/folderColor.ts): persist a single
// OKLCH hue (0–360) and apply it as a CSS var (--folder-h) on <html>. Only hue
// is stored; the per-theme lightness/chroma (--folder-l / --folder-c in
// app.css) keep the chosen hue exactly as legible as the built-in accent in
// both themes. Yjs-free, self-applying on import like accent.ts.

import { createStore } from "zustand/vanilla";
import { useStore } from "zustand";

const KEY = "muesli:folderColor";
export const FOLDER_DEFAULT_HUE = 262; // matches --arc-accent's hue (shared/palette.css)

function clampHue(v: number): number {
  // Guard against corrupted localStorage (e.g. `{"hue":"blue"}` — a string,
  // not a number) or a missing/NaN value slipping past the `??` in load():
  // Math.round/min/max on a non-finite input silently produce NaN, which
  // would then get written to the DOM as `--folder-h: NaN`. Number.isFinite
  // does no type coercion, so this also catches non-numeric types directly.
  if (!Number.isFinite(v)) return FOLDER_DEFAULT_HUE;
  return Math.max(0, Math.min(360, Math.round(v)));
}

function load(): number {
  if (typeof localStorage === "undefined") return FOLDER_DEFAULT_HUE;
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return FOLDER_DEFAULT_HUE;
    const p = JSON.parse(raw);
    return clampHue(p.hue ?? FOLDER_DEFAULT_HUE);
  } catch {
    return FOLDER_DEFAULT_HUE;
  }
}

export interface FolderColorState {
  hue: number;
  setHue(v: number): void;
  /** Apply the persisted hue to the DOM (idempotent). */
  init(): void;
  reset(): void;
}

export const folderColorStore = createStore<FolderColorState>()((set, get) => {
  function apply() {
    if (typeof document === "undefined") return;
    document.documentElement.style.setProperty("--folder-h", String(get().hue));
  }

  function persist() {
    if (typeof localStorage === "undefined") return;
    try {
      localStorage.setItem(KEY, JSON.stringify({ hue: get().hue }));
    } catch {
      // applies for this page either way
    }
  }

  return {
    hue: load(),
    setHue(v) {
      set({ hue: clampHue(v) });
      apply();
      persist();
    },
    init() {
      apply();
    },
    reset() {
      set({ hue: FOLDER_DEFAULT_HUE });
      apply();
      persist();
    },
  };
});

// Self-applying on import, like the Svelte original.
if (typeof document !== "undefined") folderColorStore.getState().init();

export const useFolderColor = <T>(sel: (s: FolderColorState) => T): T =>
  useStore(folderColorStore, sel);
