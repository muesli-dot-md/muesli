import { listen } from "@tauri-apps/api/event";
import type { TranscriptEvent } from "./types";

// EditorFrameEvent and onEditorFrame live in tauri.ts (canonical home for all
// Tauri IPC wrappers). Re-exported here for backward compatibility.
export type { EditorFrameEvent } from "./tauri.js";
export { onEditorFrame } from "./tauri.js";

type Store = {
  applyPartial: (e: TranscriptEvent) => void;
  applyFinal: (e: TranscriptEvent) => void;
};

/**
 * Subscribe to Tauri transcript events and route them into the store.
 * Returns a cleanup function that unlistens both subscriptions.
 */
export async function subscribeToTranscriptEvents(store: Store): Promise<() => void> {
  const unlistenPartial = await listen<TranscriptEvent>("transcript://partial", (event) => {
    store.applyPartial(event.payload);
  });

  const unlistenFinal = await listen<TranscriptEvent>("transcript://final", (event) => {
    store.applyFinal(event.payload);
  });

  return () => {
    unlistenPartial();
    unlistenFinal();
  };
}
