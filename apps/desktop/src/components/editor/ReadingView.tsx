// Rendered-markdown reading view. Port of src/lib/ReadingView.svelte:
// renderMarkdown → innerHTML into .prose-muesli, then a post-render mermaid
// pass over the container (mermaid diagrams can't render from static HTML).
import { useEffect, useMemo, useRef } from "react";
import { renderMarkdown } from "@muesli/editor-core/render";
import { renderMermaidDiagrams } from "@muesli/editor-core/mermaid";

import { useEditorState } from "@/state/editorState";

export default function ReadingView() {
  const currentText = useEditorState((s) => s.currentText);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const html = useMemo(() => renderMarkdown(currentText), [currentText]);

  // Re-run whenever the document changes (html tracks currentText).
  useEffect(() => {
    if (containerRef.current) {
      renderMermaidDiagrams(containerRef.current);
    }
  }, [html]);

  return (
    <div className="reading-view-wrapper flex flex-1 justify-center overflow-auto">
      <div
        ref={containerRef}
        className="prose-muesli reading-view"
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}
