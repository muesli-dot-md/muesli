// Reactive store for the collaboration sidebar (comments / suggestions /
// history). React port of src/collabStore.svelte.ts, using the desktop's
// state/collabStore.ts reactivity mechanics with the WEB semantics restored:
// i18n'd toasts via t(), errMsg() for unhandled failures, and relativeTime
// re-exported from services/time (locale-aware). Owns: polling (4s while
// visible, 1s-debounced after ydoc updates), byte<->UTF-16 conversion at the
// server boundary, decoration push, availability degradation (401/403 → quiet
// "sign in" state, 503 → volatile), and the suggest-mode draft queue.
//
// React adaptation: the Svelte $state class fields become private backing
// fields behind get/set accessors, so external assignment sites
// (`store.suggestMode = x`, `store.tab = "comments"`, `store.selection = …`)
// keep working verbatim while every write bumps a version counter and notifies
// subscribers. Components subscribe with the exported useCollabSnapshot(store)
// (useSyncExternalStore over the version number), then read fields directly.
// $derived lists are computed lazily and cached per version. The `view` field
// stays deliberately non-reactive, exactly as in the Svelte source.

import { useSyncExternalStore } from "react";
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
} from "@/services/collabApi";
import { errMsg } from "@/services/apiError";
import { t } from "@/state/i18n";
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
  // One store per doc session; the api is already bound to the session's slug.
  private readonly api: CollabApi;
  private readonly ydoc: Y.Doc;

  constructor(api: CollabApi, ydoc: Y.Doc) {
    this.api = api;
    this.ydoc = ydoc;
  }

  // --- external-store plumbing (replaces Svelte's rune reactivity) -----------

  private version = 0;
  private listeners = new Set<() => void>();

  /** useSyncExternalStore subscribe. Stable bound method. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** useSyncExternalStore snapshot: a monotonically increasing version. */
  getSnapshot = (): number => this.version;

  private notify(): void {
    this.version++;
    for (const l of [...this.listeners]) l();
  }

  // --- reactive fields (accessor pairs so external writes notify) ------------

  private _threads: Thread[] = [];
  get threads(): Thread[] {
    return this._threads;
  }
  set threads(v: Thread[]) {
    this._threads = v;
    this.notify();
  }

  private _suggestions: Suggestion[] = [];
  get suggestions(): Suggestion[] {
    return this._suggestions;
  }
  set suggestions(v: Suggestion[]) {
    this._suggestions = v;
    this.notify();
  }

  // @mention members (sub-project ④b): who can be tagged on this doc; loaded once and
  // used both to populate the composer picker and to know which chips are "known".
  private _members: Member[] = [];
  get members(): Member[] {
    return this._members;
  }
  set members(v: Member[]) {
    this._members = v;
    this.notify();
  }

  private _history: HistoryEntry[] = [];
  get history(): HistoryEntry[] {
    return this._history;
  }
  set history(v: HistoryEntry[]) {
    this._history = v;
    this.notify();
  }

  private _historyDone = false;
  get historyDone(): boolean {
    return this._historyDone;
  }
  set historyDone(v: boolean) {
    this._historyDone = v;
    this.notify();
  }

  private _historyLoading = false;
  get historyLoading(): boolean {
    return this._historyLoading;
  }
  set historyLoading(v: boolean) {
    this._historyLoading = v;
    this.notify();
  }

  private _availability: Availability = "unknown";
  get availability(): Availability {
    return this._availability;
  }
  set availability(v: Availability) {
    this._availability = v;
    this.notify();
  }

  private _toast: string | null = null;
  get toast(): string | null {
    return this._toast;
  }
  set toast(v: string | null) {
    this._toast = v;
    this.notify();
  }

  private _sidebarOpen = true;
  get sidebarOpen(): boolean {
    return this._sidebarOpen;
  }
  set sidebarOpen(v: boolean) {
    this._sidebarOpen = v;
    this.notify();
  }

  private _tab: SidebarTab = "comments";
  get tab(): SidebarTab {
    return this._tab;
  }
  set tab(v: SidebarTab) {
    this._tab = v;
    this.notify();
  }

  /** Thread the editor asked the sidebar to reveal (click on a comment
   * highlight). CommentsPanel consumes it: scroll to the card, flash, clear. */
  private _revealThreadId: string | null = null;
  get revealThreadId(): string | null {
    return this._revealThreadId;
  }
  set revealThreadId(v: string | null) {
    this._revealThreadId = v;
    this.notify();
  }

  revealThread(threadId: string): void {
    this.sidebarOpen = true;
    this.tab = "comments";
    this.revealThreadId = threadId;
  }

  private _suggestMode = false;
  get suggestMode(): boolean {
    return this._suggestMode;
  }
  set suggestMode(v: boolean) {
    this._suggestMode = v;
    this.notify();
  }

  private _drafts: Draft[] = [];
  get drafts(): Draft[] {
    return this._drafts;
  }
  set drafts(v: Draft[]) {
    this._drafts = v;
    this.notify();
  }

  /** change-set id (or suggestion id) -> conflict warning shown on the card */
  private _conflicts: Record<string, string> = {};
  get conflicts(): Record<string, string> {
    return this._conflicts;
  }
  set conflicts(v: Record<string, string>) {
    this._conflicts = v;
    this.notify();
  }

  /** Read-only point-in-time snapshot being viewed (history click). */
  private _snapshot: { seq: number; text: string; entry: HistoryEntry } | null = null;
  get snapshot(): { seq: number; text: string; entry: HistoryEntry } | null {
    return this._snapshot;
  }
  set snapshot(v: { seq: number; text: string; entry: HistoryEntry } | null) {
    this._snapshot = v;
    this.notify();
  }

  /** Current editor selection, UTF-16 (kept fresh by EditorPane). */
  private _selection: { from: number; to: number } = { from: 0, to: 0 };
  get selection(): { from: number; to: number } {
    return this._selection;
  }
  set selection(v: { from: number; to: number }) {
    this._selection = v;
    this.notify();
  }

  /** Bumped by the toolbar's comment button; the editor watches it and opens
   * the comment/suggest composer over the current selection. */
  private _composerRequest = 0;
  get composerRequest(): number {
    return this._composerRequest;
  }
  set composerRequest(v: number) {
    this._composerRequest = v;
    this.notify();
  }

  requestComposer(): void {
    this.composerRequest++;
  }

  view: EditorView | null = null; // deliberately non-reactive
  private toastTimer: ReturnType<typeof setTimeout> | undefined;
  private flashTimer: ReturnType<typeof setTimeout> | undefined;
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private refreshing = false;

  // --- deriveds ($derived → lazy compute, cached per version) ----------------

  private derivedVersion = -1;
  private _openThreads: Thread[] = [];
  private _resolvedThreads: Thread[] = [];
  private _orphanedThreads: Thread[] = [];
  private _pendingGroups: SuggestionGroup[] = [];
  private _mentionableIds: Set<string> = new Set();

  private ensureDeriveds(): void {
    if (this.derivedVersion === this.version) return;
    this.derivedVersion = this.version;
    this._openThreads = this._threads.filter((t) => t.status === "open");
    this._resolvedThreads = this._threads.filter((t) => t.status === "resolved");
    this._orphanedThreads = this._threads.filter((t) => t.status === "orphaned");
    this._pendingGroups = groupByChangeSet(this._suggestions);
    this._mentionableIds = new Set(this._members.map((m) => m.id));
  }

  get openThreads(): Thread[] {
    this.ensureDeriveds();
    return this._openThreads;
  }
  get resolvedThreads(): Thread[] {
    this.ensureDeriveds();
    return this._resolvedThreads;
  }
  get orphanedThreads(): Thread[] {
    this.ensureDeriveds();
    return this._orphanedThreads;
  }
  get pendingGroups(): SuggestionGroup[] {
    this.ensureDeriveds();
    return this._pendingGroups;
  }
  /** Set of member ids, for MentionText to render unknown/removed users muted. */
  get mentionableIds(): Set<string> {
    this.ensureDeriveds();
    return this._mentionableIds;
  }

  // --- lifecycle -------------------------------------------------------------

  /** Start polling; returns a stop function. */
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
      this.drafts = [...this.drafts, { from, to, insert: kind === "delete" ? "" : insert, oldText }];
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

// Stable fallbacks so the hook can be called unconditionally with a null store
// (React hooks cannot be conditional; docCollab.store is null for local docs).
const noopSubscribe = () => () => {};
const zeroSnapshot = () => 0;

/**
 * Subscribe a React component to a CollabStore instance. Returns the store's
 * version counter — treat it as an opaque "something changed" signal and read
 * the store's fields directly in render (they are stable between versions).
 * Accepts null (no collab store wired) and then returns a constant 0.
 */
export function useCollabSnapshot(store: CollabStore | null): number {
  return useSyncExternalStore(
    store ? store.subscribe : noopSubscribe,
    store ? store.getSnapshot : zeroSnapshot,
    store ? store.getSnapshot : zeroSnapshot,
  );
}

// --- tiny shared formatter (sidebar timestamps; lives in time.ts for the home screen) ---------

export { relativeTime } from "@/services/time";

export function authorName(author: { display_name: string | null } | null): string {
  return author?.display_name ?? t("collab.anonymous");
}
