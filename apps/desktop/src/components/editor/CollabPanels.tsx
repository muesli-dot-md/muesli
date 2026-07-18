// Right-sidebar collaboration panels: Comments / Suggestions / History, plus
// the MentionText body renderer. Ports of src/lib/collab/CommentsPanel.svelte,
// SuggestionsPanel.svelte and HistoryPanel.svelte (which were themselves
// ported from apps/web with explicit `store` props instead of context and
// literal strings instead of i18n).
import { useEffect, useRef, useState } from "react";
import { ChevronDown, RotateCcw, X } from "lucide-react";

import type { HistoryEntry, Thread } from "@/services/collab/collabApi";
import { renderMentions } from "@/services/collab/mentions";
// Sibling module still being built by the state agent — import by contract.
import {
  authorName,
  relativeTime,
  useCollabSnapshot,
  type CollabStore,
  type SuggestionGroup,
} from "@/state/collabStore";
import { useMentionAutocomplete } from "@/state/mentionAutocomplete";
import { cn } from "@/lib/utils";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";

// ── MentionText ──────────────────────────────────────────────────────────────
// Renders a comment/reply body with @mention chips. Plain runs keep their
// whitespace; each `@[Name](muesli:user/<id>)` becomes a colored chip whose
// color comes from colorFromId so it matches the person's presence color.
// Unknown/removed users (id not in `knownIds`) render muted.
export function MentionText({ body, knownIds }: { body: string; knownIds?: Set<string> }) {
  const segments = renderMentions(body, knownIds);
  return (
    <span className="whitespace-pre-wrap">
      {segments.map((seg, i) =>
        seg.kind === "text" ? (
          <span key={i}>{seg.text}</span>
        ) : seg.known ? (
          <span
            key={i}
            className="mx-0.5 inline-flex items-center rounded px-1 align-baseline text-xs font-medium text-white"
            style={{ backgroundColor: seg.color }}
            title={seg.name}
          >
            @{seg.name}
          </span>
        ) : (
          <span
            key={i}
            className="mx-0.5 inline-flex items-center rounded bg-muted px-1 align-baseline text-xs font-medium opacity-60"
            title={seg.name}
          >
            @{seg.name}
          </span>
        ),
      )}
    </span>
  );
}

// ── CommentsPanel ────────────────────────────────────────────────────────────

