// Read-only history-snapshot modal (time travel). The web renders snapshots as
// a renderMarkdown modal over the live editor — there is no reading view on
// web (unlike desktop's SnapshotView overlay). Port of the snapshot modal
// block from src/DocApp.svelte, on the shadcn Dialog with .prose-muesli
// typography and mermaid diagrams hydrated after render.
import { useEffect, useMemo, useRef } from "react";

import { renderMarkdown } from "@muesli/editor-core/render";
import { renderMermaidDiagrams } from "@muesli/editor-core/mermaid";
import type { HistoryEntry } from "@/services/collabApi";
import { authorName, relativeTime } from "@/state/collabStore";
import { useT } from "@/state/i18n";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";

export default function SnapshotModal({
  snapshot,
  onClose,
}: {
  snapshot: { seq: number; text: string; entry: HistoryEntry };
  onClose: () => void;
}) {
  const t = useT();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const html = useMemo(() => renderMarkdown(snapshot.text), [snapshot.text]);

  // Mermaid fences render as placeholders in the raw HTML; hydrate them into
  // diagrams once the snapshot markup is in the DOM.
  useEffect(() => {
    if (containerRef.current) renderMermaidDiagrams(containerRef.current);
  }, [html]);

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="flex max-h-[85vh] w-[91.7%] max-w-3xl flex-col gap-0">
        <div className="mb-2 flex items-center justify-between gap-2 border-b border-border pb-2 pr-8">
          <DialogTitle className="text-sm font-normal">
            <span className="font-semibold">{t("doc.snapshot")}</span>{" "}
            <span className="opacity-60">
              · {t("doc.seq", { seq: snapshot.seq })} · {authorName(snapshot.entry.author)} ·{" "}
              {relativeTime(snapshot.entry.created_at)}
            </span>
          </DialogTitle>
          <Button size="sm" onClick={onClose}>
            {t("doc.backToLive")}
          </Button>
        </div>
        <div
          ref={containerRef}
          className="prose-muesli min-h-0 flex-1 overflow-y-auto"
          // renderMarkdown sanitizes via DOMPurify inside editor-core.
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </DialogContent>
    </Dialog>
  );
}
