// Shared drag state for moving files/folders within the tree by drag-and-drop.
// Port of src/lib/dnd.svelte.ts. `draggingPath` is the absolute path of the
// node currently being dragged, so any folder row can validate whether it's a
// legal drop target during dragover (the DataTransfer payload isn't readable
// until drop). The Svelte version was mutated directly (`dnd.draggingPath = x`);
// here use `setDraggingPath`.

import { createStore } from "zustand/vanilla";
import { useStore } from "zustand";

export interface DndState {
  draggingPath: string | null;
  setDraggingPath(path: string | null): void;
}

export const dndStore = createStore<DndState>()((set) => ({
  draggingPath: null,
  setDraggingPath: (path) => set({ draggingPath: path }),
}));

export const useDnd = <T>(sel: (s: DndState) => T): T => useStore(dndStore, sel);
