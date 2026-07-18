/**
 * Shared reactive state for the active editor's current text and view.
 * EditorPane writes to this; ReadingView, Toolbar, and OutlineRail read it.
 * Port of src/lib/editorState.svelte.ts (property setters become setX actions).
 */

import { createStore } from "zustand/vanilla";
import { useStore } from "zustand";
import type { EditorView } from "@codemirror/view";

export interface EditorStateState {
  currentText: string;
  activeView: EditorView | null;
  selectionEpoch: number;
  setCurrentText(v: string): void;
  setActiveView(v: EditorView | null): void;
  setSelectionEpoch(v: number): void;
  /** Convenience for the Svelte-era `selectionEpoch++` bump sites. */
  bumpSelectionEpoch(): void;
}

export const editorStateStore = createStore<EditorStateState>()((set) => ({
  currentText: "",
  activeView: null,
  selectionEpoch: 0,
  setCurrentText: (v) => set({ currentText: v }),
  setActiveView: (v) => set({ activeView: v }),
  setSelectionEpoch: (v) => set({ selectionEpoch: v }),
  bumpSelectionEpoch: () => set((s) => ({ selectionEpoch: s.selectionEpoch + 1 })),
}));

export const useEditorState = <T>(sel: (s: EditorStateState) => T): T =>
  useStore(editorStateStore, sel);
