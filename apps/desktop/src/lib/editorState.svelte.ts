/**
 * Shared reactive state for the active editor's current text and view.
 * EditorPane writes to this; ReadingView, StatusBar, and Toolbar read from it.
 */

import { EditorView } from "@codemirror/view";

function createEditorState() {
  let currentText = $state("");
  let activeView = $state<EditorView | null>(null);
  let selectionEpoch = $state(0);

  return {
    get currentText() {
      return currentText;
    },
    set currentText(v: string) {
      currentText = v;
    },
    get activeView() {
      return activeView;
    },
    set activeView(v: EditorView | null) {
      activeView = v;
    },
    get selectionEpoch() {
      return selectionEpoch;
    },
    set selectionEpoch(v: number) {
      selectionEpoch = v;
    },
  };
}

export const editorState = createEditorState();
