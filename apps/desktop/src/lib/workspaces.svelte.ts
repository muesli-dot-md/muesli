import {
  currentIdentity,
  serverLogin,
  serverLogout,
  hasToken,
  listWorkspacesMerged,
  registerLocalWorkspace,
  registerClonedWorkspace,
  cloneWorkspace,
  relocateWorkspace as relocateWorkspaceCmd,
  promoteWorkspace as promoteWorkspaceCmd,
  statPath,
  type Identity,
  type WorkspaceView,
} from "$lib/tauri";
import { settings } from "$lib/settings.svelte";
import { workspace } from "$lib/workspace.svelte";
import { daemon } from "$lib/sync/daemon.svelte";
import { ensureKeychainConsent, keychainGateAtLaunch } from "$lib/keychainConsent.svelte";

class WorkspacesStore {
  identity = $state<Identity | null>(null);
  list = $state<WorkspaceView[]>([]);
  loading = $state(false);
  error = $state<string | null>(null);
  cloning = $state(false);
  busy = $state(false);

  /** The active server URL, mirroring the existing Settings field. */
  get activeServer(): string {
    return settings.wsBase;
  }

  /**
   * True when the OPEN folder (workspace.root) is a server-linked workspace:
   * its registry row carries a non-null `server` — the exact field
   * openFolderWithSync keys the daemon on. Local-only rows
   * (registerLocalWorkspace stores no server) and unregistered bare-folder
   * opens (openByPath's fallback) have none and stay false. This is the
   * workspace half of the sync gate (identity is the other half); EditorPane
   * must never route a local-only workspace onto a sync path.
   *
   * A $derived boolean, NOT a getter: `list` is reassigned wholesale on every
   * refresh(), so a getter read inside EditorPane's mount effect would remount
   * the editor per refresh — the derived only propagates when the value flips.
   */
  activeLinked = $derived.by(() => {
    const root = workspace.root;
    if (!root) return false;
    // Trailing-slash tolerance mirrors relocateWorkspace's path compare.
    const norm = (p: string) => p.replace(/\/+$/, "");
    const view = this.list.find((v) => v.local_path != null && norm(v.local_path) === norm(root));
    return !!view?.server;
  });

  async refresh(): Promise<void> {
    this.loading = true;
    this.error = null;
    try {
      // Silent keychain gating (spec 2026-07-02 §3 launch row): refresh() also
      // runs at startup, where the has_token read is the worst-case macOS
      // Keychain prompt trigger — so this NEVER shows a dialog. Consent granted
      // on a previous run → the gate reopens silently and the stored token
      // signs us in exactly as before this feature. No consent → skip the
      // keychain entirely and render the logged-out list; the explainer only
      // ever appears from a user-initiated sign-in (login()).
      const gateOpen = await keychainGateAtLaunch();
      // Identity + the server workspace list are gated on whether we're logged
      // in (a token exists) — the identity half of the sync gate (sync is
      // active iff signed in AND the open workspace is server-linked; there is
      // no user toggle). `has_token` is a local Keychain check (no network),
      // so a never-logged-in launch makes zero server calls.
      if (gateOpen && (await hasToken(this.activeServer))) {
        this.identity = await currentIdentity(this.activeServer).catch(() => null);
        this.list = await listWorkspacesMerged(this.activeServer);
      } else {
        this.identity = null;
        this.list = await listWorkspacesMerged(null);
      }
    } catch (e) {
      this.error = String(e);
    } finally {
      this.loading = false;
    }
  }

  async login(): Promise<void> {
    this.error = null;
    // Keychain consent chokepoint (spec 2026-07-02 §3): sign-in reads and
    // stores the Keychain token, so consent comes first — this is the ONLY
    // path that can raise the explainer. On decline, abort quietly: no error,
    // the surface stays usable, and the dialog re-appears at the next sign-in.
    if (!(await ensureKeychainConsent())) return;
    try {
      // The gate may have JUST opened: a token stored before this feature
      // existed (or by another install) is readable now — re-check before
      // launching a browser device flow the user doesn't need (spec §3).
      // A stale/invalid token falls through to the normal device flow.
      if (await hasToken(this.activeServer)) {
        const existing = await currentIdentity(this.activeServer).catch(() => null);
        if (existing) {
          this.identity = existing;
          await this.refresh();
          return;
        }
      }
      this.identity = await serverLogin(this.activeServer);
      await this.refresh();
    } catch (e) {
      this.error = String(e);
    }
  }

  async logout(): Promise<void> {
    try {
      await serverLogout(this.activeServer);
    } catch (e) {
      this.error = String(e);
    }
    // identity nulls BEFORE the daemon stops: daemon.stop() flushes an effect
    // pass with daemonRunning=false while a stale identity would still satisfy
    // the legacy-sync gate, mounting (then instantly tearing down) a spurious
    // unauthenticated websocket session on every sign-out.
    this.identity = null;
    await daemon.stop();
    await this.refresh();
  }

