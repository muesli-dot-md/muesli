import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";

export interface WorkspaceNode {
  name: string;
  path: string;
  isDir: boolean;
  children?: WorkspaceNode[];
}

export interface RecentWorkspace {
  name: string;
  path: string;
  lastOpened: number;
}

export interface SearchHit {
  path: string;
  display: string;
  name: string;
  nameMatch: boolean;
  snippet: string | null;
  line: number | null;
  matches: number;
}

/** A note in the link graph (mirrors Rust `workspace::graph::GraphNode`). */
export interface GraphNode {
  /** Absolute path — the id the frontend opens on click. */
  id: string;
  /** Slug of the basename (resolution key, shared with wikilink targets). */
  slug: string;
  /** Display label (basename without `.md`). */
  title: string;
  /** Count of resolved outgoing wikilinks. */
  linksOut: number;
  /** Count of resolved incoming wikilinks. */
  linksIn: number;
}

/** A resolved edge between two notes, by node id (mirrors Rust `GraphEdge`). */
export interface GraphEdge {
  src: string;
  dst: string;
}

/** An unresolved `[[Target]]` (mirrors Rust `UnresolvedLink`). */
export interface UnresolvedLink {
  src: string;
  rawTarget: string;
}

/** The full link-graph payload (mirrors Rust `LinkGraph`). */
export interface LinkGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  unresolved: UnresolvedLink[];
}

// Workspace commands
export const readWorkspaceTree = (root: string): Promise<WorkspaceNode> =>
  invoke("read_workspace_tree", { root });

export const searchWorkspace = (root: string, query: string): Promise<SearchHit[]> =>
  invoke("search_workspace", { root, query });

/** Scan the workspace's `.md` files for `[[wikilinks]]` -> graph node/edge set. */
export const buildLinkGraph = (root: string): Promise<LinkGraph> =>
  invoke("build_link_graph", { root });

export const readNote = (path: string): Promise<string> => invoke("read_note", { path });

export const writeNote = (path: string, contents: string): Promise<void> =>
  invoke("write_note", { path, contents });

/** Write an export (e.g. HTML) to an absolute `path` chosen via the save dialog. */
export const writeExportFile = (path: string, contents: string): Promise<void> =>
  invoke("write_export_file", { path, contents });

/** Write `contents` to a temp `<name>.html` and open it in the default browser
 *  (the "Export → PDF" path — the browser prints where the webview can't). */
export const printExport = (name: string, contents: string): Promise<void> =>
  invoke("print_export", { name, contents });

export const createNote = (dir: string, name: string): Promise<string> =>
  invoke("create_note", { dir, name });

export const createFolder = (dir: string, name: string): Promise<string> =>
  invoke("create_folder", { dir, name });

export const renamePath = (path: string, newName: string): Promise<string> =>
  invoke("rename_path", { path, newName });

export const movePath = (src: string, destDir: string): Promise<string> =>
  invoke("move_path", { src, destDir });

export const deletePath = (path: string): Promise<void> => invoke("delete_path", { path });

/** Basic filesystem metadata for the "File information" context-menu action. */
export interface PathInfo {
  path: string;
  name: string;
  isDir: boolean;
  /** Bytes — for a folder, the recursive total of its `.md` files. */
  size: number;
  /** Last-modified time (Unix millis), or null if unavailable. */
  modifiedMs: number | null;
  /** Created time (Unix millis), or null if unavailable. */
  createdMs: number | null;
  /** For a folder: number of immediate `.md` files; null for a file. */
  childCount: number | null;
}

export const statPath = (path: string): Promise<PathInfo> => invoke("stat_path", { path });

// Recent-workspace commands
export const listRecentWorkspaces = (): Promise<RecentWorkspace[]> =>
  invoke("list_recent_workspaces");

export const addRecentWorkspace = (path: string): Promise<RecentWorkspace[]> =>
  invoke("add_recent_workspace", { path });

export const setLastWorkspace = (path: string): Promise<void> =>
  invoke("set_last_workspace", { path });

