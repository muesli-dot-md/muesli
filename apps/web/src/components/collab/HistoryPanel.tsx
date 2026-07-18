// History sidebar panel — React port of HistoryPanel.svelte, adapted from the
// desktop CollabPanels.tsx skeleton with the web i18n re-threaded. Clicking an
// entry calls collab.openSnapshot(entry); the web DocApp renders the read-only
// snapshot as a modal (renderMarkdown) from collab.snapshot — the panel never
// touches the editor. Store arrives as an explicit prop (wave contract {store}).
//
// Loading: in the Svelte app the Sidebar host owned the lazy first load
// (history tab opened && history empty). The panel only mounts when its tab is
// active, so loading on mount when the list is empty is behaviorally identical
// — and the historyLoading/length guards make it safe if the host ALSO
// triggers a load.

import { useEffect } from "react";

import type { HistoryEntry } from "@/services/collabApi";
import { useT } from "@/state/i18n";
import { authorName, relativeTime, useCollabSnapshot, type CollabStore } from "@/state/collabStore";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

const updates = (e: HistoryEntry) => e.last_seq - e.first_seq + 1;

export function HistoryPanel({ store: collab }: { store: CollabStore }) {
  useCollabSnapshot(collab);
  const t = useT();

  // Lazy first page when the tab mounts (see note above).
  useEffect(() => {
    if (collab.history.length === 0) void collab.loadHistory(true);
    // Mount-only, like the Svelte host's first-open effect (a later store swap
    // remounts the whole panel because the parent keys on the store).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collab]);

  const history: HistoryEntry[] = collab.history;

  return (
    <div className="flex flex-col gap-1.5 p-3">
      {history.length === 0 && !collab.historyLoading && (
        <p className="px-1 py-4 text-center text-sm opacity-50">{t("history.none")}</p>
      )}

      {history.map((entry) => (
        <button
          key={entry.first_seq}
          type="button"
          className="rounded-lg border bg-card px-3 py-2 text-left text-xs hover:bg-muted active:translate-y-px"
          title={t("history.viewAtPoint")}
          onClick={() => void collab.openSnapshot(entry)}
        >
          <span className="font-semibold">
            {entry.author?.kind === "agent" ? "✦ " : ""}
            {authorName(entry.author)}
          </span>
          <span className="opacity-50">
            {" "}
            · {entry.origin} · {relativeTime(entry.created_at)}
          </span>
          <span className="opacity-50">
            {" "}
            ·{" "}
            {t(updates(entry) === 1 ? "history.updates.one" : "history.updates.other", {
              count: updates(entry),
            })}
          </span>
          {entry.change_set_id && (
            <Badge
              variant="ghost"
              className="ml-1 h-4 px-1 text-[0.65rem]"
              title={t("history.suggestionTitle")}
            >
              {t("history.suggestionBadge")}
            </Badge>
          )}
        </button>
      ))}

      {!collab.historyDone && history.length > 0 && (
        <Button
          variant="ghost"
          size="xs"
          className="mt-1"
          disabled={collab.historyLoading}
          onClick={() => void collab.loadHistory()}
        >
          {collab.historyLoading ? t("common.loading") : t("common.loadMore")}
        </Button>
      )}
    </div>
  );
}

export default HistoryPanel;
