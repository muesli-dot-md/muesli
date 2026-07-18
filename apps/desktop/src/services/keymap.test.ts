// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import {
  escapeFallbackTarget,
  installKeymap,
  type EscapeLayers,
  type KeymapCallbacks,
} from "./keymap";

function makeCallbacks(overrides: Partial<KeymapCallbacks> = {}): KeymapCallbacks {
  return {
    openPalette: vi.fn(),
    openSwitcher: vi.fn(),
    openSearch: vi.fn(),
    newNote: vi.fn(),
    closeModal: vi.fn(),
    toggleReading: vi.fn(),
    toggleRightSidebar: vi.fn(),
    ...overrides,
  };
}

const layers = (overrides: Partial<EscapeLayers> = {}): EscapeLayers => ({
  signIn: false,
  keychainConsent: false,
  onboarding: false,
  search: false,
  palette: false,
  switcher: false,
  settings: false,
  picker: false,
  ...overrides,
});

describe("escapeFallbackTarget (the state guard AppShell's closeModal uses)", () => {
  it("onboarding on screen: dismisses NOTHING beneath it — not the picker, not settings", () => {
    // The first-launch case: the no-last-workspace fallback opened the picker
    // beneath the onboarding overlay. Escape must skip onboarding only (via
    // OnboardingFlow's own handler), never also close the picker/settings —
    // otherwise a first-launch user lands in an empty shell.
    expect(escapeFallbackTarget(layers({ onboarding: true, picker: true }))).toBeNull();
    expect(escapeFallbackTarget(layers({ onboarding: true, settings: true }))).toBeNull();
    expect(
      escapeFallbackTarget(layers({ onboarding: true, search: true, picker: true })),
    ).toBeNull();
    expect(escapeFallbackTarget(layers({ onboarding: true }))).toBeNull();
  });

  it("keychain consent on screen: dismisses NOTHING beneath it — the modal's own handler declines", () => {
    // Same rationale as onboarding: the keymap installs long before the modal
    // mounts, so the fallback sees Escape first; without the guard it would
    // also dismiss whatever is open beneath the consent overlay.
    expect(escapeFallbackTarget(layers({ keychainConsent: true, picker: true }))).toBeNull();
    expect(escapeFallbackTarget(layers({ keychainConsent: true, search: true }))).toBeNull();
    expect(escapeFallbackTarget(layers({ keychainConsent: true }))).toBeNull();
  });

  it("keychain consent + onboarding both flagged: still null — locks the layer priority", () => {
    // Locks the layer priority when both self-handling overlays are flagged:
    // each component's own svelte:window handler performs its dismissal; the
    // guard's job is only to keep the keymap fallback silent.
    expect(escapeFallbackTarget(layers({ keychainConsent: true, onboarding: true }))).toBeNull();
  });

  it("sign-in dialog on screen: dismisses NOTHING beneath it — the modal's own handler cancels", () => {
    // Same rationale as keychain consent: the keymap installs in AppShell's
    // onMount long before SignInModal mounts, so the fallback sees Escape
    // first; without the guard it would also dismiss whatever is open beneath
    // the sign-in overlay (e.g. the workspace picker).
    expect(escapeFallbackTarget(layers({ signIn: true, picker: true }))).toBeNull();
    expect(escapeFallbackTarget(layers({ signIn: true, search: true }))).toBeNull();
    expect(escapeFallbackTarget(layers({ signIn: true }))).toBeNull();
  });

  it("sign-in + keychain consent + onboarding all flagged: still null — locks the layer priority", () => {
    // The three self-handling overlays can never actually stack (confirm
    // closes the sign-in dialog BEFORE login() can raise the consent modal),
    // but the guard must stay silent whichever combination is flagged.
    expect(
      escapeFallbackTarget(layers({ signIn: true, keychainConsent: true, onboarding: true })),
    ).toBeNull();
  });

  it("without onboarding, dismisses the top-most open layer in order", () => {
    expect(escapeFallbackTarget(layers({ search: true, picker: true }))).toBe("search");
    expect(escapeFallbackTarget(layers({ palette: true, settings: true }))).toBe("palette");
    expect(escapeFallbackTarget(layers({ switcher: true }))).toBe("switcher");
    expect(escapeFallbackTarget(layers({ settings: true, picker: true }))).toBe("settings");
    expect(escapeFallbackTarget(layers({ picker: true }))).toBe("picker");
    expect(escapeFallbackTarget(layers())).toBeNull();
  });
});

describe("installKeymap Escape fallback", () => {
  it("calls closeModal on a plain Escape (no listener handled it first)", () => {
    const callbacks = makeCallbacks();
    const remove = installKeymap(callbacks);
    try {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      expect(callbacks.closeModal).toHaveBeenCalledTimes(1);
    } finally {
      remove();
    }
  });

  it("stands down when an EARLIER-registered listener already called preventDefault", () => {
    // Belt-and-braces only: window keydown listeners fire in registration
    // order, so this covers listeners registered BEFORE the keymap. Overlays
    // that mount later (OnboardingFlow's svelte:window handler) fire AFTER
    // the keymap and cannot be seen via defaultPrevented — those are covered
    // by the escapeFallbackTarget state guard above, not this check.
    const earlierHandler = (e: KeyboardEvent) => {
      e.preventDefault();
    };
    window.addEventListener("keydown", earlierHandler);
    const callbacks = makeCallbacks();
    const remove = installKeymap(callbacks);
    try {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
      expect(callbacks.closeModal).not.toHaveBeenCalled();
    } finally {
      remove();
      window.removeEventListener("keydown", earlierHandler);
    }
  });
});