export const getLastWorkspace = (): Promise<string | null> => invoke("get_last_workspace");

// Folder picker
export const pickFolder = async (): Promise<string | null> => {
  const result = await open({ directory: true });
  if (result === null || result === undefined) return null;
  if (Array.isArray(result)) return result[0] ?? null;
  return result;
};

export interface Identity {
  server: string;
  /** Stable user id (server UUID) — the presence dedup/color key shared with the
   *  webapp so the same person is one indicator across web + desktop. */
  id: string | null;
  display_name: string | null;
  email: string | null;
  avatar_url: string | null;
  mode: "open" | "oidc";
  /** users.onboarded_at from GET /api/me — null/undefined = never onboarded. */
  onboarded_at: string | null;
}

/**
 * True when `identity` represents an actual signed-in account, not an
 * open-mode server's identity-less placeholder. Some OIDC providers only ever
 * expose the "sub" claim, so an identity can have `email` and `display_name`
 * both null and still be signed in — `mode === "oidc"` alone counts. Used by
 * ProfileSection (the primary account UI). NOTE: this is a UI predicate, NOT
 * the sync gate — sync keys off `workspaces.identity` being non-null AND the
 * open workspace being server-linked (`workspaces.activeLinked`). The two
 * deliberately diverge on open-mode servers: their identity placeholder is
 * non-null (sync can run) while isSignedIn stays false (no account to show).
 */
export function isSignedIn(identity: Identity | null | undefined): boolean {
  return !!identity && (!!identity.email || !!identity.display_name || identity.mode === "oidc");
}

export type WorkspaceState = "local-only" | "cloud-only" | "cloned";

export interface WorkspaceView {
  id: string;
  server: string | null;
  name: string;
  local_path: string | null;
  local_only: boolean;
  state: WorkspaceState;
}

export const serverLogin = (server: string): Promise<Identity> =>
  invoke("server_login", { server });
export const serverLogout = (server: string): Promise<void> => invoke("server_logout", { server });
export const currentIdentity = (server: string): Promise<Identity | null> =>
  invoke("current_identity", { server });
/** Cheap local check (no network): is a token stored for this server? */
export const hasToken = (server: string): Promise<boolean> => invoke("has_token", { server });

export const listWorkspacesMerged = (server: string | null): Promise<WorkspaceView[]> =>
  invoke("list_workspaces_merged", { server });
export const registerLocalWorkspace = (id: string, name: string, path: string): Promise<void> =>
  invoke("register_local_workspace", { id, name, path });
export const setWorkspacePath = (id: string, path: string): Promise<void> =>
  invoke("set_workspace_path", { id, path });
/** Mark a server workspace as cloned to `path` (upserts the full record). */
export const registerClonedWorkspace = (
  id: string,
  server: string,
  name: string,
  path: string,
): Promise<void> => invoke("register_cloned_workspace", { id, server, name, path });

/** Mirror of Rust `muesli_cli::api::WorkspaceInfo` (the server workspace shape). */
export interface WorkspaceInfo {
  id: string;
  name: string;
  role: string;
  is_personal: boolean;
}

/** Create an empty server workspace named `name` on `server`. */
export const createRemoteWorkspace = (server: string, name: string): Promise<WorkspaceInfo> =>
  invoke("create_remote_workspace", { server, name });

/**
 * Promote a local-only workspace (`oldId` = its folder path) to a shared one on `server`:
 * creates the server workspace, swaps the registry row, returns the new server workspace id.
 */
export const promoteWorkspace = (
  oldId: string,
  server: string,
  name: string,
  path: string,
): Promise<string> => invoke("promote_workspace", { oldId, server, name, path });

export interface DaemonStatusView {
  running: boolean;
  dir: string | null;
  files: number;
  last_activity: string | null;
  events: number;
  error: string | null;
}

export const cloneWorkspace = (
  server: string,
  workspaceId: string,
  path: string,
): Promise<number> => invoke("clone_workspace", { server, workspaceId, path });

