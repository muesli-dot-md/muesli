import { describe, it, expect } from "vitest";
import { createWorkspaceApi } from "./workspaceApi";

function fakeFetch(capture: { url?: string; init?: RequestInit }) {
  return (async (url: RequestInfo | URL, init?: RequestInit) => {
    capture.url = String(url);
    capture.init = init;
    return new Response(JSON.stringify({ ok: true, policy: {}, bound: false }), { status: 200 });
  }) as typeof fetch;
}

describe("wizard api additions", () => {
  it("getS3Policy hits /api/storage/s3/policy with query params", async () => {
    const cap: { url?: string } = {};
    const api = createWorkspaceApi({ httpBase: "http://x", fetchFn: fakeFetch(cap) });
    await api.getS3Policy("my-bucket", "notes");
    expect(cap.url).toBe("http://x/api/storage/s3/policy?bucket=my-bucket&prefix=notes");
  });

  it("getStorageStatus hits the workspace status route", async () => {
    const cap: { url?: string } = {};
    const api = createWorkspaceApi({ httpBase: "http://x", fetchFn: fakeFetch(cap) });
    await api.getStorageStatus("ws-1");
    expect(cap.url).toBe("http://x/api/workspaces/ws-1/storage/status");
  });

  it("createStorageConnection posts s3 credentials", async () => {
    const cap: { url?: string; init?: RequestInit } = {};
    const api = createWorkspaceApi({ httpBase: "http://x", fetchFn: fakeFetch(cap) });
    await api.createStorageConnection("ws-1", {
      kind: "s3",
      endpoint: "https://e",
      bucket: "b",
      access_key_id: "AKIA",
      secret_key: "shh",
    });
    const body = JSON.parse(String(cap.init?.body));
    expect(body.access_key_id).toBe("AKIA");
    expect(body.secret_key).toBe("shh");
  });
});
