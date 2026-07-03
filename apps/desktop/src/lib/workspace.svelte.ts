import { SvelteSet } from "svelte/reactivity";
import { readWorkspaceTree, addRecentWorkspace, listRecentWorkspaces } from "$lib/tauri";
import type { WorkspaceNode, RecentWorkspace } from "$lib/tauri";
import { tabs } from "$lib/tabs.svelte";
import { editorState } from "$lib/editorState.svelte";

class WorkspaceStore {
  root = $state<string | null>(null);
  tree = $state<WorkspaceNode | null>(null);
  recents = $state<RecentWorkspace[]>([]);
  // SvelteSet (not $state(new Set())): plain $state does NOT make Set's
  // add/delete/has reactive, so TreeNode's `$derived(expandedPaths.has(path))`
  // would never update on toggle. SvelteSet makes those methods reactive.
  expandedPaths = new SvelteSet<string>();
  sortMode = $state<'name-asc' | 'name-desc'>('name-asc');

  cycleSort() {
    this.sortMode = this.sortMode === 'name-asc' ? 'name-desc' : 'name-asc';
  }

  collapseAll() {
    this.expandedPaths.clear();
  }

  async openWorkspace(path: string): Promise<void> {
    // Close all tabs from the previous workspace so their sessions/views tear down
    // and flush any pending edits before we switch root.
    const snapshot = [...tabs.tabs];
    for (const tab of snapshot) {
      tabs.close(tab.id);
    }
    editorState.currentText = '';

    const [tree, recents] = await Promise.all([
      readWorkspaceTree(path),
      addRecentWorkspace(path),
    ]);
    this.root = path;
    this.tree = tree;
    this.recents = recents;
  }

  async refresh(): Promise<void> {
    if (!this.root) return;
    this.tree = await readWorkspaceTree(this.root);
  }

  async loadRecents(): Promise<void> {
    this.recents = await listRecentWorkspaces();
  }
}

export const workspace = new WorkspaceStore();
