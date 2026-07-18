// Open-workspace store (root + tree + recents + expand/sort UI state).
// Port of src/lib/workspace.svelte.ts. The Svelte SvelteSet `expandedPaths` is
// a plain Set<string> here, REPLACED immutably on every change so subscribers
// (TreeNode's `expandedPaths.has(path)`) re-render; mutate it only through the
// expand/collapse/toggleExpanded actions.

import { createStore } from "zustand/vanilla";
import { useStore } from "zustand";
import { readWorkspaceTree, addRecentWorkspace, listRecentWorkspaces } from "@/services/tauri";
import type { WorkspaceNode, RecentWorkspace } from "@/services/tauri";
import { tabsStore } from "./tabs";
import { editorStateStore } from "./editorState";

export type SortMode = "name-asc" | "name-desc";

export interface WorkspaceState {
  root: string | null;
  tree: WorkspaceNode | null;
  recents: RecentWorkspace[];
  expandedPaths: ReadonlySet<string>;
  sortMode: SortMode;

  cycleSort(): void;
  collapseAll(): void;
  /** SvelteSet-mutation replacements (expandedPaths.add/delete in the Svelte app). */
  expand(path: string): void;
  collapse(path: string): void;
  toggleExpanded(path: string): void;

  openWorkspace(path: string): Promise<void>;
  refresh(): Promise<void>;
  loadRecents(): Promise<void>;
}

export const workspaceStore = createStore<WorkspaceState>()((set, get) => ({
  root: null,
  tree: null,
  recents: [],
  expandedPaths: new Set<string>(),
  sortMode: "name-asc",

  cycleSort() {
    set({ sortMode: get().sortMode === "name-asc" ? "name-desc" : "name-asc" });
  },

  collapseAll() {
    set({ expandedPaths: new Set() });
  },

  expand(path) {
    const prev = get().expandedPaths;
    if (prev.has(path)) return;
    const next = new Set(prev);
    next.add(path);
    set({ expandedPaths: next });
  },

  collapse(path) {
    const prev = get().expandedPaths;
    if (!prev.has(path)) return;
    const next = new Set(prev);
    next.delete(path);
    set({ expandedPaths: next });
  },

  toggleExpanded(path) {
    const prev = get().expandedPaths;
    const next = new Set(prev);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    set({ expandedPaths: next });
  },

  async openWorkspace(path) {
    // Close all tabs from the previous workspace so their sessions/views tear down
    // and flush any pending edits before we switch root.
    const tabs = tabsStore.getState();
    const snapshot = [...tabs.tabs];
    for (const tab of snapshot) {
      tabs.close(tab.id);
    }
    editorStateStore.getState().setCurrentText("");

    const [tree, recents] = await Promise.all([readWorkspaceTree(path), addRecentWorkspace(path)]);
    set({ root: path, tree, recents });
  },

  async refresh() {
    const root = get().root;
    if (!root) return;
    const tree = await readWorkspaceTree(root);
    set({ tree });
  },

  async loadRecents() {
    set({ recents: await listRecentWorkspaces() });
  },
}));

export const useWorkspace = <T>(sel: (s: WorkspaceState) => T): T => useStore(workspaceStore, sel);
