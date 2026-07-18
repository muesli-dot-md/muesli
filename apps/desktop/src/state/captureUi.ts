import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";

/**
 * Shared capture UI state, replacing the Svelte `$bindable`
 * captureStatus/capturePath/triggerStart props that TranscriptView shared with
 * AppShell. The shell reads `captureStatus`/`capturePath` for the recording
 * footer and to open the saved note after a palette-initiated stop;
 * `triggerStart()` is the signal the shell/toolbar/palette use to open the
 * transcript view and begin capture through TranscriptView's single
 * start-capture code path.
 *
 * Status values mirror the Svelte component exactly:
 * "idle" | "running" | "error".
 */
export type CaptureStatus = "idle" | "running" | "error";

export interface CaptureUiState {
  captureStatus: CaptureStatus;
  capturePath: string | null;
  error?: string;
  /**
   * Pending start request (the React equivalent of the Svelte `triggerStart`
   * bindable flag). Set by triggerStart(), consumed by TranscriptView.
   */
  startRequested: boolean;
  /** Ask TranscriptView to begin capture (it consumes the request on mount or
   *  as soon as it observes it). */
  triggerStart: () => void;
  /** Consume a pending start request. Returns true when one was pending. */
  consumeStartRequest: () => boolean;
  setStatus: (status: CaptureStatus, error?: string) => void;
  setCapturePath: (path: string | null) => void;
  /** Return to the idle state (shell calls this after finishing a capture). */
  reset: () => void;
}

export const captureUiStore = createStore<CaptureUiState>()((set, get) => ({
  captureStatus: "idle",
  capturePath: null,
  error: undefined,
  startRequested: false,

  triggerStart: () => set({ startRequested: true }),

  consumeStartRequest: () => {
    if (!get().startRequested) return false;
    set({ startRequested: false });
    return true;
  },

  setStatus: (captureStatus, error) => set({ captureStatus, error }),

  setCapturePath: (capturePath) => set({ capturePath }),

  reset: () =>
    set({
      captureStatus: "idle",
      capturePath: null,
      error: undefined,
      startRequested: false,
    }),
}));

export const useCaptureUi = <T,>(selector: (s: CaptureUiState) => T): T =>
  useStore(captureUiStore, selector);
