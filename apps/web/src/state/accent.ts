// Webapp accent color — React/zustand port of src/accent.svelte.ts (adapted
// from the desktop's state/accent.ts; the ACCENT_PRESETS constants are
// IDENTICAL between apps — mirror any change). The shared arc palette ships the
// brand blue as the base --arc-primary, but the WEBAPP defaults its accent to a
// restrained neutral slate gray (the desktop defaults to "blue"). The user can
// pick from a small set of presets in Settings → Preferences; the choice
// persists under "muesli:accent" and is applied by overriding --accent-primary
// / --accent-primary-content (+ -dark variants) on the document root (app.css
// points --color-primary at those). Yjs-free, self-applying on import like
// theme.ts. Synced per-user via prefsSync (key "accent").
// The Svelte `accentStore.id = next` property setter becomes `setId(next)`.

import { createStore } from "zustand/vanilla";
import { useStore } from "zustand";

export type AccentId = "gray" | "periwinkle" | "blue" | "green" | "amber";

export type AccentPreset = {
  id: AccentId;
  /** i18n key for the label. */
  labelKey:
    | "settings.accent.gray"
    | "settings.accent.periwinkle"
    | "settings.accent.blue"
    | "settings.accent.green"
    | "settings.accent.amber";
  /** Swatch + applied --color-primary (light). Contrast-checked on white:
   * every preset clears 4.5:1 except amber, the ramp's one compromise at
   * ~4.4:1 (large-text/UI-component AA only). */
  light: string;
  lightContent: string;
  /** Applied --color-primary in dark mode (brighter so it reads on graphite). */
  dark: string;
  darkContent: string;
};

// Default is "gray": a neutral slate that meets WCAG AA on white for button
// labels and links. The blue preset reuses the shared arc primary; periwinkle
// keeps the pre-brand-blue primary values as a selectable choice.
export const ACCENT_PRESETS: readonly AccentPreset[] = [
  {
    id: "gray",
    labelKey: "settings.accent.gray",
    light: "oklch(0.44 0.012 285)",
    lightContent: "oklch(0.98 0.005 285)",
    dark: "oklch(0.72 0.012 285)",
    darkContent: "oklch(0.18 0.006 285)",
  },
  {
    id: "periwinkle",
    labelKey: "settings.accent.periwinkle",
    light: "oklch(0.585 0.22 277)",
    lightContent: "oklch(0.98 0.01 285)",
    dark: "oklch(0.70 0.15 280)",
    darkContent: "oklch(0.16 0.02 285)",
  },
  {
    id: "blue",
    labelKey: "settings.accent.blue",
    light: "oklch(0.546 0.215 262.9)",
    lightContent: "oklch(0.98 0.01 262)",
    dark: "oklch(0.714 0.143 254.6)",
    darkContent: "oklch(0.16 0.02 262)",
  },
  {
    id: "green",
    labelKey: "settings.accent.green",
    light: "oklch(0.52 0.13 150)",
    lightContent: "oklch(0.99 0.02 150)",
    dark: "oklch(0.72 0.14 150)",
    darkContent: "oklch(0.16 0.04 150)",
  },
  {
    id: "amber",
    labelKey: "settings.accent.amber",
    light: "oklch(0.58 0.13 70)",
    lightContent: "oklch(0.99 0.02 80)",
    dark: "oklch(0.78 0.14 75)",
    darkContent: "oklch(0.2 0.05 70)",
  },
];

/** English fallback labels by preset id (parity with the desktop export).
 *  Web UI should prefer `t(preset.labelKey)` — the web app is localized. */
export const ACCENT_LABELS: Record<AccentId, string> = {
  gray: "Gray",
  periwinkle: "Periwinkle",
  blue: "Blue",
  green: "Green",
  amber: "Amber",
};

const KEY = "muesli:accent";
const DEFAULT_ACCENT: AccentId = "gray";
const byId = new Map<string, AccentPreset>(ACCENT_PRESETS.map((p) => [p.id, p]));

function storedAccent(): AccentId {
  if (typeof localStorage === "undefined") return DEFAULT_ACCENT;
  let v: string | null = null;
  try {
    v = localStorage.getItem(KEY);
  } catch {
    // storage unavailable — default gray
  }
  return v && byId.has(v) ? (v as AccentId) : DEFAULT_ACCENT;
}

export interface AccentState {
  id: AccentId;
  setId(next: AccentId): void;
  /** Apply the persisted accent to the DOM (idempotent). */
  init(): void;
}

export const accentStore = createStore<AccentState>()((set, get) => {
  /** Push the preset's light + dark values onto the document root. app.css reads
   *  --accent-primary / --accent-primary-content (light) and the -dark variants. */
  function apply() {
    if (typeof document === "undefined") return;
    const p = byId.get(get().id) ?? ACCENT_PRESETS[0];
    const root = document.documentElement;
    root.style.setProperty("--accent-primary", p.light);
    root.style.setProperty("--accent-primary-content", p.lightContent);
    root.style.setProperty("--accent-primary-dark", p.dark);
    root.style.setProperty("--accent-primary-content-dark", p.darkContent);
  }

  return {
    id: storedAccent(),
    setId(next) {
      set({ id: next });
      try {
        localStorage.setItem(KEY, next);
      } catch {
        // applies for this page either way
      }
      apply();
    },
    init() {
      apply();
    },
  };
});

// Self-applying on import, like the Svelte original.
if (typeof document !== "undefined") accentStore.getState().init();

export const useAccent = <T>(sel: (s: AccentState) => T): T => useStore(accentStore, sel);
