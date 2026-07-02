// REST data layer for the collaboration UI (comments, suggestions, history).
//
// Deliberately DOM-free: the browser builds one instance from collab.ts values
// (httpBase, docId, shareToken); the headless integration test
// (scripts/ui-flows-e2e.mjs) builds its own instance and drives the EXACT same
// functions against a live server.
//
// Conventions (server contract, see scripts/collab-e2e.mjs):
//   - all routes live under {httpBase}/api/documents/{slug}/
//   - requests carry credentials (session cookie); a share token from the URL
//     hash is sent as the X-Muesli-Share header on EVERY request (never the
//     query string, so the capability token stays out of server/proxy access
//     logs and browser history — security review finding 28)
//   - all ranges/offsets in payloads are UTF-8 BYTE offsets (see offsets.ts)
//   - non-2xx responses throw ApiError (status + plain-text body); callers map
//     401/403 to "sign in" states, 503 to "volatile mode", 409 to conflicts.

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

export class ApiError extends Error {
  status: number;
  bodyText: string;
  constructor(status: number, bodyText: string) {
    super(bodyText.trim() || `HTTP ${status}`);
    this.name = "ApiError";
    this.status = status;
    this.bodyText = bodyText;
  }
}

export type CollabApiConfig = {
  httpBase: string;
  docSlug: string;
  shareToken?: string | null;
  /** Override fetch (tests); defaults to globalThis.fetch. */
  fetchFn?: typeof fetch;
};

export function createCollabApi(cfg: CollabApiConfig) {
  const fetchFn = cfg.fetchFn ?? ((...args: Parameters<typeof fetch>) => fetch(...args));

  function makeUrl(path: string, query?: Record<string, string | undefined>): string {
    const url = new URL(`${cfg.httpBase}/api/documents/${encodeURIComponent(cfg.docSlug)}${path}`);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, v);
    }
    return url.toString();
  }

  async function req<T>(
    path: string,
    opts: { method?: string; body?: unknown; query?: Record<string, string | undefined> } = {},
  ): Promise<T> {
    const headers: Record<string, string> = {};
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    // Share token rides in a header, NOT the query string: URLs land in
    // server/proxy access logs and browser history (finding 28). Custom
    // headers are fine here — requests are same-origin with credentials.
    if (cfg.shareToken) headers["X-Muesli-Share"] = cfg.shareToken;
    const res = await fetchFn(makeUrl(path, opts.query), {
      method: opts.method ?? "GET",
      credentials: "include",
      headers: Object.keys(headers).length > 0 ? headers : undefined,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    if (!res.ok) throw new ApiError(res.status, await res.text());
    return (await res.json()) as T;
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
    acceptSuggestion: (id: string) => req<unknown>(`/suggestions/${id}/accept`, { method: "POST" }),
    rejectSuggestion: (id: string) => req<unknown>(`/suggestions/${id}/reject`, { method: "POST" }),
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
