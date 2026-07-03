// Reactive store for the collaboration sidebar (comments / suggestions /
// history). Owns:
//   - polling (4s while the tab is visible, immediately after own mutations,
//     debounced 1s after ydoc updates — accepts arrive as ws updates)
//   - byte<->UTF-16 conversion at the server boundary (offsets.ts)
//   - pushing decorations into the editor (annotations.ts)
//   - availability: 401/403 -> quiet "sign in" state, 503 -> volatile (hidden)
//   - suggest-mode drafts (queued local edits, submitted as one change set)

import { EditorView } from "@codemirror/view";
import { EditorSelection, type ChangeDesc } from "@codemirror/state";
import type * as Y from "yjs";
import {
  ApiError,
  type CollabApi,
  type HistoryEntry,
  type Member,
  type Suggestion,
  type Thread,
} from "./collabApi";
import { errMsg } from "./apiError";
import { t } from "./i18n/index.svelte";
import { byteRangeToUtf16, utf16RangeToByte } from "@muesli/editor-core/offsets";
import {
  setCollabDecorations,
  setFlashRange,
  type CommentHighlight,
  type SuggestionHighlight,
} from "@muesli/editor-core/annotations";

export type Availability = "unknown" | "ok" | "auth" | "volatile";
export type SidebarTab = "comments" | "suggestions" | "history";
export type Draft = { from: number; to: number; insert: string; oldText: string };
export type SuggestionGroup = { changeSetId: string; items: Suggestion[] };

const HISTORY_PAGE = 30;

export class CollabStore {
  // One store per doc session (session.ts builds it alongside the Y.Doc/provider);
  // the api is already bound to the session's slug + share token.
  private readonly api: CollabApi;
  private readonly ydoc: Y.Doc;

  constructor(api: CollabApi, ydoc: Y.Doc) {
    this.api = api;
    this.ydoc = ydoc;
  }

  threads: Thread[] = $state([]);
  suggestions: Suggestion[] = $state([]);

  // @mention members (sub-project ④b): who can be tagged on this doc; loaded once and
  // used both to populate the composer picker and to know which chips are "known".
  members: Member[] = $state([]);
  /** Set of member ids, for MentionText to render unknown/removed users muted. */
  mentionableIds: Set<string> = $derived(new Set(this.members.map((m) => m.id)));
  history: HistoryEntry[] = $state([]);
  historyDone = $state(false);
  historyLoading = $state(false);
  availability: Availability = $state("unknown");
  toast: string | null = $state(null);

  sidebarOpen = $state(true);
  tab: SidebarTab = $state("comments");

  /** Thread the editor asked the sidebar to reveal (click on a comment
   * highlight). CommentsPanel consumes it: scroll to the card, flash, clear. */
  revealThreadId: string | null = $state(null);

  revealThread(threadId: string): void {
    this.sidebarOpen = true;
    this.tab = "comments";
    this.revealThreadId = threadId;
  }

  suggestMode = $state(false);
  drafts: Draft[] = $state([]);
  /** change-set id (or suggestion id) -> conflict warning shown on the card */
  conflicts: Record<string, string> = $state({});

  /** Read-only point-in-time snapshot being viewed (history click). */
  snapshot: { seq: number; text: string; entry: HistoryEntry } | null = $state(null);

  /** Current editor selection, UTF-16 (kept fresh by Editor.svelte). */
  selection = $state({ from: 0, to: 0 });

  /** Bumped by the toolbar's comment button; Editor.svelte watches it and
   * opens the comment/suggest composer over the current selection. */
  composerRequest = $state(0);

  requestComposer(): void {
    this.composerRequest++;
  }

  view: EditorView | null = null; // deliberately non-reactive
  private toastTimer: ReturnType<typeof setTimeout> | undefined;
  private flashTimer: ReturnType<typeof setTimeout> | undefined;
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private refreshing = false;

  openThreads = $derived(this.threads.filter((t) => t.status === "open"));
  resolvedThreads = $derived(this.threads.filter((t) => t.status === "resolved"));
  orphanedThreads = $derived(this.threads.filter((t) => t.status === "orphaned"));
  pendingGroups = $derived(groupByChangeSet(this.suggestions));

  // --- lifecycle -------------------------------------------------------------

