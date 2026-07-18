// Theme mode (light / dark / system), persisted under "muesli:theme" —
// React/zustand port of src/theme.svelte.ts (adapted from the desktop's
// state/theme.ts, minus the Tauri set_window_appearance invoke — the web has
// no native window). index.html runs the same resolution inline before first
// paint (no flash); this store takes over once the app boots: it applies mode
// changes live and follows the OS preference while in system mode. Yjs-free.
//
// Web keeps its own theme names: data-theme = "muesli" | "muesli-dark"
// (index.html pre-paint pins + app.css selectors key on them), and ALSO
// toggles the `.dark` class so shadcn token blocks keyed on `.dark` work
// (Stage-2 W0 decision).

import { createStore } from "zustand/vanilla";
import { useStore } from "zustand";

export type ThemeMode = "light" | "dark" | "system";
export type ResolvedTheme = "muesli" | "muesli-dark";

const KEY = "muesli:theme";

/** Pure function — safe to call in tests (no DOM access). */
export function resolveTheme(mode: ThemeMode, prefersDark: boolean): ResolvedTheme {
  if (mode === "light") return "muesli";
  if (mode === "dark") return "muesli-dark";
  return prefersDark ? "muesli-dark" : "muesli";
}

function storedMode(): ThemeMode {
  if (typeof localStorage === "undefined") return "system";
  let v: string | null = null;
  try {
    v = localStorage.getItem(KEY);
  } catch {
    // storage unavailable — system it is
  }
  return v === "light" || v === "dark" ? v : "system";
}

export interface ThemeState {
  mode: ThemeMode;
  setMode(m: ThemeMode): void;
  cycle(): void;
  /** Apply the persisted mode + install the OS-follow listener (idempotent). */
  init(): void;
}

// Non-reactive plumbing (module-level, mirrors the closure vars in the Svelte store).
let _mediaQuery: MediaQueryList | null = null;
let _listener: (() => void) | null = null;

const ORDER: ThemeMode[] = ["light", "dark", "system"];

function prefersDark(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-color-scheme: dark)").matches
    : false;
}

export const themeStore = createStore<ThemeState>()((set, get) => {
  function apply() {
    if (typeof document === "undefined") return;
    const resolved = resolveTheme(get().mode, prefersDark());
    document.documentElement.dataset.theme = resolved;
    // shadcn/Tailwind dark-mode tokens key on the .dark class; the web app.css
    // rules key on [data-theme] — keep both in lockstep.
    document.documentElement.classList.toggle("dark", resolved === "muesli-dark");
  }

  return {
    mode: storedMode(),
    setMode(m) {
      set({ mode: m });
      try {
        localStorage.setItem(KEY, m);
      } catch {
        // applies for this page either way
      }
      apply();
    },
    cycle() {
      const idx = ORDER.indexOf(get().mode);
      get().setMode(ORDER[(idx + 1) % ORDER.length]);
    },
    init() {
      apply();
      if (typeof window !== "undefined" && typeof window.matchMedia === "function") {
        // Idempotence guard: init() may be called again (HMR); don't stack listeners.
        if (_mediaQuery && _listener) _mediaQuery.removeEventListener("change", _listener);
        _mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
        _listener = () => {
          if (get().mode === "system") apply();
        };
        _mediaQuery.addEventListener("change", _listener);
      }
    },
  };
});

// Self-applying on import, like the Svelte original (App imported it for its
// side effect). init() stays callable/idempotent for explicit boot wiring.
if (typeof document !== "undefined") themeStore.getState().init();

export const useTheme = <T>(sel: (s: ThemeState) => T): T => useStore(themeStore, sel);
