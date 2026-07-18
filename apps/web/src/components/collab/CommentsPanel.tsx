// Comments sidebar panel — React port of CommentsPanel.svelte, adapted from
// the desktop CollabPanels.tsx skeleton with the WEB behaviors restored:
//   - i18n via useT() (desktop is unlocalized)
//   - the "Linked mentions" backlinks section (ADR 0015): documents whose
//     wikilinks point at this one, loaded once on mount via graphApi; errors
//     (volatile / signed out) just hide the section
//   - clicking a backlink navigates via gotoDoc (SPA hash navigation)
// The store arrives as an explicit prop (wave contract {store}); docId +
// shareToken are optional extras the DocApp host passes so the backlinks
// section can load — without them the section simply doesn't render.

import { useEffect, useRef, useState } from "react";
import { ChevronDown, RotateCcw } from "lucide-react";

import type { Thread } from "@/services/collabApi";
import { createGraphApi, type IncomingLink } from "@/services/graphApi";
import { httpBase } from "@/services/identity";
import { gotoDoc } from "@/state/route";
import { useT } from "@/state/i18n";
import { authorName, relativeTime, useCollabSnapshot, type CollabStore } from "@/state/collabStore";
import { useMentionAutocomplete } from "@/state/mentionAutocomplete";
import { cn } from "@/lib/utils";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { MentionText } from "./MentionText";

export interface CommentsPanelProps {
  store: CollabStore;
  /** Doc slug — enables the "Linked mentions" backlinks section. */
  docId?: string;
  shareToken?: string | null;
}

function ThreadCard({
  collab,
  thread,
  orphaned,
}: {
  collab: CollabStore;
  thread: Thread;
  orphaned: boolean;
}) {
  const t = useT();
  const [reply, setReply] = useState("");
  // Callback ref: attaches the mention autocomplete when the reply input mounts.
  const inputRef = useMentionAutocomplete({ members: collab.members });

  async function sendReply() {
    const body = reply.trim();
    if (!body) return;
    if (await collab.reply(thread.id, body)) setReply("");
  }

  return (
    <div
      id={`muesli-thread-${thread.id}`}
      className={cn(
        "rounded-lg border bg-card shadow-sm transition-shadow hover:shadow",
        orphaned && "opacity-80",
      )}
      role="button"
      tabIndex={0}
      onClick={() => !orphaned && collab.focusRange(thread.range)}
      onKeyDown={(e) => e.key === "Enter" && !orphaned && collab.focusRange(thread.range)}
    >
      <div className="flex flex-col gap-2 p-3">
        {thread.comments.map((comment, i) => (
          // Replies (i > 0) indent + a thread spine so they read as answers to
          // the first comment.
          <div key={comment.id} className={i > 0 ? "ml-1 border-l pl-3" : ""}>
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-xs font-semibold">{authorName(comment.author)}</span>
              <div className="flex items-center gap-1">
                <span className="text-xs opacity-50">{relativeTime(comment.created_at)}</span>
                {i === 0 &&
                  (thread.status === "resolved" ? (
                    // Reopen, NOT another checkmark: a second ✓ here read as
                    // "this is resolved" and nobody guessed it undoes it.
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      className="rounded-full"
                      title={t("comments.reopenThread")}
                      aria-label={t("comments.reopenThread")}
                      onClick={(e) => {
                        e.stopPropagation();
                        void collab.reopenThread(thread.id);
                      }}
                    >
                      <RotateCcw aria-hidden="true" />
                    </Button>
                  ) : (
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      className="rounded-full"
                      title={t("comments.resolveThread")}
                      aria-label={t("comments.resolveThread")}
                      onClick={(e) => {
                        e.stopPropagation();
                        void collab.resolveThread(thread.id);
                      }}
                    >
                      ✓
                    </Button>
                  ))}
              </div>
            </div>
            <p className="mt-0.5 text-sm">
              <MentionText body={comment.body} knownIds={collab.mentionableIds} />
            </p>
          </div>
        ))}
        <div className="mt-1 flex items-center gap-1">
          <Input
            ref={inputRef}
            className="h-6 flex-1 text-xs"
            placeholder={t("comments.replyPlaceholder")}
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") void sendReply();
            }}
          />
        </div>
      </div>
    </div>
  );
}

