export interface KeymapCallbacks {
  openPalette: () => void;
  openSwitcher: () => void;
  openSearch: () => void;
  newNote: () => void;
  closeModal: () => void;
  toggleReading: () => void;
  toggleRightSidebar: () => void;
}

/** The overlay layers AppShell's Escape fallback can see, top-most first. */
export interface EscapeLayers {
  signIn: boolean;
  keychainConsent: boolean;
  onboarding: boolean;
  search: boolean;
  palette: boolean;
  switcher: boolean;
  settings: boolean;
  picker: boolean;
}

export type EscapeTarget = Exclude<
  keyof EscapeLayers,
  "onboarding" | "keychainConsent" | "signIn"
> | null;

/**
 * Decide which layer (if any) the window-level Escape fallback should
 * dismiss. Onboarding is a STATE guard, not a dismissal target: while the
 * onboarding overlay is up, the fallback must do nothing at all —
 * OnboardingFlow's own svelte:window handler performs the skip (it has its
 * own double-fire guard). We cannot rely on that handler having already
 * called preventDefault() when the fallback runs: window keydown listeners
 * fire in REGISTRATION order, and the keymap installs in AppShell's onMount
 * long before OnboardingFlow mounts, so the fallback usually sees the event
 * FIRST. Without this guard it would also dismiss whatever the app opened
 * beneath the overlay (e.g. the workspace picker opened by the
 * no-last-workspace fallback), stranding a first-launch user in an empty
 * shell.
 */
export function escapeFallbackTarget(layers: EscapeLayers): EscapeTarget {
  if (layers.signIn) return null;
  if (layers.keychainConsent) return null;
  if (layers.onboarding) return null;
  if (layers.search) return "search";
  if (layers.palette) return "palette";
  if (layers.switcher) return "switcher";
  if (layers.settings) return "settings";
  if (layers.picker) return "picker";
  return null;
}

/**
 * Install a window-level keydown handler.
 * Returns a cleanup function to remove the handler.
 */
export function installKeymap(callbacks: KeymapCallbacks): () => void {
  function handleKeydown(e: KeyboardEvent) {
    const mod = e.metaKey || e.ctrlKey;

    if (mod && e.key === "p") {
      e.preventDefault();
      callbacks.openPalette();
      return;
    }

    if (mod && e.key === "o") {
      e.preventDefault();
      callbacks.openSwitcher();
      return;
    }

    // ⌘K / Ctrl-K — open the search palette (no Alt/Shift modifiers).
    if (mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k") {
      e.preventDefault();
      callbacks.openSearch();
      return;
    }

    if (mod && e.key === "n") {
      e.preventDefault();
      callbacks.newNote();
      return;
    }

    if (mod && e.key === "e") {
      e.preventDefault();
      callbacks.toggleReading();
      return;
    }

    // ⌘⌥→ — toggle right sidebar
    if (mod && e.altKey && e.key === "ArrowRight") {
      e.preventDefault();
      callbacks.toggleRightSidebar();
      return;
    }

    if (e.key === "Escape") {
      // Only call closeModal if no modal is handling it internally
      // (modals handle Escape themselves, but this is a fallback).
      // Belt-and-braces: a listener that ran BEFORE this one and already
      // handled Escape signals it via preventDefault() — stand down. This
      // only helps for listeners registered before the keymap; overlays that
      // mount later (like OnboardingFlow) are covered by the state guard in
      // escapeFallbackTarget instead.
      if (e.defaultPrevented) return;
      callbacks.closeModal();
    }
  }

  window.addEventListener("keydown", handleKeydown);
  return () => window.removeEventListener("keydown", handleKeydown);
}
