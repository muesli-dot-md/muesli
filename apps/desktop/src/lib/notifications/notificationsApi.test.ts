import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the Tauri invoke bridge (the Rust `api_request` command returns `{ status, body }`).
const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

import { createNotificationsApi } from "./notificationsApi";

const SRV = "http://localhost:8787";

describe("desktop notificationsApi", () => {
  beforeEach(() => invoke.mockReset());

  it("unreadCount routes through api_request and returns the badge count", async () => {
    invoke.mockResolvedValue({ status: 200, body: { count: 2 } });
    const api = createNotificationsApi(SRV);
    const { count } = await api.unreadCount();
    expect(count).toBe(2);
    expect(invoke).toHaveBeenCalledWith("api_request", {
      server: SRV,
      method: "GET",
      path: "/api/notifications/unread-count",
      body: undefined,
    });
  });

  it("list passes the unread filter", async () => {
    invoke.mockResolvedValue({ status: 200, body: { notifications: [] } });
    const api = createNotificationsApi(SRV);
    await api.list({ unread: true });
    expect(invoke).toHaveBeenCalledWith(
      "api_request",
      expect.objectContaining({ path: "/api/notifications?unread=true" }),
    );
  });

  it("markRead POSTs to the per-notification read route", async () => {
    invoke.mockResolvedValue({ status: 200, body: { ok: true } });
    const api = createNotificationsApi(SRV);
    await api.markRead("n1");
    expect(invoke).toHaveBeenCalledWith("api_request", {
      server: SRV,
      method: "POST",
      path: "/api/notifications/n1/read",
      body: undefined,
    });
  });

  it("setPreference round-trips the email toggle through notification-preferences", async () => {
    invoke.mockResolvedValue({ status: 200, body: { ok: true } });
    const api = createNotificationsApi(SRV);
    await api.setPreference("mention", "email", false);
    expect(invoke).toHaveBeenCalledWith("api_request", {
      server: SRV,
      method: "PUT",
      path: "/api/notification-preferences",
      body: { event_type: "mention", channel: "email", enabled: false },
    });
  });
});
