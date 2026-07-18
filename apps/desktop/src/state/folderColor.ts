// User-adjustable color for folder icons in the file tree (Settings →
// Appearance → Folder color). Port of src/lib/folderColor.svelte.ts. Follows
// the exact same shape as background.ts's hue control: persist a single OKLCH
// hue (0–360) to localStorage and apply it as a CSS var (--folder-h) on <html>.
// Light/dark lightness and chroma stay theme-controlled (--folder-l /
// --folder-c in app.css).

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
  /** Apply the persisted hue to the DOM (call once on app start). */
  init(): void;
  reset(): void;
}

export const folderColorStore = createStore<FolderColorState>()((set, get) => {
  function apply() {
    if (typeof document === "undefined") return;
    document.documentElement.style.setProperty("--folder-h", String(get().hue));
  }

  function persist() {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(KEY, JSON.stringify({ hue: get().hue }));
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

export const useFolderColor = <T>(sel: (s: FolderColorState) => T): T =>
  useStore(folderColorStore, sel);
