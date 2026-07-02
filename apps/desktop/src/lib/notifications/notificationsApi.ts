// Notifications inbox + preferences client for the desktop app (sub-project ④c).
//
// Built over the authenticated `apiRequest` Tauri command (bearer token stays in the
// Keychain, never the webview) — the same transport the ④a/④b collab shim uses. These routes
// are user-scoped, not document-scoped, so this is its own small client. Method surface mirrors
// the webapp's createNotificationsApi.

import { apiRequest } from "../collab/apiRequest";

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

/** Bind the notifications client to a server (the active workspace server). */
export function createNotificationsApi(server: string) {
  return {
    list: (opts: { unread?: boolean; before?: string } = {}) =>
      apiRequest<{ notifications: Notification[] }>(server, {
        path: "/api/notifications",
        query: { unread: opts.unread ? "true" : undefined, before: opts.before },
      }),
    unreadCount: () =>
      apiRequest<{ count: number }>(server, { path: "/api/notifications/unread-count" }),
    markRead: (id: string) =>
      apiRequest<{ ok: boolean }>(server, {
        method: "POST",
        path: `/api/notifications/${encodeURIComponent(id)}/read`,
      }),
    markAllRead: () =>
      apiRequest<{ marked: number }>(server, {
        method: "POST",
        path: "/api/notifications/read-all",
      }),
    getPreferences: () =>
      apiRequest<{ preferences: Preference[] }>(server, {
        path: "/api/notification-preferences",
      }),
    setPreference: (event_type: string, channel: string, enabled: boolean) =>
      apiRequest<{ ok: boolean }>(server, {
        method: "PUT",
        path: "/api/notification-preferences",
        body: { event_type, channel, enabled },
      }),
  };
}

export type NotificationsApi = ReturnType<typeof createNotificationsApi>;
