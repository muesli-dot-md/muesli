// The keychain-consent chokepoint (spec 2026-07-02 §3). Port of
// src/lib/keychainConsent.svelte.ts. On macOS the Rust-side gate starts CLOSED
// (lib.rs), so even a missed frontend path is prompt-free; this module is the
// ONLY place that opens it. Two entry points:
//
// - keychainGateAtLaunch(): the workspaces.refresh() startup path. NEVER shows
//   a dialog (spec Decisions §3 — a local-only user never sees it). Consent
//   granted on a previous run → reopen the process-state gate silently (once
//   per session) and proceed exactly as before this feature (auto-login from
//   the stored token). Not granted → false: skip the keychain, render
//   logged-out, no OS prompt.
// - ensureKeychainConsent(): user-initiated sign-in (the Sign-in button,
//   onboarding's "Connect to a server" fork). The only dialog trigger.
//   Declining persists nothing and simply re-asks at the next sign-in.
//
// Fail closed everywhere: if the keychain_consent command errors, we act as
// declined for this session.

import { createStore } from "zustand/vanilla";
import { useStore } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { consentDecision } from "@/services/keychainConsentGate";
import { settingsStore } from "./settings";
import { platformStore } from "./platform";

export interface KeychainConsentState {
  /** True while the explainer dialog should be on screen (AppShell renders from this). */
  asking: boolean;
  gateAtLaunch(): Promise<boolean>;
  ensure(): Promise<boolean>;
  grant(): Promise<void>;
  decline(): void;
}

// Non-reactive plumbing (module-level; the Svelte class's private fields).
/** Concurrent ensure() callers share one pending dialog/promise — no double dialogs. */
let pending: Promise<boolean> | null = null;
let resolvePending: ((granted: boolean) => void) | null = null;
/** The keychain_consent(true) command is idempotent per session. */
let gateOpenedThisSession = false;

/** Open the Rust gate (idempotent per session). False = fail closed (spec §5). */
async function openGate(): Promise<boolean> {
  if (gateOpenedThisSession) return true;
  try {
    await invoke("keychain_consent", { granted: true });
    gateOpenedThisSession = true;
    return true;
  } catch (e) {
    // Fail closed: the Rust gate stays shut, this session behaves logged-out.
    // Never an error dialog; nothing token-shaped exists here to log.
    console.warn("[keychain] consent command failed — treating as declined this session:", e);
    return false;
  }
}

/**
 * "proceed" resolution: off macOS the gate never closed — nothing to do. On
 * macOS "proceed" implies consent was granted on a previous run, so reopen
 * the process-state Rust gate silently (idempotent per session).
 */
function proceed(): Promise<boolean> {
  return platformStore.getState().macos ? openGate() : Promise.resolve(true);
}

export const keychainConsentStore = createStore<KeychainConsentState>()((set) => {
  function settle(granted: boolean): void {
    set({ asking: false });
    const resolve = resolvePending;
    pending = null;
    resolvePending = null;
    resolve?.(granted);
  }

  return {
    asking: false,

    /**
     * Launch path (spec §3 launch row): silent always. True = the keyring may be
     * read (gate open, or non-mac where it never closed); false = skip the
     * keychain and render logged-out. Never raises the dialog.
     */
    async gateAtLaunch(): Promise<boolean> {
      await platformStore.getState().init(); // await-safe; populates platform.macos
      const { macos } = platformStore.getState();
      if (consentDecision(macos, settingsStore.getState().keychainConsent) === "ask") {
        // No consent yet: at launch that means skip — never ask (Decisions §3).
        return false;
      }
      return proceed();
    },

    /**
     * Sign-in chokepoint. Resolves true when the caller may proceed into code
     * that can touch the keyring; false means "abort quietly". May raise the
     * explainer dialog.
     */
    async ensure(): Promise<boolean> {
      // A dialog already up? Join it, whatever a fresh decision would say.
      if (pending) return pending;

      await platformStore.getState().init(); // await-safe; populates platform.macos
      const { macos } = platformStore.getState();
      if (consentDecision(macos, settingsStore.getState().keychainConsent) === "proceed") {
        return proceed();
      }

      // "ask": raise the dialog once and share the answer with every waiter.
      if (pending) return pending;
      set({ asking: true });
      pending = new Promise<boolean>((resolve) => {
        resolvePending = resolve;
      });
      return pending;
    },

    /** The modal's Continue button. Persist first (spec §3 order), then open the gate. */
    async grant(): Promise<void> {
      settingsStore.getState().setKeychainConsent(true);
      const opened = await openGate();
      settle(opened);
    },

    /** The modal's "Not now" (or Escape). Persists nothing (spec §Decisions). */
    decline(): void {
      settle(false);
    },
  };
});

export const useKeychainConsent = <T>(sel: (s: KeychainConsentState) => T): T =>
  useStore(keychainConsentStore, sel);

/** Sign-in chokepoint (spec §3): the only dialog trigger. */
export function ensureKeychainConsent(): Promise<boolean> {
  return keychainConsentStore.getState().ensure();
}

/** Launch path (spec §3): silent; false = skip the keychain, render logged-out. */
export function keychainGateAtLaunch(): Promise<boolean> {
  return keychainConsentStore.getState().gateAtLaunch();
}