/** Create `<parent>/<workspace name>` (sanitized, collision-suffixed) and return it —
 *  the folder picker chooses the parent; the workspace always gets its own folder. */
export const prepareCloneDir = (parent: string, name: string): Promise<string> =>
  invoke("prepare_clone_dir", { parent, name });

/** Move a cloned workspace's folder under a new parent dir; rewrites the link
 *  index and registry. Returns the new root path. Same-volume moves only. */
export const relocateWorkspace = (
  id: string,
  oldPath: string,
  newParent: string,
): Promise<string> => invoke("relocate_workspace", { id, oldPath, newParent });

export const startWorkspaceSync = (
  server: string,
  path: string,
  workspaceId: string | null,
): Promise<void> => invoke("start_workspace_sync", { server, path, workspaceId });

export const stopWorkspaceSync = (): Promise<void> => invoke("stop_workspace_sync");

export const workspaceSyncStatus = (): Promise<DaemonStatusView> => invoke("workspace_sync_status");

// ─── Tier-2 editor bridge commands (Plan 3) ──────────────────────────────────

/** Attach the editor for `path` to the daemon's CRDT replica (Tier-2 IPC). */
/** Attach the editor bridge for `path`. Resolves with whether the bridge is LIVE (a
 *  linked, already-synced session that will answer with a snapshot); `false` means the
 *  editor should seed from disk immediately rather than wait on a silent bridge. */
export const attachEditor = (path: string): Promise<boolean> => invoke("attach_editor", { path });

/** Detach the editor for `path` from the daemon's replica. */
export const detachEditor = (path: string): Promise<void> => invoke("detach_editor", { path });

/** Send one y-protocols frame from the JS provider into the daemon for `path`. */
export const sendEditorFrame = (path: string, frame: number[]): Promise<void> =>
  invoke("send_editor_frame", { path, frame });

/** Payload of an `editor://frame` event (matches Rust `FramePayload`). */
export interface EditorFrameEvent {
  path: string;
  /** One opaque y-protocols frame as a byte array. */
  frame: number[];
}

/**
 * Subscribe to `editor://frame` events from the Tauri backend.
 * Calls `handler` with each incoming frame payload.
 * Returns a cleanup function that removes the listener.
 */
export async function onEditorFrame(handler: (evt: EditorFrameEvent) => void): Promise<() => void> {
  const unlisten = await listen<EditorFrameEvent>("editor://frame", (event) => {
    handler(event.payload);
  });
  return unlisten;
}

// ─── Structure-event stream (Plan 4): daemon → frontend sidebar refresh ──────

/** Mirror of Rust `muesli_core::events::WorkspaceEvent` (serde tag = "kind", snake_case). */
export type WorkspaceEvent =
  | { kind: "folder_created"; id: string; parent_id: string | null; name: string }
  | { kind: "folder_renamed"; id: string; name: string }
  | { kind: "folder_moved"; id: string; parent_id: string | null }
  | { kind: "folder_deleted"; id: string }
  | { kind: "doc_created"; slug: string; folder_id: string | null; title: string | null }
  | { kind: "doc_renamed"; slug: string; title: string | null }
  | { kind: "doc_moved"; slug: string; folder_id: string | null }
  | { kind: "doc_deleted"; slug: string }
  | { kind: "doc_updated"; slug: string };

/**
 * Mirror of Rust `WorkspaceEventEnvelope`: the event (flattened) plus the optional
 * origin client-id that caused it. `origin` is null for UI/unknown-origin events.
 */
export type WorkspaceEventEnvelope = WorkspaceEvent & { origin?: string | null };

/**
 * Subscribe to `workspace://structure` events from the Tauri backend.
 * Calls `handler` with each incoming envelope. Returns a cleanup function that
 * removes the listener. Mirrors `onEditorFrame`.
 */
export async function onStructureEvent(
  handler: (evt: WorkspaceEventEnvelope) => void,
): Promise<() => void> {
  const unlisten = await listen<WorkspaceEventEnvelope>("workspace://structure", (event) => {
    handler(event.payload);
  });
  return unlisten;
}
