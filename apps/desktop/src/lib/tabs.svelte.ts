export interface Tab {
  id: string;
  path: string;
  name: string;
  dirty: boolean;
  mode: "edit" | "read";
}

interface TabsState {
  open: Tab[];
  activeId: string | null;
}

export function createTabsStore() {
  let state = $state<TabsState>({ open: [], activeId: null });

  // Plain Map — NOT reactive state
  const flushCallbacks = new Map<string, () => void | Promise<void>>();

  function openTab(path: string, name: string): void {
    const existing = state.open.find((t) => t.id === path);
    if (existing) {
      state = { ...state, activeId: path };
      return;
    }
    const tab: Tab = { id: path, path, name, dirty: false, mode: "edit" };
    state = { open: [...state.open, tab], activeId: path };
  }

  function closeTab(id: string): void {
    const idx = state.open.findIndex((t) => t.id === id);
    if (idx === -1) return;

    // Invoke flush callback if registered
    const flush = flushCallbacks.get(id);
    if (flush) flush();

    const newOpen = state.open.filter((t) => t.id !== id);

    let newActiveId: string | null = state.activeId;
    if (state.activeId === id) {
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

    state = { open: newOpen, activeId: newActiveId };
  }

  function activate(id: string): void {
    const exists = state.open.some((t) => t.id === id);
    if (!exists) return;
    state = { ...state, activeId: id };
  }

  function setDirty(id: string, dirty: boolean): void {
    const current = state.open.find((t) => t.id === id);
    // Hot path: called on every keystroke. Skip rebuilding the array (and
    // churning every consumer of `state`) when the value is unchanged.
    if (!current || current.dirty === dirty) return;
    const updated = state.open.map((t) => (t.id === id ? { ...t, dirty } : t));
    state = { ...state, open: updated };
  }

  function setMode(id: string, mode: "edit" | "read"): void {
    const idx = state.open.findIndex((t) => t.id === id);
    if (idx === -1) return;
    const updated = state.open.map((t) => (t.id === id ? { ...t, mode } : t));
    state = { ...state, open: updated };
  }

  function toggleMode(id: string): void {
    const tab = state.open.find((t) => t.id === id);
    if (!tab) return;
    setMode(id, tab.mode === "edit" ? "read" : "edit");
  }

  function active(): Tab | null {
    if (!state.activeId) return null;
    return state.open.find((t) => t.id === state.activeId) ?? null;
  }

  function registerFlush(id: string, fn: () => void | Promise<void>): void {
    flushCallbacks.set(id, fn);
  }

  function unregisterFlush(id: string): void {
    flushCallbacks.delete(id);
  }

  /** Invoke (and await) the flush callbacks for `path` — used to persist pending
   *  autosaves BEFORE a rename/move touches the disk. Folder-aware: flushing a
   *  directory path also flushes every open tab underneath it (callbacks are keyed
   *  by FILE path, so a bare lookup would silently no-op for folders and a
   *  descendant tab's debounced save could resurrect the old location). */
  async function flush(path: string): Promise<void> {
    const fns = [...flushCallbacks.entries()]
      .filter(([key]) => key === path || key.startsWith(path + "/"))
      .map(([, fn]) => fn);
    for (const fn of fns) await fn();
  }

  /**
   * Re-key open tabs after a rename or move: `oldPath` itself, and (for a folder) every
   * tab underneath it, follow to `newPath`. Names are recomputed from the new basename.
   * Flush registrations for retargeted tabs are DROPPED, not moved — the registered saver
   * still writes to the old path, and invoking it after the rename would recreate the old
   * file; the remounted editor registers a fresh one under the new id.
   */
  function retarget(oldPath: string, newPath: string): void {
    const moved = (p: string): string | null => {
      if (p === oldPath) return newPath;
      if (p.startsWith(oldPath + "/")) return newPath + p.slice(oldPath.length);
      return null;
    };
    if (!state.open.some((t) => moved(t.path) !== null)) return;
    const updated = state.open.map((t) => {
      const next = moved(t.path);
      if (next === null) return t;
      flushCallbacks.delete(t.id);
      return { ...t, id: next, path: next, name: next.split("/").at(-1) ?? next };
    });
    const activeNext = state.activeId ? (moved(state.activeId) ?? state.activeId) : null;
    state = { open: updated, activeId: activeNext };
  }

  return {
    get tabs() {
      return state.open;
    },
    get activeId() {
      return state.activeId;
    },
    open: openTab,
    close: closeTab,
    activate,
    setDirty,
    setMode,
    toggleMode,
    active,
    registerFlush,
    unregisterFlush,
    flush,
    retarget,
  };
}

export const tabs = createTabsStore();