  /** Open an existing local folder as a local-only workspace (registers it). */
  async openLocalFolder(path: string, name: string): Promise<void> {
    await registerLocalWorkspace(path, name, path); // id = path for local-only
    await daemon.stop();
    await workspace.openWorkspace(path);
    await this.refresh();
  }

  /**
   * Open a workspace from the picker.
   * - cloud-only → clone into `chosenPath`, register as cloned, start the daemon, open.
   * - cloned / local-with-server → open, start the daemon for content sync.
   * - local-only (no server) → open, no daemon (solo offline editing).
   */
  async openWorkspaceView(view: WorkspaceView, chosenPath?: string): Promise<void> {
    this.error = null;
    // cloud-only: clone first, into the folder the user picked.
    if (!view.local_path && chosenPath && view.server) {
      this.cloning = true;
      try {
        await cloneWorkspace(view.server, view.id, chosenPath);
        await registerClonedWorkspace(view.id, view.server, view.name, chosenPath);
      } catch (e) {
        this.error = String(e);
        this.cloning = false;
        return;
      }
      this.cloning = false;
      await this.openFolderWithSync(chosenPath, view.server, view.id);
      await this.refresh();
      return;
    }
    // Already-local (cloned or local-only).
    if (view.local_path) {
      await this.openFolderWithSync(view.local_path, view.server, view.id);
    }
  }

  /**
   * Finish a wizard-created workspace: register the (already-created, already-
   * storage-bound) server workspace as cloned to `path`, open the folder, start
   * the Tier-1 daemon. The wizard (CreateWorkspaceModal) owns the server-side
   * creation now; this is only the local tail.
   */
  async finishRemoteWorkspace(workspaceId: string, name: string, path: string): Promise<void> {
    if (!this.activeServer) return;
    this.error = null;
    this.busy = true;
    try {
      await registerClonedWorkspace(workspaceId, this.activeServer, name, path);
      await this.openFolderWithSync(path, this.activeServer, workspaceId);
      await this.refresh();
    } catch (e) {
      this.error = String(e);
    } finally {
      this.busy = false;
    }
  }

  /**
   * Move a cloned workspace's folder somewhere else (mistake recovery): the
   * picker chooses the new PARENT; the folder keeps its name (suffixed past a
   * collision). Stops the daemon only when the moved workspace is the open one,
   * then reopens it at the new location.
   */
  async relocateWorkspace(view: WorkspaceView, newParent: string): Promise<void> {
    if (!view.local_path) return;
    this.error = null;
    this.busy = true;
    try {
      const norm = (p: string) => p.replace(/\/+$/, "");
      let wasActive = workspace.root != null && norm(workspace.root) === norm(view.local_path);
      if (wasActive) await daemon.stop();
      const newPath = await relocateWorkspaceCmd(view.id, view.local_path, newParent);
      if (!wasActive && workspace.root) {
        // The string compare can miss the open workspace when the two sides
        // spell the same folder differently (symlinked prefix, stale recents
        // entry). If the open root vanished with the move, it WAS this
        // workspace — reopen it at its new home instead of leaving the tree
        // pointed at a folder that no longer exists.
        wasActive = await statPath(workspace.root).then(
          () => false,
          () => true,
        );
        if (wasActive) await daemon.stop();
      }
      if (wasActive) await this.openFolderWithSync(newPath, view.server, view.id);
      await this.refresh();
    } catch (e) {
      this.error = String(e);
    } finally {
      this.busy = false;
    }
  }

  /**
   * Promote a LOCAL-ONLY workspace to a shared one: create the server workspace, swap the
   * registry row (local-only id=path → cloned id=W), then open the SAME folder and go live.
   * Requires a logged-in active server and a local path. Reuses the `busy` flag.
   */
  async promoteLocalToRemote(view: WorkspaceView): Promise<void> {
    if (!this.identity || !this.activeServer || !view.local_path) return;
    this.error = null;
    this.busy = true;
    try {
      const id = await promoteWorkspaceCmd(view.id, this.activeServer, view.name, view.local_path);
      await this.openFolderWithSync(view.local_path, this.activeServer, id);
      await this.refresh();
    } catch (e) {
      this.error = String(e);
    } finally {
      this.busy = false;
    }
  }

  /** Restore a workspace by its folder path on startup: refresh the list, find the
   *  matching view, and open it through the daemon-aware path. Returns false if no
   *  registered workspace matches (caller falls back to a bare folder open). */
  async openByPath(path: string): Promise<boolean> {
    await this.refresh();
    const view = this.list.find((v) => v.local_path === path);
    if (!view) return false;
    await this.openWorkspaceView(view);
    return true;
  }

  /** Open a folder in the tree and, when it has a server, (re)start the Tier-1 daemon. */
  private async openFolderWithSync(
    path: string,
    server: string | null,
    workspaceId: string | null,
  ): Promise<void> {
    await workspace.openWorkspace(path);
    if (server) {
      await daemon.start(server, path, workspaceId); // start() stops any prior daemon
    } else {
      await daemon.stop();
    }
  }
}

export const workspaces = new WorkspacesStore();
