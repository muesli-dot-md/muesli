// User-adjustable color for folder icons in the file tree (Settings →
// Appearance → Folder color) — web port of the desktop's
// apps/desktop/src/lib/folderColor.svelte.ts, same shape and localStorage key:
// persist a single OKLCH hue (0–360) and apply it as a CSS var (--folder-h) on
// <html>. Only hue is stored; the per-theme lightness/chroma (--folder-l /
// --folder-c in app.css) keep the chosen hue exactly as legible as the built-in
// accent in both themes. Yjs-free, self-applying like accent.svelte.ts.

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
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return FOLDER_DEFAULT_HUE;
    const p = JSON.parse(raw);
    return clampHue(p.hue ?? FOLDER_DEFAULT_HUE);
  } catch {
    return FOLDER_DEFAULT_HUE;
  }
}

let hue = $state(load());

function apply() {
  document.documentElement.style.setProperty("--folder-h", String(hue));
}

function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify({ hue }));
  } catch {
    // applies for this page either way
  }
}

apply();

export const folderColor = {
  get hue(): number {
    return hue;
  },
  set hue(v: number) {
    hue = clampHue(v);
    apply();
    persist();
  },
  reset() {
    hue = FOLDER_DEFAULT_HUE;
    apply();
    persist();
  },
};
