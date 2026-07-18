// Single source of truth for platform facts. Port of src/lib/platform.svelte.ts.
// Transcription is macOS-only (ScreenCaptureKit system audio + the bundled
// Parakeet model), so every transcription affordance in the UI is gated on
// `platform.transcription`. `macos` reports the OS itself for the
// keychain-consent flow: the consent explainer only exists on macOS.
//
// Both flags come from Rust cfg!(target_os = "macos") commands
// (`transcription_supported`, `platform_is_macos`), fetched once via `init()`.
// Until `init()` resolves both are `false` (fail-closed).

import { createStore } from "zustand/vanilla";
import { useStore } from "zustand";
import { invoke } from "@tauri-apps/api/core";

export interface PlatformState {
  /** Whether live transcription is available on this platform (macOS only). */
  transcription: boolean;
  /** Whether the app runs on macOS (gates the keychain-consent explainer). */
  macos: boolean;
  init(): Promise<void>;
}

// Shared in-flight promise (module-level, non-reactive).
let initPromise: Promise<void> | null = null;

export const platformStore = createStore<PlatformState>()((set) => ({
  transcription: false,
  macos: false,

  /**
   * Query the backend once for platform facts and cache them. Idempotent AND
   * await-safe: concurrent callers share one promise, so `await init()` never
   * resolves before the values are actually populated (a plain boolean latch
   * would let a second caller race ahead of the first's in-flight invoke).
   * If the commands are missing or error (e.g. a browser dev context with no
   * Tauri host) both flags stay `false`.
   */
  init(): Promise<void> {
    if (!initPromise) {
      initPromise = (async () => {
        try {
          const transcription = await invoke<boolean>("transcription_supported");
          const macos = await invoke<boolean>("platform_is_macos");
          set({ transcription, macos });
        } catch {
          // No Tauri host / command unavailable — keep everything hidden/false.
          set({ transcription: false, macos: false });
        }
      })();
    }
    return initPromise;
  },
}));

export const usePlatform = <T>(sel: (s: PlatformState) => T): T => useStore(platformStore, sel);
