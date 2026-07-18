// Shared reactive context for the open document's collaboration state.
// Port of src/lib/collab/docCollab.svelte.ts.
//
// EditorPane owns the editor session (it alone knows the path, sync flags, and
// Yjs text); it publishes the open doc's `{ slug, isRemote, server }` here so
// the sibling RightSidebar panels can gate on `isRemote` and build a collabApi
// for `slug`. `store` is populated once the collab store is wired in — the
// Svelte-era direct assignment `docCollab.store = s` becomes `setStore(s)`.
//
// `isRemote` is true only for synced/workspace docs (the same condition that
// drives EditorPane's `useTauriSync || useWsSync`); local-only vault files keep
// it false and the panels render the empty state.

import { createStore } from "zustand/vanilla";
import { useStore } from "zustand";
import type { CollabStore } from "./collabStore";

export interface DocCollabState {
  slug: string | null;
  isRemote: boolean;
  server: string | null;
  /** The live collab store for the open synced doc (null for local-only docs). */
  store: CollabStore | null;

  /** Monotonic count of editor mounts that completed without wiring a collab
   * store (session attach or initial disk read failed). Watchers waiting for
   * `store` to materialize (ModeGroup's pending Suggesting intent) treat a
   * bump as "the store you were waiting on is not coming" and expire. Never
   * reset — consumers compare against a baseline captured when they begin
   * waiting, so an absolute value carries no meaning. */
  wireFailures: number;

  markWireFailed(): void;
  set(ctx: { slug: string | null; isRemote: boolean; server: string | null }): void;
  setStore(store: CollabStore | null): void;
  reset(): void;
}

export const docCollabStore = createStore<DocCollabState>()((set) => ({
  slug: null,
  isRemote: false,
  server: null,
  store: null,
  wireFailures: 0,

  markWireFailed() {
    set((s) => ({ wireFailures: s.wireFailures + 1 }));
  },
  set(ctx) {
    set({ slug: ctx.slug, isRemote: ctx.isRemote, server: ctx.server });
  },
  setStore(store) {
    set({ store });
  },
  reset() {
    // wireFailures deliberately NOT reset (see field doc).
    set({ slug: null, isRemote: false, server: null, store: null });
  },
}));

export const useDocCollab = <T>(sel: (s: DocCollabState) => T): T =>
  useStore(docCollabStore, sel);
