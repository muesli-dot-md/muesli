// REST data layer for the desktop collaboration UI (comments, suggestions,
// history). A thin SHIM with the same method surface as the webapp's
// `createCollabApi`, but built over the authenticated `apiRequest` Tauri
// command (the bearer token stays in the Keychain, never the webview) instead
// of a `fetch`+cookie copy. No `credentials`, no `share` token — the desktop
// is always bearer-authenticated (or open-mode).
//
// Conventions (server contract, shared with the webapp):
//   - all routes live under /api/documents/{slug}/
//   - all ranges/offsets in payloads are UTF-8 BYTE offsets (see offsets.ts)
//   - non-2xx responses throw ApiError (status + body text); callers map
//     401/403 to "sign in" states, 503 to "volatile mode", 409 to conflicts.

import { apiRequest, type RequestOpts } from "./apiRequest";

export type Author = { id: string; display_name: string | null; kind: string } | null;
export type ByteRange = { start: number; end: number };

/** A person who can be @mentioned on the doc (sub-project ④b members API). */
export type Member = {
  id: string;
  display_name: string | null;
  avatar_url: string | null;
  kind: string;
};

export type ThreadStatus = "open" | "resolved" | "orphaned";
export type Comment = { id: string; body: string; created_at: string; author: Author };
export type Thread = {
  id: string;
  status: ThreadStatus;
  range: ByteRange | null;
  created_by: string;
  created_at: string;
  comments: Comment[];
};

export type SuggestionOp = { start: number; end: number; insert: string; old_text: string };
export type Suggestion = {
  id: string;
  change_set_id: string;
  status: string;
  range: ByteRange | null;
  op: SuggestionOp;
  note: string | null;
  author: Author;
  created_at: string;
};

export type HistoryEntry = {
  first_seq: number;
  last_seq: number;
  origin: string;
  change_set_id: string | null;
  created_at: string;
  author: Author;
};

export type EditInput = { start: number; end: number; insert: string };

export type ChangeSetResult = {
  accepted: string[];
  conflicts: { id: string; reason: string }[];
  seq?: number;
};

// Re-export ApiError so collab callers can `instanceof`-check it like the webapp.
export { ApiError } from "./apiRequest";

/** A request function with the `apiRequest` surface, bound to a server. */
export type RequestFn = <T>(opts: RequestOpts) => Promise<T>;

export type CollabApiConfig = {
  /** The server URL (passed through to the Rust transport for token lookup). */
  server: string;
  docSlug: string;
  /** Override the transport (tests); defaults to the real `apiRequest`. */
  requestFn?: RequestFn;
};

export function createCollabApi(cfg: CollabApiConfig) {
  const requestFn: RequestFn =
    cfg.requestFn ?? (<T>(opts: RequestOpts) => apiRequest<T>(cfg.server, opts));
  const base = `/api/documents/${encodeURIComponent(cfg.docSlug)}`;

  function req<T>(
    suffix: string,
    opts: { method?: string; body?: unknown; query?: Record<string, string | undefined> } = {},
  ): Promise<T> {
    return requestFn<T>({
      method: opts.method ?? "GET",
      path: `${base}${suffix}`,
      body: opts.body,
      query: opts.query,
    });
  }

  return {
    // --- members (@mention picker, sub-project ④b) ---
    getMembers: () => req<{ members: Member[] }>("/members"),

    // --- comments ---
    getComments: (opts: { mentionsMe?: boolean } = {}) =>
      req<{ threads: Thread[] }>("/comments", {
        query: opts.mentionsMe ? { mentions: "me" } : undefined,
      }),
    createComment: (anchorStart: number, anchorEnd: number, body: string) =>
      req<{ thread_id: string }>("/comments", {
        method: "POST",
        body: { anchor_start: anchorStart, anchor_end: anchorEnd, body },
      }),
    replyToThread: (threadId: string, body: string) =>
      req<unknown>(`/comments/${threadId}/replies`, { method: "POST", body: { body } }),
    resolveThread: (threadId: string) =>
      req<unknown>(`/comments/${threadId}/resolve`, { method: "POST" }),
    reopenThread: (threadId: string) =>
      req<unknown>(`/comments/${threadId}/reopen`, { method: "POST" }),

    // --- suggestions ---
    getSuggestions: (status = "pending") =>
      req<{ suggestions: Suggestion[] }>("/suggestions", { query: { status } }),
    createSuggestion: (edits: EditInput[], note?: string) =>
      req<{ change_set_id: string; suggestion_ids?: string[] }>("/suggestions", {
        method: "POST",
        body: note ? { edits, note } : { edits },
      }),
    acceptSuggestion: (id: string) =>
      req<unknown>(`/suggestions/${id}/accept`, { method: "POST" }),
    rejectSuggestion: (id: string) =>
      req<unknown>(`/suggestions/${id}/reject`, { method: "POST" }),
    acceptChangeSet: (changeSetId: string) =>
      req<ChangeSetResult>(`/suggestions/changesets/${changeSetId}/accept`, { method: "POST" }),
    rejectChangeSet: (changeSetId: string) =>
      req<unknown>(`/suggestions/changesets/${changeSetId}/reject`, { method: "POST" }),

    // --- history / time travel ---
    getHistory: (opts: { limit?: number; beforeSeq?: number } = {}) =>
      req<{ entries: HistoryEntry[] }>("/history", {
        query: {
          limit: String(opts.limit ?? 30),
          before_seq: opts.beforeSeq !== undefined ? String(opts.beforeSeq) : undefined,
        },
      }),
    getText: (seq?: number) =>
      req<{ seq: number; text: string }>("/text", {
        query: { seq: seq !== undefined ? String(seq) : undefined },
      }),
  };
}

export type CollabApi = ReturnType<typeof createCollabApi>;
