// Suggestions sidebar panel — React port of SuggestionsPanel.svelte, adapted
// from the desktop CollabPanels.tsx skeleton with the web i18n re-threaded
// (desktop bakes English strings). Store arrives as an explicit prop (wave
// contract {store}).

import { useState } from "react";
import { X } from "lucide-react";

import { useT } from "@/state/i18n";
import {
  authorName,
  relativeTime,
  useCollabSnapshot,
  type CollabStore,
  type SuggestionGroup,
} from "@/state/collabStore";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";

function groupRange(group: SuggestionGroup) {
  return group.items.find((s) => s.range)?.range ?? null;
}

export function SuggestionsPanel({ store: collab }: { store: CollabStore }) {
  useCollabSnapshot(collab);
  const t = useT();
  const [note, setNote] = useState("");

  const draftLabel = (d: { from: number; to: number; insert: string; oldText: string }) =>
    d.oldText && d.insert
      ? t("suggest.replace")
      : d.insert
        ? t("suggest.insert")
        : t("suggest.delete");

  async function submit() {
    if (await collab.submitDrafts(note)) setNote("");
  }

  if (collab.availability === "auth") {
    return (
      <div className="flex flex-col gap-3 p-3">
        <p className="px-1 py-6 text-center text-sm opacity-60">{t("suggest.signInToSuggest")}</p>
      </div>
    );
  }

  const pendingGroups: SuggestionGroup[] = collab.pendingGroups;

  return (
    <div className="flex flex-col gap-3 p-3">
      <p className="px-1 text-xs opacity-60">
        {collab.suggestMode ? (
          <>
            {t("suggest.pausedPre")}{" "}
            <span className="font-medium">{t("editor.suggestAction")}</span>{" "}
            {t("suggest.pausedPost")}
          </>
        ) : (
          <>{t("suggest.switchHint")}</>
        )}
      </p>

      {collab.suggestMode && collab.drafts.length > 0 && (
        <div className="rounded-lg border border-amber-500/50 bg-card shadow-sm">
          <div className="flex flex-col gap-2 p-3">
            <span className="text-xs font-semibold uppercase tracking-wide opacity-60">
              {t("suggest.queued", { count: collab.drafts.length })}
            </span>
            {collab.drafts.map((draft, i) => (
              <div key={i} className="flex items-start justify-between gap-2 text-xs">
                <div className="min-w-0">
                  <Badge variant="ghost" className="mr-1 h-4 px-1 text-[0.65rem]">
                    {draftLabel(draft)}
                  </Badge>
                  {draft.oldText && <span className="suggest-old">{draft.oldText.slice(0, 60)}</span>}
                  {draft.oldText && draft.insert && <span className="opacity-50"> → </span>}
                  {draft.insert && <span className="suggest-new">{draft.insert.slice(0, 60)}</span>}
                </div>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="shrink-0"
                  title={t("suggest.remove")}
                  onClick={() => collab.removeDraft(i)}
                >
                  <X aria-hidden="true" />
                </Button>
              </div>
            ))}
            <Input
              className="h-6 w-full text-xs"
              placeholder={t("suggest.notePlaceholder")}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
            <Button size="xs" onClick={() => void submit()}>
              {t(collab.drafts.length > 1 ? "suggest.submit.other" : "suggest.submit.one")}
            </Button>
          </div>
        </div>
      )}

      <div className="my-0 flex items-center gap-2 text-xs opacity-70">
        <span className="h-px flex-1 bg-border" />
        {t("suggest.pending")}
        <span className="h-px flex-1 bg-border" />
      </div>

      {pendingGroups.length === 0 && (
        <p className="px-1 py-4 text-center text-sm opacity-50">{t("suggest.noPending")}</p>
      )}

      {pendingGroups.map((group) => {
        const first = group.items[0];
        return (
          <div
            key={group.changeSetId}
            className="rounded-lg border bg-card shadow-sm"
            role="button"
            tabIndex={0}
            onClick={() => collab.focusRange(groupRange(group))}
            onKeyDown={(e) => e.key === "Enter" && collab.focusRange(groupRange(group))}
          >
            <div className="flex flex-col gap-2 p-3">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-xs font-semibold">
                  {first.author?.kind === "agent" ? "✦ " : ""}
                  {authorName(first.author)}
                </span>
                <span className="text-xs opacity-50">{relativeTime(first.created_at)}</span>
              </div>
              {first.note && <p className="text-xs italic opacity-70">“{first.note}”</p>}
              {group.items.map((s) => (
                <div key={s.id} className="rounded bg-muted/60 px-2 py-1 text-xs">
                  {s.op.old_text && <span className="suggest-old">{s.op.old_text.slice(0, 120)}</span>}
                  {s.op.old_text && s.op.insert && <span className="opacity-50"> → </span>}
                  {s.op.insert ? (
                    <span className="suggest-new">{s.op.insert.slice(0, 120)}</span>
                  ) : (
                    !s.op.old_text && <span className="opacity-50">{t("suggest.emptyEdit")}</span>
                  )}
                  {!s.range && (
                    <Badge
                      variant="ghost"
                      className="ml-1 h-4 px-1 text-[0.65rem]"
                      title={t("suggest.detachedTitle")}
                    >
                      {t("suggest.detached")}
                    </Badge>
                  )}
                </div>
              ))}
              {collab.conflicts[group.changeSetId] && (
                <div className="rounded border border-amber-500/50 bg-amber-500/10 px-2 py-1 text-xs text-amber-700 dark:text-amber-400">
                  {t("suggest.conflict", { detail: collab.conflicts[group.changeSetId] })}
                </div>
              )}
              <div className="flex justify-end gap-1">
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={(e) => {
                    e.stopPropagation();
                    void collab.rejectGroup(group);
                  }}
                >
                  {t("suggest.reject")}
                </Button>
                <Button
                  size="xs"
                  className="bg-emerald-600 text-white hover:bg-emerald-600/85"
                  onClick={(e) => {
                    e.stopPropagation();
                    void collab.acceptGroup(group);
                  }}
                >
                  {t("suggest.accept")}
                </Button>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default SuggestionsPanel;
