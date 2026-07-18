// Open-tabs store. Port of src/lib/tabs.svelte.ts. The Svelte factory's `tabs`
// getter is the `tabs` state field here; everything else keeps its name.
// flushCallbacks stays a module-level plain Map — NOT reactive state.

import { createStore } from "zustand/vanilla";
import { useStore } from "zustand";

export interface Tab {
  id: string;
  path: string;
  name: string;
  dirty: boolean;
  mode: "edit" | "read";
}

export interface TabsState {
  tabs: Tab[];
  activeId: string | null;
  open(path: string, name: string): void;
  close(id: string): void;
  activate(id: string): void;
  setDirty(id: string, dirty: boolean): void;
  setMode(id: string, mode: "edit" | "read"): void;
  toggleMode(id: string): void;
  active(): Tab | null;
  registerFlush(id: string, fn: () => void | Promise<void>): void;
  unregisterFlush(id: string): void;
  flush(path: string): Promise<void>;
  retarget(oldPath: string, newPath: string): void;
}

// Plain Map — NOT reactive state
const flushCallbacks = new Map<string, () => void | Promise<void>>();

export const tabsStore = createStore<TabsState>()((set, get) => ({
  tabs: [],
  activeId: null,

  open(path, name) {
    const existing = get().tabs.find((t) => t.id === path);
    if (existing) {
      set({ activeId: path });
      return;
    }
    const tab: Tab = { id: path, path, name, dirty: false, mode: "edit" };
    set({ tabs: [...get().tabs, tab], activeId: path });
  },

  close(id) {
    const { tabs, activeId } = get();
    const idx = tabs.findIndex((t) => t.id === id);
    if (idx === -1) return;

    // Invoke flush callback if registered
    const flush = flushCallbacks.get(id);
    if (flush) flush();

    const newOpen = tabs.filter((t) => t.id !== id);

    let newActiveId: string | null = activeId;
    if (activeId === id) {
      if (newOpen.length === 0) {
        newActiveId = null;
      } else {
        // Prefer the previous tab, else next
        const prevIdx = idx - 1;
        if (prevIdx >= 0) {
          newActiveId = newOpen[prevIdx].id;
        } else {
          newActiveId = newOpen[0].id;
        }
      }
    }

    set({ tabs: newOpen, activeId: newActiveId });
  },

  activate(id) {
    const exists = get().tabs.some((t) => t.id === id);
    if (!exists) return;
    set({ activeId: id });
  },

  setDirty(id, dirty) {
    const current = get().tabs.find((t) => t.id === id);
    // Hot path: called on every keystroke. Skip rebuilding the array (and
    // churning every consumer of the store) when the value is unchanged.
    if (!current || current.dirty === dirty) return;
    set({ tabs: get().tabs.map((t) => (t.id === id ? { ...t, dirty } : t)) });
  },

  setMode(id, mode) {
    const idx = get().tabs.findIndex((t) => t.id === id);
    if (idx === -1) return;
    set({ tabs: get().tabs.map((t) => (t.id === id ? { ...t, mode } : t)) });
  },

  toggleMode(id) {
    const tab = get().tabs.find((t) => t.id === id);
    if (!tab) return;
    get().setMode(id, tab.mode === "edit" ? "read" : "edit");
  },

  active() {
    const { tabs, activeId } = get();
    if (!activeId) return null;
    return tabs.find((t) => t.id === activeId) ?? null;
  },

  registerFlush(id, fn) {
    flushCallbacks.set(id, fn);
  },

  unregisterFlush(id) {
    flushCallbacks.delete(id);
  },

  /** Invoke (and await) the flush callbacks for `path` — used to persist pending
   *  autosaves BEFORE a rename/move touches the disk. Folder-aware: flushing a
   *  directory path also flushes every open tab underneath it (callbacks are keyed
   *  by FILE path, so a bare lookup would silently no-op for folders and a
   *  descendant tab's debounced save could resurrect the old location). */
  async flush(path) {
    const fns = [...flushCallbacks.entries()]
      .filter(([key]) => key === path || key.startsWith(path + "/"))
      .map(([, fn]) => fn);
    for (const fn of fns) await fn();
  },

  /**
   * Re-key open tabs after a rename or move: `oldPath` itself, and (for a folder) every
   * tab underneath it, follow to `newPath`. Names are recomputed from the new basename.
   * Flush registrations for retargeted tabs are DROPPED, not moved — the registered saver
   * still writes to the old path, and invoking it after the rename would recreate the old
   * file; the remounted editor registers a fresh one under the new id.
   */
  retarget(oldPath, newPath) {
    const moved = (p: string): string | null => {
      if (p === oldPath) return newPath;
      if (p.startsWith(oldPath + "/")) return newPath + p.slice(oldPath.length);
      return null;
    };
    const { tabs, activeId } = get();
    if (!tabs.some((t) => moved(t.path) !== null)) return;
    const updated = tabs.map((t) => {
      const next = moved(t.path);
      if (next === null) return t;
      flushCallbacks.delete(t.id);
      return { ...t, id: next, path: next, name: next.split("/").at(-1) ?? next };
    });
    const activeNext = activeId ? (moved(activeId) ?? activeId) : null;
    set({ tabs: updated, activeId: activeNext });
  },
}));

export const useTabs = <T>(sel: (s: TabsState) => T): T => useStore(tabsStore, sel);
