// Notifications inbox + preferences client (sub-project ④c). Talks to the user-scoped
// /api/notifications* and /api/notification-preferences endpoints (not document-scoped, so
// this is its own small client rather than part of collabApi). Auth rides the session cookie
// (credentials: "include"), exactly like collabApi.

export class ApiError extends Error {
  constructor(
    public status: number,
    public bodyText: string,
  ) {
    super(`notifications api ${status}: ${bodyText}`);
  }
}

/** One notification row as the inbox renders it. `payload` is the type-specific render data. */
export type Notification = {
  id: string;
  type: string;
  payload: {
    actor_name?: string | null;
    doc_slug?: string;
    doc_title?: string;
    thread_id?: string;
    comment_id?: string;
  };
  actor_id: string | null;
  read: boolean;
  created_at: string;
};

/** One row of the preference matrix (event-type × channel). */
export type Preference = {
  event_type: string;
  channel: string;
  enabled: boolean;
  toggleable: boolean;
};

export type NotificationsApiConfig = {
  httpBase: string;
  /** Override fetch (tests); defaults to globalThis.fetch. */
  fetchFn?: typeof fetch;
};

export function createNotificationsApi(cfg: NotificationsApiConfig) {
  const fetchFn = cfg.fetchFn ?? ((...args: Parameters<typeof fetch>) => fetch(...args));

  async function req<T>(
    path: string,
    opts: { method?: string; body?: unknown; query?: Record<string, string | undefined> } = {},
  ): Promise<T> {
    const url = new URL(`${cfg.httpBase}/api${path}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, v);
    }
    const res = await fetchFn(url.toString(), {
      method: opts.method ?? "GET",
      credentials: "include",
      headers: opts.body !== undefined ? { "content-type": "application/json" } : undefined,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    if (!res.ok) throw new ApiError(res.status, await res.text());
    return (await res.json()) as T;
  }

  return {
    list: (opts: { unread?: boolean; before?: string } = {}) =>
      req<{ notifications: Notification[] }>("/notifications", {
        query: {
          unread: opts.unread ? "true" : undefined,
          before: opts.before,
        },
      }),
    unreadCount: () => req<{ count: number }>("/notifications/unread-count"),
    markRead: (id: string) =>
      req<{ ok: boolean }>(`/notifications/${encodeURIComponent(id)}/read`, { method: "POST" }),
    markAllRead: () => req<{ marked: number }>("/notifications/read-all", { method: "POST" }),
    getPreferences: () => req<{ preferences: Preference[] }>("/notification-preferences"),
    setPreference: (event_type: string, channel: string, enabled: boolean) =>
      req<{ ok: boolean }>("/notification-preferences", {
        method: "PUT",
        body: { event_type, channel, enabled },
      }),
  };
}

export type NotificationsApi = ReturnType<typeof createNotificationsApi>;
