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
  const flushCallbacks = new Map<string, () => void>();

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

  function registerFlush(id: string, fn: () => void): void {
    flushCallbacks.set(id, fn);
  }

  function unregisterFlush(id: string): void {
    flushCallbacks.delete(id);
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
  };
}

export const tabs = createTabsStore();
