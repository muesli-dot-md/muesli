// Document outline (headings) for the right sidebar. Port of
// src/lib/OutlineRail.svelte: parseOutline over the shared current text;
// clicking a heading moves the CM selection and scrolls it to the top.
import { useMemo } from "react";
import { EditorView } from "@codemirror/view";
import { parseOutline } from "@muesli/editor-core/mdCommands";

import { editorStateStore, useEditorState } from "@/state/editorState";

export default function OutlineRail() {
  const currentText = useEditorState((s) => s.currentText);
  const items = useMemo(() => parseOutline(currentText), [currentText]);

  function goTo(from: number): void {
    const view = editorStateStore.getState().activeView;
    if (!view) return;
    const pos = Math.min(from, view.state.doc.length);
    view.dispatch({
      selection: { anchor: pos },
      effects: EditorView.scrollIntoView(pos, { y: "start" }),
    });
    view.focus();
  }

  return (
    <div className="py-1">
      {items.length === 0 ? (
        <p className="px-3 py-2 text-xs italic text-muted-foreground/60">No headings</p>
      ) : (
        items.map((item) => (
          <button
            key={item.from}
            type="button"
            className="w-full truncate rounded px-3 py-0.5 text-left text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            style={{ paddingLeft: `${8 + (item.level - 1) * 12}px` }}
            onClick={() => goTo(item.from)}
            title={item.text}
          >
            {item.text}
          </button>
        ))
      )}
    </div>
  );
}
