// Desktop accent color — the webapp's accent.svelte.ts ported for parity (the
// ACCENT_PRESETS constants are IDENTICAL between apps; mirror any change). The
// one deliberate divergence: the desktop DEFAULTS to "periwinkle", whose values
// equal the shared --arc-primary tokens exactly, while the web defaults to its
// restrained "gray". The choice persists under "muesli:accent" and is applied by
// setting --accent-primary / --accent-primary-content (+ -dark variants) on the
// document root; app.css points each theme's --color-primary at those with the
// stock --arc-primary as fallback, so the default look is unchanged until the
// user picks something. Synced per-user via prefsSync (key "accent").

export type AccentId = "gray" | "periwinkle" | "blue" | "green" | "amber";

export type AccentPreset = {
  id: AccentId;
  /** i18n key for the label (the desktop is not localized — see ACCENT_LABELS). */
  labelKey:
    | "settings.accent.gray"
    | "settings.accent.periwinkle"
    | "settings.accent.blue"
    | "settings.accent.green"
    | "settings.accent.amber";
  /** Swatch + applied --color-primary (light). AA-checked on white (≥4.5:1). */
  light: string;
  lightContent: string;
  /** Applied --color-primary in dark mode (brighter so it reads on graphite). */
  dark: string;
  darkContent: string;
};

// Identical to apps/web/src/accent.svelte.ts. The periwinkle preset reuses the
// shared arc primary (shared/palette.css), which is why applying it changes
// nothing on a stock desktop theme.
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
    light: "oklch(0.54 0.16 259.5)",
    lightContent: "oklch(0.99 0.01 259)",
    dark: "oklch(0.74 0.12 259.5)",
    darkContent: "oklch(0.18 0.04 259)",
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

/** English labels for the preset ids — the same strings the web's en locale
 *  holds under each preset's labelKey (the desktop app is not localized). */
export const ACCENT_LABELS: Record<AccentId, string> = {
  gray: "Gray",
  periwinkle: "Periwinkle",
  blue: "Blue",
  green: "Green",
  amber: "Amber",
};

const KEY = "muesli:accent";
const DEFAULT_ACCENT: AccentId = "periwinkle";
const byId = new Map<string, AccentPreset>(ACCENT_PRESETS.map((p) => [p.id, p]));

function storedAccent(): AccentId {
  if (typeof localStorage === "undefined") return DEFAULT_ACCENT;
  let v: string | null = null;
  try {
    v = localStorage.getItem(KEY);
  } catch {
    // storage unavailable — default periwinkle
  }
  return v && byId.has(v) ? (v as AccentId) : DEFAULT_ACCENT;
}

let accent: AccentId = $state(storedAccent());

/** Push the preset's light + dark values onto the document root. app.css reads
 *  --accent-primary / --accent-primary-content (light) and the -dark variants. */
function apply() {
  if (typeof document === "undefined") return;
  const p = byId.get(accent) ?? ACCENT_PRESETS[0];
  const root = document.documentElement;
  root.style.setProperty("--accent-primary", p.light);
  root.style.setProperty("--accent-primary-content", p.lightContent);
  root.style.setProperty("--accent-primary-dark", p.dark);
  root.style.setProperty("--accent-primary-content-dark", p.darkContent);
}

export const accentStore = {
  get id(): AccentId {
    return accent;
  },
  set id(next: AccentId) {
    accent = next;
    try {
      localStorage.setItem(KEY, next);
    } catch {
      // applies for this page either way
    }
    apply();
  },
  /** Apply the persisted accent to the DOM (call once on app start). */
  init() {
    apply();
  },
};
