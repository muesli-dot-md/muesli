// Webapp accent color (item 2). The shared arc palette ships periwinkle as the
// base --arc-primary, but the webapp defaults its ACCENT to a restrained neutral
// slate gray instead — decoupled from the desktop, which keeps periwinkle. The
// user can pick from a small set of presets in Settings → Appearance; the choice
// persists under "muesli:accent" and is applied by overriding --accent-primary /
// --accent-primary-content on the document root (app.css points
// --color-primary at those). Yjs-free, self-applying like theme.svelte.ts.

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
  /** Swatch + applied --color-primary (light). AA-checked on white (≥4.5:1). */
  light: string;
  lightContent: string;
  /** Applied --color-primary in dark mode (brighter so it reads on graphite). */
  dark: string;
  darkContent: string;
};

// Default is "gray": a neutral slate that meets WCAG AA on white for button
// labels and links. The periwinkle preset reuses the shared arc primary.
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

const KEY = "muesli:accent";
const byId = new Map<string, AccentPreset>(ACCENT_PRESETS.map((p) => [p.id, p]));

function storedAccent(): AccentId {
  let v: string | null = null;
  try {
    v = localStorage.getItem(KEY);
  } catch {
    // storage unavailable — default gray
  }
  return v && byId.has(v) ? (v as AccentId) : "gray";
}

let accent: AccentId = $state(storedAccent());

/** Push the preset's light + dark values onto the document root. app.css reads
 *  --accent-primary / --accent-primary-content (light) and the -dark variants. */
function apply() {
  const p = byId.get(accent) ?? ACCENT_PRESETS[0];
  const root = document.documentElement;
  root.style.setProperty("--accent-primary", p.light);
  root.style.setProperty("--accent-primary-content", p.lightContent);
  root.style.setProperty("--accent-primary-dark", p.dark);
  root.style.setProperty("--accent-primary-content-dark", p.darkContent);
}

apply();

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
};
