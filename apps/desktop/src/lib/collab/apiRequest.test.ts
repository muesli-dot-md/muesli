import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the Tauri invoke bridge. The Rust `api_request` command returns
// `{ status, body }`; apiRequest unwraps it (or throws ApiError on >= 400).
const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

import { apiRequest, ApiError } from "./apiRequest";

describe("apiRequest", () => {
  beforeEach(() => invoke.mockReset());

  it("passes { server, method, path, body } through invoke and returns the parsed body", async () => {
    invoke.mockResolvedValue({ status: 200, body: { ok: true } });
    const out = await apiRequest<{ ok: boolean }>("http://localhost:3000", {
      method: "POST",
      path: "/api/documents/x/comments",
      body: { body: "hi" },
    });
    expect(out).toEqual({ ok: true });
    expect(invoke).toHaveBeenCalledWith("api_request", {
      server: "http://localhost:3000",
      method: "POST",
      path: "/api/documents/x/comments",
      body: { body: "hi" },
    });
  });

  it("defaults the method to GET and omits body when absent", async () => {
    invoke.mockResolvedValue({ status: 200, body: { threads: [] } });
    await apiRequest("http://localhost:3000", { path: "/api/documents/x/comments" });
    expect(invoke).toHaveBeenCalledWith("api_request", {
      server: "http://localhost:3000",
      method: "GET",
      path: "/api/documents/x/comments",
      body: undefined,
    });
  });

  it("appends query params to the path", async () => {
    invoke.mockResolvedValue({ status: 200, body: {} });
    await apiRequest("http://localhost:3000", {
      path: "/api/documents/x/history",
      query: { limit: "30", before_seq: undefined },
    });
    expect(invoke).toHaveBeenCalledWith(
      "api_request",
      expect.objectContaining({ path: "/api/documents/x/history?limit=30" }),
    );
  });

  it("throws ApiError with status on a non-2xx response", async () => {
    invoke.mockResolvedValue({ status: 403, body: { error: "x" } });
    await expect(
      apiRequest("http://localhost:3000", { path: "/api/documents/x/comments" }),
    ).rejects.toMatchObject({ status: 403 });
    try {
      invoke.mockResolvedValue({ status: 403, body: { error: "nope" } });
      await apiRequest("http://localhost:3000", { path: "/p" });
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      expect((e as ApiError).status).toBe(403);
      expect((e as ApiError).bodyText).toContain("nope");
    }
  });
});
