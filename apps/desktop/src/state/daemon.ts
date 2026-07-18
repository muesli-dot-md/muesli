// The Tier-1 daemon's reactive status. Port of src/lib/sync/daemon.svelte.ts.
// `status` is populated ONCE on start() and not on a recurring timer, which
// keeps EditorPane's `daemonRunning = !!daemon.status?.running` value-stable
// (Plan 3's flicker fix). Structural changes arrive as pushed
// `workspace://structure` events and rebuild the sidebar tree via a debounced
// (150ms) refresh — content-only doc_updated events never refresh.

import { createStore } from "zustand/vanilla";
import { useStore } from "zustand";
import {
  startWorkspaceSync,
  stopWorkspaceSync,
  workspaceSyncStatus,
  onStructureEvent,
  type DaemonStatusView,
  type WorkspaceEventEnvelope,
} from "@/services/tauri";
import { workspaceStore } from "./workspace";

/** Event kinds that change the folder/document TREE (vs. doc_updated = content only). */
const STRUCTURAL_KINDS = new Set([
  "folder_created",
  "folder_renamed",
  "folder_moved",
  "folder_deleted",
  "doc_created",
  "doc_renamed",
  "doc_moved",
  "doc_deleted",
]);

export interface DaemonState {
  status: DaemonStatusView | null;
  start(server: string, path: string, workspaceId: string | null): Promise<void>;
  stop(): Promise<void>;
}

// Non-reactive plumbing (the Svelte class's #private fields).
let unlisten: (() => void) | null = null;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;

function onStructure(evt: WorkspaceEventEnvelope): void {
  // doc_updated is content-only — it never changes the tree, so don't refresh on it.
  if (!STRUCTURAL_KINDS.has(evt.kind)) return;
  scheduleRefresh();
}

/** Coalesce a burst of structural events into a single tree rebuild (~150ms). */
function scheduleRefresh(): void {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    workspaceStore
      .getState()
      .refresh()
      .catch(() => {});
  }, 150);
}

export const daemonStore = createStore<DaemonState>()((set) => ({
  status: null,

  async start(server, path, workspaceId) {
    await startWorkspaceSync(server, path, workspaceId);
    // One-shot status read to populate the value-stable `running` flag.
    try {
      set({ status: await workspaceSyncStatus() });
    } catch {
      // transient; leave status null and let a later start retry
    }
    // Replace any prior subscription (start() may switch workspaces).
    unlisten?.();
    unlisten = await onStructureEvent((evt) => onStructure(evt));
  },

  async stop() {
    unlisten?.();
    unlisten = null;
    if (refreshTimer) {
      clearTimeout(refreshTimer);
      refreshTimer = null;
    }
    await stopWorkspaceSync();
    set({ status: null });
  },
}));

export const useDaemon = <T>(sel: (s: DaemonState) => T): T => useStore(daemonStore, sel);
