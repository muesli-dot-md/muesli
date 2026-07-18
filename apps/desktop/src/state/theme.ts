// Theme mode store. Port of src/lib/theme.svelte.ts, plus the React design
// decision (migration plan, BINDING): applying a theme sets BOTH
//   - document.documentElement.dataset.theme = "arc-light" | "arc-dark"
//     (ported app.css / palette.css rules key on [data-theme]) AND
//   - document.documentElement.classList.toggle("dark", isDark)
//     (shadcn tokens key on the .dark class).

import { createStore } from "zustand/vanilla";
import { useStore } from "zustand";
import { invoke } from "@tauri-apps/api/core";

export type ThemeMode = "light" | "dark" | "system";
export type ResolvedTheme = "arc-light" | "arc-dark";

const STORAGE_KEY = "muesli:theme";

/**
 * Tell the native shell to set the window's NSAppearance so macOS window
 * vibrancy (the translucent background) follows the in-app theme instead of the
 * system one. For `'system'` mode we pass `'system'`, which clears the native
 * override so the window tracks the OS again. No-op on non-macOS / non-Tauri
 * (browser dev) hosts — the command is unavailable there, so we swallow errors.
 */
function syncWindowAppearance(mode: ThemeMode) {
  void invoke("set_window_appearance", { theme: mode }).catch(() => {
    // No Tauri host / command unavailable — nothing to do.
  });
}

/** Pure function — safe to call in tests (no DOM access). */
export function resolveTheme(mode: ThemeMode, prefersDark: boolean): ResolvedTheme {
  if (mode === "light") return "arc-light";
  if (mode === "dark") return "arc-dark";
  return prefersDark ? "arc-dark" : "arc-light";
}

export interface ThemeState {
  mode: ThemeMode;
  setMode(m: ThemeMode): void;
  cycle(): void;
  init(): void;
}

// Non-reactive plumbing (module-level, mirrors the closure vars in the Svelte store).
let _mediaQuery: MediaQueryList | null = null;
let _listener: ((e: MediaQueryListEvent) => void) | null = null;

const ORDER: ThemeMode[] = ["light", "dark", "system"];

export const themeStore = createStore<ThemeState>()((set, get) => {
  function apply() {
    if (typeof document === "undefined") return;
    const prefersDark =
      typeof window !== "undefined"
        ? window.matchMedia("(prefers-color-scheme: dark)").matches
        : false;
    const resolved = resolveTheme(get().mode, prefersDark);
    document.documentElement.dataset.theme = resolved;
    // shadcn/Tailwind dark-mode tokens key on the .dark class; the ported
    // app.css rules key on [data-theme] — keep both in lockstep.
    document.documentElement.classList.toggle("dark", resolved === "arc-dark");
    // Keep the native window vibrancy in sync with the in-app theme. Pass the
    // mode verbatim: 'light'/'dark' pin the NSAppearance, 'system' clears the
    // override so the window follows the OS.
    syncWindowAppearance(get().mode);
  }

  return {
    mode: "system",
    setMode(m) {
      set({ mode: m });
      if (typeof localStorage !== "undefined") {
        localStorage.setItem(STORAGE_KEY, m);
      }
      apply();
    },
    cycle() {
      const idx = ORDER.indexOf(get().mode);
      get().setMode(ORDER[(idx + 1) % ORDER.length]);
    },
    init() {
      if (typeof localStorage === "undefined" || typeof document === "undefined") return;

      // Load persisted mode
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored === "light" || stored === "dark" || stored === "system") {
        set({ mode: stored });
      }

      // Apply immediately
      apply();

      // Install live OS-follow listener for system mode
      if (typeof window !== "undefined") {
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

export const useTheme = <T>(sel: (s: ThemeState) => T): T => useStore(themeStore, sel);
