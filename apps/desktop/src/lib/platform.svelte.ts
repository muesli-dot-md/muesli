// Single source of truth for platform facts. Transcription is macOS-only
// (ScreenCaptureKit system audio + the bundled Parakeet model), so every
// transcription affordance in the UI is gated on `platform.transcription`.
// `macos` reports the OS itself for the keychain-consent flow (spec
// 2026-07-02): the consent explainer only exists on macOS.
//
// Both flags come from Rust cfg!(target_os = "macos") commands
// (`transcription_supported`, `platform_is_macos`), fetched once via `init()`.
// Until `init()` resolves both are `false`. That is fail-closed for feature
// gating (hide rather than flash), and still safe for keychain consent: a
// falsely-false `macos` on a real Mac cannot cause an OS prompt, because the
// Rust-side keychain gate is closed at startup on macOS — any keyring path is
// skipped until the `keychain_consent` command opens it.
import { invoke } from "@tauri-apps/api/core";

function createPlatform() {
  let transcription = $state(false);
  let macos = $state(false);
  let initPromise: Promise<void> | null = null;

  /**
   * Query the backend once for platform facts and cache them. Idempotent AND
   * await-safe: concurrent callers share one promise, so `await init()` never
   * resolves before the values are actually populated (a plain boolean latch
   * would let a second caller race ahead of the first's in-flight invoke).
   * If the commands are missing or error (e.g. a browser dev context with no
   * Tauri host) both flags stay `false`.
   */
  function init(): Promise<void> {
    if (!initPromise) {
      initPromise = (async () => {
        try {
          transcription = await invoke<boolean>("transcription_supported");
          macos = await invoke<boolean>("platform_is_macos");
        } catch {
          // No Tauri host / command unavailable — keep everything hidden/false.
          transcription = false;
          macos = false;
        }
      })();
    }
    return initPromise;
  }

  return {
    /** Whether live transcription is available on this platform (macOS only). */
    get transcription() {
      return transcription;
    },
    /** Whether the app runs on macOS (gates the keychain-consent explainer). */
    get macos() {
      return macos;
    },
    init,
  };
}

export const platform = createPlatform();
