import {
  startWorkspaceSync,
  stopWorkspaceSync,
  workspaceSyncStatus,
  onStructureEvent,
  type DaemonStatusView,
  type WorkspaceEventEnvelope,
} from "$lib/tauri";
import { workspace } from "$lib/workspace.svelte";

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

/**
 * The Tier-1 daemon's reactive status. `status` is populated ONCE on start() and not on a
 * recurring timer, which keeps EditorPane's `daemonRunning = $derived(!!daemon.status?.running)`
 * value-stable (Plan 3's flicker fix). Structural changes arrive as pushed
 * `workspace://structure` events and rebuild the sidebar tree via a debounced refresh.
 */
class DaemonStore {
  status = $state<DaemonStatusView | null>(null);
  #unlisten: (() => void) | null = null;
  #refreshTimer: ReturnType<typeof setTimeout> | null = null;

  async start(server: string, path: string, workspaceId: string | null): Promise<void> {
    await startWorkspaceSync(server, path, workspaceId);
    // One-shot status read to populate the StatusBar and the value-stable `running` flag.
    try {
      this.status = await workspaceSyncStatus();
    } catch {
      // transient; leave status null and let a later start retry
    }
    // Replace any prior subscription (start() may switch workspaces).
    this.#unlisten?.();
    this.#unlisten = await onStructureEvent((evt) => this.#onStructure(evt));
  }

  async stop(): Promise<void> {
    this.#unlisten?.();
    this.#unlisten = null;
    if (this.#refreshTimer) {
      clearTimeout(this.#refreshTimer);
      this.#refreshTimer = null;
    }
    await stopWorkspaceSync();
    this.status = null;
  }

  #onStructure(evt: WorkspaceEventEnvelope): void {
    // doc_updated is content-only — it never changes the tree, so don't refresh on it.
    if (!STRUCTURAL_KINDS.has(evt.kind)) return;
    this.#scheduleRefresh();
  }

  /** Coalesce a burst of structural events into a single tree rebuild (~150ms). */
  #scheduleRefresh(): void {
    if (this.#refreshTimer) clearTimeout(this.#refreshTimer);
    this.#refreshTimer = setTimeout(() => {
      this.#refreshTimer = null;
      workspace.refresh().catch(() => {});
    }, 150);
  }
}

export const daemon = new DaemonStore();
