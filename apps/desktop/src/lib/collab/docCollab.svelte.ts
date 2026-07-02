// Shared reactive context for the open document's collaboration state.
//
// EditorPane owns the editor session (it alone knows the path, sync flags, and
// Yjs text); it publishes the open doc's `{ slug, isRemote, server }` here so
// the sibling RightSidebar panels can gate on `isRemote` and build a collabApi
// for `slug`. `store` is populated once the collab store (Task 5) is wired in.
//
// `isRemote` is true only for synced/workspace docs (the same condition that
// drives EditorPane's `useTauriSync || useWsSync`); local-only vault files keep
// it false and the panels render the empty state.

import type { CollabStore } from "./collabStore.svelte";

class DocCollabStore {
  slug = $state<string | null>(null);
  isRemote = $state(false);
  server = $state<string | null>(null);
  /** The live collab store for the open synced doc (null for local-only docs). */
  store = $state<CollabStore | null>(null);

  set(ctx: { slug: string | null; isRemote: boolean; server: string | null }): void {
    this.slug = ctx.slug;
    this.isRemote = ctx.isRemote;
    this.server = ctx.server;
  }

  reset(): void {
    this.slug = null;
    this.isRemote = false;
    this.server = null;
    this.store = null;
  }
}

export const docCollab = new DocCollabStore();