export function CommentsPanel({ store: collab, docId, shareToken }: CommentsPanelProps) {
  useCollabSnapshot(collab);
  const t = useT();

  // Linked mentions (ADR 0015): loaded once when the panel mounts; errors
  // (volatile / signed out) just hide the section — the comments UI above
  // already explains those states.
  const [backlinks, setBacklinks] = useState<IncomingLink[]>([]);
  const [backlinksLoaded, setBacklinksLoaded] = useState(false);
  useEffect(() => {
    if (!docId) return;
    let cancelled = false;
    (async () => {
      try {
        const api = createGraphApi({ httpBase, shareToken });
        const incoming = (await api.getDocumentLinks(docId)).incoming;
        if (!cancelled) {
          setBacklinks(incoming);
          setBacklinksLoaded(true);
        }
      } catch {
        if (!cancelled) setBacklinksLoaded(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [docId, shareToken]);

  function openDoc(slug: string) {
    if (!slug || slug === docId) return;
    gotoDoc(slug); // SPA hash navigation; DocApp remounts on the new slug
  }

  // Editor → sidebar: clicking a comment highlight sets revealThreadId; scroll
  // its card into view and flash it so the thread (and replies) are obvious.
  const flashTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const revealThreadId: string | null = collab.revealThreadId;
  useEffect(() => {
    if (!revealThreadId) return;
    collab.revealThreadId = null;
    const el = document.getElementById(`muesli-thread-${revealThreadId}`);
    if (!el) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollIntoView({ block: "center", behavior: reduced ? "auto" : "smooth" });
    el.classList.add("muesli-thread-flash");
    clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => el.classList.remove("muesli-thread-flash"), 1600);
  }, [collab, revealThreadId]);

  if (collab.availability === "auth") {
    return (
      <div className="flex flex-col gap-3 p-3">
        <p className="px-1 py-6 text-center text-sm opacity-60">{t("comments.signInToView")}</p>
      </div>
    );
  }

  const openThreads: Thread[] = collab.openThreads;
  const orphanedThreads: Thread[] = collab.orphanedThreads;
  const resolvedThreads: Thread[] = collab.resolvedThreads;

  return (
    <div className="flex flex-col gap-3 p-3">
      <p className="px-1 text-xs opacity-60">
        {t("comments.hintPre")} <span className="font-medium">{t("editor.commentAction")}</span>{" "}
        {t("comments.hintPost")}
      </p>

      {openThreads.length === 0 && orphanedThreads.length === 0 && resolvedThreads.length === 0 && (
        <p className="px-1 py-4 text-center text-sm opacity-50">{t("comments.none")}</p>
      )}

      {openThreads.map((thread) => (
        <ThreadCard key={thread.id} collab={collab} thread={thread} orphaned={false} />
      ))}

      {orphanedThreads.length > 0 && (
        <>
          <div className="my-1 flex items-center gap-2 text-xs opacity-70">
            <span className="h-px flex-1 bg-border" />
            {t("comments.onDeletedText")}
            <span className="h-px flex-1 bg-border" />
          </div>
          <p className="-mt-2 px-1 text-xs opacity-50">{t("comments.orphanNote")}</p>
          {orphanedThreads.map((thread) => (
            <ThreadCard key={thread.id} collab={collab} thread={thread} orphaned={true} />
          ))}
        </>
      )}

      {resolvedThreads.length > 0 && (
        <Collapsible className="rounded-lg border bg-card">
          <CollapsibleTrigger className="group flex w-full items-center justify-between px-3 py-2 text-sm font-medium">
            {t("comments.resolvedCount", { count: resolvedThreads.length })}
            <ChevronDown
              className="size-3.5 opacity-60 transition-transform group-data-[panel-open]:rotate-180"
              aria-hidden="true"
            />
          </CollapsibleTrigger>
          <CollapsibleContent className="flex flex-col gap-2 px-2 pb-2">
            {resolvedThreads.map((thread) => (
              <ThreadCard key={thread.id} collab={collab} thread={thread} orphaned={false} />
            ))}
          </CollapsibleContent>
        </Collapsible>
      )}

      {backlinksLoaded && (
        <Collapsible defaultOpen={backlinks.length > 0} className="rounded-lg border bg-card">
          <CollapsibleTrigger className="group flex w-full items-center justify-between px-3 py-2 text-sm font-medium">
            {t("comments.linkedMentions", { count: backlinks.length })}
            <ChevronDown
              className="size-3.5 opacity-60 transition-transform group-data-[panel-open]:rotate-180"
              aria-hidden="true"
            />
          </CollapsibleTrigger>
          <CollapsibleContent className="px-2 pb-2">
            {backlinks.length === 0 ? (
              <p className="px-1 pb-2 text-xs opacity-50">
                {t("comments.noBacklinksPre")} <span className="font-mono">[[{docId}]]</span>{" "}
                {t("comments.noBacklinksPost")}
              </p>
            ) : (
              <ul className="flex w-full flex-col gap-0.5">
                {backlinks.map((link) => (
                  <li key={link.document_id + link.raw_target}>
                    <button
                      type="button"
                      className="arc-tap flex h-8 w-full items-center rounded-md px-2 text-left transition-colors hover:bg-surface-hover"
                      onClick={() => openDoc(link.slug)}
                      title={t("comments.openDoc", { slug: link.slug })}
                    >
                      <span className="truncate font-mono text-xs">{link.slug}.md</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  );
}

export default CommentsPanel;
