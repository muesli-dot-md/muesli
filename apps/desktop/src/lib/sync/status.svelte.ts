// A tiny runes singleton carrying the active note's sync status, so EditorPane
// (which owns the session) can publish it and StatusBar can render it without
// prop-drilling the session itself. `null` = no sync session (sync disabled, or
// no note open).
import type { SyncStatus } from "./session";

class SyncStatusStore {
  status = $state<SyncStatus | null>(null);

  set(s: SyncStatus | null): void {
    this.status = s;
  }
}

export const syncStatus = new SyncStatusStore();
