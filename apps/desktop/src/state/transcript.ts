// Per-capture transcript store factory. Port of src/lib/transcript.svelte.ts
// as a zustand vanilla-store factory: TranscriptView creates one per capture.
//
// Reactivity note: `entries` is the reactive field (a Map REPLACED immutably on
// every partial/final). React components should subscribe to it —
//   const entries = useStore(store, (s) => s.entries);
//   const meLines = store.getState().lines("me");
// `lines(source)` itself returns a fresh array per call (same as the Svelte
// getter), so don't use it directly as a useStore selector.

import { createStore, type StoreApi } from "zustand/vanilla";
import type { TranscriptEvent, TranscriptLine } from "@/services/types";

interface LineEntry extends TranscriptLine {
  source: "me" | "them";
}

export interface TranscriptState {
  entries: Map<string, LineEntry>;
  applyPartial(e: TranscriptEvent): void;
  applyFinal(e: TranscriptEvent): void;
  lines(source: "me" | "them"): TranscriptLine[];
}

export type TranscriptStore = StoreApi<TranscriptState>;

export function createTranscriptStore(): TranscriptStore {
  return createStore<TranscriptState>()((set, get) => ({
    entries: new Map(),

    applyPartial(e) {
      const key = `${e.source}:${e.utteranceId}`;
      const updated = new Map(get().entries);
      updated.set(key, {
        text: e.text,
        final: false,
        utteranceId: e.utteranceId,
        t0: e.t0,
        source: e.source,
      });
      set({ entries: updated });
    },

    applyFinal(e) {
      const key = `${e.source}:${e.utteranceId}`;
      const updated = new Map(get().entries);
      updated.set(key, {
        text: e.text,
        final: true,
        utteranceId: e.utteranceId,
        t0: e.t0,
        source: e.source,
      });
      set({ entries: updated });
    },

    lines(source) {
      return [...get().entries.values()]
        .filter((l) => l.source === source)
        .sort((a, b) => a.utteranceId - b.utteranceId);
    },
  }));
}
