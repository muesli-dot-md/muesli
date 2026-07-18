import { describe, expect, it, vi } from "vitest";
import { createNotificationsApi } from "./notificationsApi";

/** A fetch stub that records calls and returns a canned JSON body. */
function stubFetch(body: unknown, status = 200) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchFn = vi.fn((url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
  }) as unknown as typeof fetch;
  return { fetchFn, calls };
}

describe("notificationsApi", () => {
  it("unreadCount reflects the server count (drives the bell badge)", async () => {
    const { fetchFn, calls } = stubFetch({ count: 3 });
    const api = createNotificationsApi({ httpBase: "http://srv", fetchFn });
    const { count } = await api.unreadCount();
    expect(count).toBe(3);
    expect(calls[0].url).toBe("http://srv/api/notifications/unread-count");
    expect(calls[0].init?.credentials).toBe("include");
  });

  it("list passes unread filter and parses notifications", async () => {
    const { fetchFn, calls } = stubFetch({
      notifications: [
        {
          id: "n1",
          type: "mention",
          payload: { actor_name: "Ada", doc_slug: "notes", doc_title: "Notes" },
          actor_id: "u1",
          read: false,
          created_at: "2026-06-26T00:00:00Z",
        },
      ],
    });
    const api = createNotificationsApi({ httpBase: "http://srv", fetchFn });
    const { notifications } = await api.list({ unread: true });
    expect(notifications).toHaveLength(1);
    expect(notifications[0].payload.actor_name).toBe("Ada");
    expect(calls[0].url).toContain("/api/notifications?unread=true");
  });

  it("markRead POSTs to the per-notification read route", async () => {
    const { fetchFn, calls } = stubFetch({ ok: true });
    const api = createNotificationsApi({ httpBase: "http://srv", fetchFn });
    await api.markRead("n1");
    expect(calls[0].url).toBe("http://srv/api/notifications/n1/read");
    expect(calls[0].init?.method).toBe("POST");
  });

  it("setPreference round-trips the email toggle through notification-preferences", async () => {
    const { fetchFn, calls } = stubFetch({ ok: true });
    const api = createNotificationsApi({ httpBase: "http://srv", fetchFn });
    await api.setPreference("mention", "email", false);
    expect(calls[0].url).toBe("http://srv/api/notification-preferences");
    expect(calls[0].init?.method).toBe("PUT");
    expect(JSON.parse(calls[0].init?.body as string)).toEqual({
      event_type: "mention",
      channel: "email",
      enabled: false,
    });
  });

  it("getPreferences returns the matrix the settings UI binds to", async () => {
    const { fetchFn } = stubFetch({
      preferences: [
        { event_type: "mention", channel: "in_app", enabled: true, toggleable: false },
        { event_type: "mention", channel: "email", enabled: true, toggleable: true },
      ],
    });
    const api = createNotificationsApi({ httpBase: "http://srv", fetchFn });
    const { preferences } = await api.getPreferences();
    const email = preferences.find((p) => p.channel === "email");
    expect(email?.enabled).toBe(true);
    expect(email?.toggleable).toBe(true);
  });
});