  /** Start polling; returns a stop function (App.svelte onMount). */
  start(): () => void {
    void this.refresh();
    void this.loadMembers(); // @mention picker data (sub-project ④b); loaded once
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") void this.refresh();
    }, 4000);
    const onVisible = () => {
      if (document.visibilityState === "visible") void this.refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    // Accepted suggestions land as ws updates; refetch (debounced) so inline
    // decorations and the sidebar drop the now-applied suggestion promptly.
    const onYUpdate = () => {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = setTimeout(() => void this.refresh(), 1000);
    };
    this.ydoc.on("update", onYUpdate);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
      this.ydoc.off("update", onYUpdate);
      clearTimeout(this.debounceTimer);
    };
  }

  async refresh(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      const [comments, suggestions] = await Promise.all([
        this.api.getComments(),
        this.api.getSuggestions("pending"),
      ]);
      this.threads = comments.threads;
      this.suggestions = suggestions.suggestions;
      this.availability = "ok";
      this.syncDecorations();
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
        this.availability = "auth";
      } else if (e instanceof ApiError && e.status === 503) {
        this.availability = "volatile";
      }
      // network errors: keep last known state, retry on the next tick
    } finally {
      this.refreshing = false;
    }
  }

  /** Load the @mention member list once (best-effort; failures leave it empty so the
   *  picker is just unavailable, never an error). */
  async loadMembers(): Promise<void> {
    try {
      this.members = (await this.api.getMembers()).members;
    } catch {
      // signed-out / volatile / network — the composer simply offers no suggestions.
    }
  }

  // --- decorations -------------------------------------------------------------

  /** Recompute UTF-16 ranges from server byte ranges and push to the editor. */
  syncDecorations(): void {
    const view = this.view;
    if (!view) return;
    const text = view.state.doc.toString();
    const comments: CommentHighlight[] = [];
    for (const t of this.threads) {
      if (t.status === "open" && t.range) {
        const { from, to } = byteRangeToUtf16(text, t.range);
        comments.push({ from, to, threadId: t.id });
      }
    }
    const suggestions: SuggestionHighlight[] = [];
    for (const s of this.suggestions) {
      if (!s.range) continue;
      const { from, to } = byteRangeToUtf16(text, s.range);
      suggestions.push({ from, to, insert: s.op.insert, id: s.id });
    }
    view.dispatch({ effects: setCollabDecorations.of({ comments, suggestions }) });
  }

  /** Scroll to and flash a server byte range (sidebar card click). */
  focusRange(range: { start: number; end: number } | null): void {
    const view = this.view;
    if (!view || !range) return;
    const text = view.state.doc.toString();
    const { from, to } = byteRangeToUtf16(text, range);
    view.dispatch({
      selection: EditorSelection.cursor(from),
      effects: [EditorView.scrollIntoView(from, { y: "center" }), setFlashRange.of({ from, to })],
    });
    clearTimeout(this.flashTimer);
    this.flashTimer = setTimeout(() => {
      this.view?.dispatch({ effects: setFlashRange.of(null) });
    }, 1500);
  }

  // --- comments ------------------------------------------------------------------

  async addComment(body: string): Promise<boolean> {
    const view = this.view;
    if (!view) return false;
    const { start, end } = utf16RangeToByte(view.state.doc.toString(), this.selection);
    return (await this.mutate(() => this.api.createComment(start, end, body))) !== null;
  }

  async reply(threadId: string, body: string): Promise<boolean> {
    return (await this.mutate(() => this.api.replyToThread(threadId, body))) !== null;
  }

  async resolveThread(threadId: string): Promise<void> {
    await this.mutate(() => this.api.resolveThread(threadId));
  }

  async reopenThread(threadId: string): Promise<void> {
    await this.mutate(() => this.api.reopenThread(threadId));
  }

  // --- suggest mode ------------------------------------------------------------------

  addDraft(kind: "replace" | "insert-after" | "delete", insert: string): void {
    const view = this.view;
    if (!view) return;
    const { from, to } = this.selection;
    const doc = view.state.doc;
    const oldText = doc.sliceString(from, to);
    if (kind === "insert-after") {
      this.drafts = [...this.drafts, { from: to, to, insert, oldText: "" }];
    } else {
      this.drafts = [
        ...this.drafts,
        { from, to, insert: kind === "delete" ? "" : insert, oldText },
      ];
    }
  }

  removeDraft(index: number): void {
    this.drafts = this.drafts.filter((_, i) => i !== index);
  }

  /** Keep queued drafts aligned when remote edits land while suggest mode is on. */
  mapDraftsThroughChanges(changes: ChangeDesc): void {
    if (this.drafts.length === 0) return;
    this.drafts = this.drafts
      .map((d) => ({ ...d, from: changes.mapPos(d.from, 1), to: changes.mapPos(d.to, -1) }))
      .map((d) => (d.to < d.from ? { ...d, to: d.from } : d));
  }

  async submitDrafts(note: string): Promise<boolean> {
    const view = this.view;
    if (!view || this.drafts.length === 0) return false;
    const text = view.state.doc.toString();
    const edits = this.drafts.map((d) => {
      const { start, end } = utf16RangeToByte(text, d);
      return { start, end, insert: d.insert };
    });
    const ok = await this.mutate(() =>
      this.api.createSuggestion(edits, note.trim() ? note.trim() : undefined),
    );
    if (ok !== null) this.drafts = [];
    return ok !== null;
  }

  // --- pending suggestion review ---------------------------------------------------------

  async acceptGroup(group: SuggestionGroup): Promise<void> {
    try {
      if (group.items.length > 1) {
        const res = await this.api.acceptChangeSet(group.changeSetId);
        if (res.conflicts.length > 0) {
          this.conflicts = {
            ...this.conflicts,
            [group.changeSetId]: res.conflicts.map((c) => c.reason).join("; "),
          };
        }
      } else {
        await this.api.acceptSuggestion(group.items[0].id);
      }
      await this.refresh();
      await this.loadHistory(true);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        this.conflicts = { ...this.conflicts, [group.changeSetId]: e.bodyText.trim() };
      } else {
        this.handleMutationError(e);
      }
    }
  }

  async rejectGroup(group: SuggestionGroup): Promise<void> {
    await this.mutate(() =>
      group.items.length > 1
        ? this.api.rejectChangeSet(group.changeSetId)
        : this.api.rejectSuggestion(group.items[0].id),
    );
  }

  // --- history / time travel --------------------------------------------------------------

  async loadHistory(reset = false): Promise<void> {
    if (this.historyLoading) return;
    this.historyLoading = true;
    try {
      const beforeSeq =
        !reset && this.history.length > 0
          ? this.history[this.history.length - 1].first_seq
          : undefined;
      const { entries } = await this.api.getHistory({ limit: HISTORY_PAGE, beforeSeq });
      this.history = reset ? entries : [...this.history, ...entries];
      this.historyDone = entries.length < HISTORY_PAGE;
    } catch (e) {
      this.handleMutationError(e);
    } finally {
      this.historyLoading = false;
    }
  }

  async openSnapshot(entry: HistoryEntry): Promise<void> {
    try {
      const { seq, text } = await this.api.getText(entry.last_seq);
      this.snapshot = { seq, text, entry };
    } catch (e) {
      this.handleMutationError(e);
    }
  }

  closeSnapshot(): void {
    this.snapshot = null;
  }

  // --- plumbing ------------------------------------------------------------------------------

  showToast(message: string): void {
    this.toast = message;
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => (this.toast = null), 4000);
  }

  private handleMutationError(e: unknown): void {
    if (e instanceof ApiError && e.status === 403) {
      this.showToast(t("collab.linkNotAllowed"));
    } else if (e instanceof ApiError && e.status === 401) {
      this.showToast(t("common.signInToDo"));
      this.availability = "auth";
    } else if (e instanceof ApiError && e.status === 503) {
      this.availability = "volatile";
    } else {
      this.showToast(errMsg(e));
    }
  }

  /** Run a mutation; refresh on success, toast + degrade on failure. */
  private async mutate<T>(fn: () => Promise<T>): Promise<T | null> {
    try {
      const result = await fn();
      await this.refresh();
      return result;
    } catch (e) {
      this.handleMutationError(e);
      return null;
    }
  }
}

function groupByChangeSet(suggestions: Suggestion[]): SuggestionGroup[] {
  const map = new Map<string, Suggestion[]>();
  for (const s of suggestions) {
    const list = map.get(s.change_set_id);
    if (list) list.push(s);
    else map.set(s.change_set_id, [s]);
  }
  return [...map.entries()].map(([changeSetId, items]) => ({ changeSetId, items }));
}

// --- tiny shared formatter (sidebar timestamps; lives in time.ts for the home screen) ---------

export { relativeTime } from "./time";

export function authorName(author: { display_name: string | null } | null): string {
  return author?.display_name ?? t("collab.anonymous");
}
