// The keychain-consent chokepoint (spec 2026-07-02 §3). On macOS the Rust-side
// gate starts CLOSED (lib.rs), so even a missed frontend path is prompt-free;
// this module is the ONLY place that opens it. Two entry points:
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
import { invoke } from "@tauri-apps/api/core";
import { settings } from "$lib/settings.svelte";
import { platform } from "$lib/platform.svelte";
import { consentDecision } from "$lib/keychainConsentGate";

class KeychainConsentStore {
  /** True while the explainer dialog should be on screen (AppShell renders from this). */
  asking = $state(false);

  /** Concurrent ensure() callers share one pending dialog/promise — no double dialogs. */
  private pending: Promise<boolean> | null = null;
  private resolvePending: ((granted: boolean) => void) | null = null;
  /** The keychain_consent(true) command is idempotent per session. */
  private gateOpenedThisSession = false;

  /**
   * Launch path (spec §3 launch row): silent always. True = the keyring may be
   * read (gate open, or non-mac where it never closed); false = skip the
   * keychain and render logged-out. Never raises the dialog.
   */
  async gateAtLaunch(): Promise<boolean> {
    await platform.init(); // await-safe; populates platform.macos
    if (consentDecision(platform.macos, settings.keychainConsent) === "ask") {
      // No consent yet: at launch that means skip — never ask (Decisions §3).
      return false;
    }
    return this.proceed();
  }

  /**
   * Sign-in chokepoint. Resolves true when the caller may proceed into code
   * that can touch the keyring; false means "abort quietly". May raise the
   * explainer dialog.
   */
  async ensure(): Promise<boolean> {
    // A dialog already up? Join it, whatever a fresh decision would say.
    if (this.pending) return this.pending;

    await platform.init(); // await-safe; populates platform.macos
    if (consentDecision(platform.macos, settings.keychainConsent) === "proceed") {
      return this.proceed();
    }

    // "ask": raise the dialog once and share the answer with every waiter.
    if (this.pending) return this.pending;
    this.asking = true;
    this.pending = new Promise<boolean>((resolve) => {
      this.resolvePending = resolve;
    });
    return this.pending;
  }

  /**
   * "proceed" resolution: off macOS the gate never closed — nothing to do. On
   * macOS "proceed" implies consent was granted on a previous run, so reopen
   * the process-state Rust gate silently (idempotent per session).
   */
  private proceed(): Promise<boolean> {
    return platform.macos ? this.openGate() : Promise.resolve(true);
  }

  /** The modal's Continue button. Persist first (spec §3 order), then open the gate. */
  async grant(): Promise<void> {
    settings.setKeychainConsent(true);
    const opened = await this.openGate();
    this.settle(opened);
  }

  /** The modal's "Not now" (or Escape). Persists nothing (spec §Decisions). */
  decline(): void {
    this.settle(false);
  }

  /** Open the Rust gate (idempotent per session). False = fail closed (spec §5). */
  private async openGate(): Promise<boolean> {
    if (this.gateOpenedThisSession) return true;
    try {
      await invoke("keychain_consent", { granted: true });
      this.gateOpenedThisSession = true;
      return true;
    } catch (e) {
      // Fail closed: the Rust gate stays shut, this session behaves logged-out.
      // Never an error dialog; nothing token-shaped exists here to log.
      console.warn("[keychain] consent command failed — treating as declined this session:", e);
      return false;
    }
  }

  private settle(granted: boolean): void {
    this.asking = false;
    const resolve = this.resolvePending;
    this.pending = null;
    this.resolvePending = null;
    resolve?.(granted);
  }
}

export const keychainConsent = new KeychainConsentStore();

/** Sign-in chokepoint (spec §3): the only dialog trigger. */
export function ensureKeychainConsent(): Promise<boolean> {
  return keychainConsent.ensure();
}

/** Launch path (spec §3): silent; false = skip the keychain, render logged-out. */
export function keychainGateAtLaunch(): Promise<boolean> {
  return keychainConsent.gateAtLaunch();
}