function ThreadCard({
  collab,
  thread,
  orphaned,
}: {
  collab: CollabStore;
  thread: Thread;
  orphaned: boolean;
}) {
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
                      title="Reopen this thread"
                      aria-label="Reopen this thread"
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
                      title="Resolve this thread"
                      aria-label="Resolve this thread"
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
            placeholder="Reply… (@ to mention)"
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

export function CommentsPanel({ store: collab }: { store: CollabStore }) {
  useCollabSnapshot(collab);

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
        <p className="px-1 py-6 text-center text-sm opacity-60">Sign in to view comments.</p>
      </div>
    );
  }

  const openThreads: Thread[] = collab.openThreads;
  const orphanedThreads: Thread[] = collab.orphanedThreads;
  const resolvedThreads: Thread[] = collab.resolvedThreads;

  return (
    <div className="flex flex-col gap-3 p-3">
      <p className="px-1 text-xs opacity-60">
        Select text and use the <span className="font-medium">Comment</span> action to start a
        thread.
      </p>

      {openThreads.length === 0 &&
        orphanedThreads.length === 0 &&
        resolvedThreads.length === 0 && (
          <p className="px-1 py-4 text-center text-sm opacity-50">No comments yet.</p>
        )}

      {openThreads.map((thread) => (
        <ThreadCard key={thread.id} collab={collab} thread={thread} orphaned={false} />
      ))}

      {orphanedThreads.length > 0 && (
        <>
          <div className="my-1 flex items-center gap-2 text-xs opacity-70">
            <span className="h-px flex-1 bg-border" />
            On deleted text
            <span className="h-px flex-1 bg-border" />
          </div>
          <p className="-mt-2 px-1 text-xs opacity-50">
            These threads were anchored to text that has since been removed.
          </p>
          {orphanedThreads.map((thread) => (
            <ThreadCard key={thread.id} collab={collab} thread={thread} orphaned={true} />
          ))}
        </>
      )}

      {resolvedThreads.length > 0 && (
        <Collapsible className="rounded-lg border bg-card">
          <CollapsibleTrigger className="group flex w-full items-center justify-between px-3 py-2 text-sm font-medium">
            Resolved ({resolvedThreads.length})
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
    </div>
  );
}

// ── SuggestionsPanel ─────────────────────────────────────────────────────────

const draftLabel = (d: { from: number; to: number; insert: string; oldText: string }) =>
  d.oldText && d.insert ? "Replace" : d.insert ? "Insert" : "Delete";

function groupRange(group: SuggestionGroup) {
  return group.items.find((s) => s.range)?.range ?? null;
}

export function SuggestionsPanel({ store: collab }: { store: CollabStore }) {
  useCollabSnapshot(collab);
  const [note, setNote] = useState("");

  async function submit() {
    if (await collab.submitDrafts(note)) setNote("");
  }

  if (collab.availability === "auth") {
    return (
      <div className="flex flex-col gap-3 p-3">
        <p className="px-1 py-6 text-center text-sm opacity-60">Sign in to suggest edits.</p>
      </div>
    );
  }

  const pendingGroups: SuggestionGroup[] = collab.pendingGroups;

  return (
    <div className="flex flex-col gap-3 p-3">
      <p className="px-1 text-xs opacity-60">
        {collab.suggestMode ? (
          <>
            Editing is paused — select text and use the{" "}
            <span className="font-medium">Suggest</span> action to queue a change.
          </>
        ) : (
          <>
            Switch the editor mode to Suggesting to propose edits without changing the document
            directly.
          </>
        )}
      </p>

      {collab.suggestMode && collab.drafts.length > 0 && (
        <div className="rounded-lg border border-amber-500/50 bg-card shadow-sm">
          <div className="flex flex-col gap-2 p-3">
            <span className="text-xs font-semibold uppercase tracking-wide opacity-60">
              Queued ({collab.drafts.length})
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
                  title="Remove"
                  onClick={() => collab.removeDraft(i)}
                >
                  <X aria-hidden="true" />
                </Button>
              </div>
            ))}
            <Input
              className="h-6 w-full text-xs"
              placeholder="Add a note (optional)"
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
            <Button size="xs" onClick={() => void submit()}>
              {collab.drafts.length > 1 ? "Submit suggestions" : "Submit suggestion"}
            </Button>
          </div>
        </div>
      )}

      <div className="my-0 flex items-center gap-2 text-xs opacity-70">
        <span className="h-px flex-1 bg-border" />
        Pending
        <span className="h-px flex-1 bg-border" />
      </div>

      {pendingGroups.length === 0 && (
        <p className="px-1 py-4 text-center text-sm opacity-50">No pending suggestions.</p>
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
                    !s.op.old_text && <span className="opacity-50">(empty edit)</span>
                  )}
                  {!s.range && (
                    <Badge
                      variant="ghost"
                      className="ml-1 h-4 px-1 text-[0.65rem]"
                      title="This edit is no longer anchored to text in the document"
                    >
                      detached
                    </Badge>
                  )}
                </div>
              ))}
              {collab.conflicts[group.changeSetId] && (
                <div className="rounded border border-amber-500/50 bg-amber-500/10 px-2 py-1 text-xs text-amber-700 dark:text-amber-400">
                  Couldn't apply: {collab.conflicts[group.changeSetId]}
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
                  Reject
                </Button>
                <Button
                  size="xs"
                  className="bg-emerald-600 text-white hover:bg-emerald-600/85"
                  onClick={(e) => {
                    e.stopPropagation();
                    void collab.acceptGroup(group);
                  }}
                >
                  Accept
                </Button>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── HistoryPanel ─────────────────────────────────────────────────────────────

const updates = (e: HistoryEntry) => e.last_seq - e.first_seq + 1;

export function HistoryPanel({ store: collab }: { store: CollabStore }) {
  useCollabSnapshot(collab);

  // The history list is loaded lazily (the store doesn't poll it); pull the
  // first page when the tab mounts.
  useEffect(() => {
    if (collab.history.length === 0) void collab.loadHistory(true);
    // Mount-only, like the Svelte onMount (a later store swap remounts the
    // whole panel because the parent keys on the store).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collab]);

  const history: HistoryEntry[] = collab.history;

  return (
    <div className="flex flex-col gap-1.5 p-3">
      {history.length === 0 && !collab.historyLoading && (
        <p className="px-1 py-4 text-center text-sm opacity-50">No history yet.</p>
      )}

      {history.map((entry) => (
        <button
          key={entry.first_seq}
          type="button"
          className="rounded-lg border bg-card px-3 py-2 text-left text-xs hover:bg-muted active:translate-y-px"
          title="View the document at this point in time"
          onClick={() => void collab.openSnapshot(entry)}
        >
          <span className="font-semibold">
            {entry.author?.kind === "agent" ? "✦ " : ""}
            {authorName(entry.author)}
          </span>
          <span className="opacity-50"> · {entry.origin} · {relativeTime(entry.created_at)}</span>
          <span className="opacity-50">
            {" "}
            · {updates(entry) === 1 ? "1 update" : `${updates(entry)} updates`}
          </span>
          {entry.change_set_id && (
            <Badge
              variant="ghost"
              className="ml-1 h-4 px-1 text-[0.65rem]"
              title="From an accepted suggestion"
            >
              suggestion
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
          {collab.historyLoading ? "Loading…" : "Load more"}
        </Button>
      )}
    </div>
  );
}
