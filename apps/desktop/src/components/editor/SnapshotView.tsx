// Read-only point-in-time snapshot view (history time-travel). Port of
// src/lib/collab/SnapshotView.svelte. Renders the fetched snapshot text
// through the SAME markdown pipeline as the live reading view, but never
// touches the live document. A banner explains the mode and offers a close
// affordance that returns to the live editor.
import { useEffect, useMemo, useRef } from "react";
import { X } from "lucide-react";
import { renderMarkdown } from "@muesli/editor-core/render";
import { renderMermaidDiagrams } from "@muesli/editor-core/mermaid";
import type { HistoryEntry } from "@/services/collab/collabApi";
// Sibling module still being built by the state agent — import by contract.
import { relativeTime } from "@/state/collabStore";
import { Button } from "@/components/ui/button";

export default function SnapshotView({
  text,
  entry,
  onClose,
}: {
  text: string;
  entry: HistoryEntry;
  onClose: () => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const html = useMemo(() => renderMarkdown(text), [text]);

  useEffect(() => {
    if (containerRef.current) renderMermaidDiagrams(containerRef.current);
  }, [html]);

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {/* "Viewing history" banner */}
      <div className="flex shrink-0 items-center justify-between gap-2 bg-muted px-4 py-2 text-xs text-foreground shadow-sm">
        <span>
          Viewing history · {relativeTime(entry.created_at)}
          {entry.origin && <span className="opacity-60"> · {entry.origin}</span>}
          <span className="opacity-60"> (read-only)</span>
        </span>
        <Button
          variant="ghost"
          size="icon-xs"
          title="Return to the live document"
          onClick={onClose}
        >
          <X aria-hidden="true" />
        </Button>
      </div>

      <div className="reading-view-wrapper flex flex-1 justify-center overflow-auto">
        <div
          ref={containerRef}
          className="prose-muesli reading-view"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </div>
    </div>
  );
}
