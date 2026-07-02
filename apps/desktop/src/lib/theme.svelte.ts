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

function createThemeStore() {
  let mode = $state<ThemeMode>("system");
  let _mediaQuery: MediaQueryList | null = null;
  let _listener: ((e: MediaQueryListEvent) => void) | null = null;

  function _apply() {
    if (typeof document === "undefined") return;
    const prefersDark =
      typeof window !== "undefined"
        ? window.matchMedia("(prefers-color-scheme: dark)").matches
        : false;
    document.documentElement.dataset.theme = resolveTheme(mode, prefersDark);
    // Keep the native window vibrancy in sync with the in-app theme. Pass the
    // mode verbatim: 'light'/'dark' pin the NSAppearance, 'system' clears the
    // override so the window follows the OS.
    syncWindowAppearance(mode);
  }

  function setMode(m: ThemeMode) {
    mode = m;
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(STORAGE_KEY, m);
    }
    _apply();
  }

  function init() {
    if (typeof localStorage === "undefined" || typeof document === "undefined") return;

    // Load persisted mode
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "light" || stored === "dark" || stored === "system") {
      mode = stored;
    }

    // Apply immediately
    _apply();

    // Install live OS-follow listener for system mode
    if (typeof window !== "undefined") {
      _mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
      _listener = () => {
        if (mode === "system") _apply();
      };
      _mediaQuery.addEventListener("change", _listener);
    }
  }

  const ORDER: ThemeMode[] = ["light", "dark", "system"];
  function cycle() {
    const idx = ORDER.indexOf(mode);
    setMode(ORDER[(idx + 1) % ORDER.length]);
  }

  return {
    get mode() {
      return mode;
    },
    setMode,
    cycle,
    init,
  };
}

export const theme = createThemeStore();
