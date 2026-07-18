// The active note's sync status. Port of src/lib/sync/status.svelte.ts.
// EditorPane (which owns the session) publishes it; readers render it without
// prop-drilling the session itself. `null` = no sync session (sync disabled,
// or no note open).

import { createStore } from "zustand/vanilla";
import { useStore } from "zustand";
import type { SyncStatus } from "@/services/sync/session";

export interface SyncStatusState {
  status: SyncStatus | null;
  set(s: SyncStatus | null): void;
}

export const syncStatusStore = createStore<SyncStatusState>()((set) => ({
  status: null,
  set: (s) => set({ status: s }),
}));

export const useSyncStatus = <T>(sel: (s: SyncStatusState) => T): T =>
  useStore(syncStatusStore, sel);
