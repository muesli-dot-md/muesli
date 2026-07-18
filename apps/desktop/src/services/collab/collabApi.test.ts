import { describe, it, expect } from "vitest";
import { createCollabApi } from "./collabApi";
import type { RequestOpts } from "./apiRequest";

function fakeApi() {
  const calls: RequestOpts[] = [];
  const requestFn = async <T>(opts: RequestOpts): Promise<T> => {
    calls.push(opts);
    return {} as T;
  };
  const api = createCollabApi({ server: "http://s", docSlug: "my doc", requestFn });
  return { api, calls };
}

describe("collabApi shim", () => {
  it("GETs comments at the slug-encoded path", async () => {
    const { api, calls } = fakeApi();
    await api.getComments();
    expect(calls[0]).toMatchObject({ method: "GET", path: "/api/documents/my%20doc/comments" });
  });

  it("GETs the @mention members list", async () => {
    const { api, calls } = fakeApi();
    await api.getMembers();
    expect(calls[0]).toMatchObject({ method: "GET", path: "/api/documents/my%20doc/members" });
  });

  it("adds ?mentions=me when filtering comments to the caller's mentions", async () => {
    const { api, calls } = fakeApi();
    await api.getComments({ mentionsMe: true });
    expect(calls[0]).toMatchObject({
      method: "GET",
      path: "/api/documents/my%20doc/comments",
      query: { mentions: "me" },
    });
  });

  it("POSTs a comment with anchor_start/anchor_end/body", async () => {
    const { api, calls } = fakeApi();
    await api.createComment(3, 7, "hi");
    expect(calls[0]).toMatchObject({
      method: "POST",
      path: "/api/documents/my%20doc/comments",
      body: { anchor_start: 3, anchor_end: 7, body: "hi" },
    });
  });

  it("GETs history with a limit query", async () => {
    const { api, calls } = fakeApi();
    await api.getHistory({ limit: 30 });
    expect(calls[0]).toMatchObject({
      method: "GET",
      path: "/api/documents/my%20doc/history",
      query: { limit: "30", before_seq: undefined },
    });
  });

  it("GETs text at a seq", async () => {
    const { api, calls } = fakeApi();
    await api.getText(5);
    expect(calls[0]).toMatchObject({
      method: "GET",
      path: "/api/documents/my%20doc/text",
      query: { seq: "5" },
    });
  });

  it("POSTs a reply / resolve / reopen with the thread id in the path", async () => {
    const { api, calls } = fakeApi();
    await api.replyToThread("t1", "yo");
    await api.resolveThread("t1");
    await api.reopenThread("t1");
    expect(calls[0]).toMatchObject({
      method: "POST",
      path: "/api/documents/my%20doc/comments/t1/replies",
      body: { body: "yo" },
    });
    expect(calls[1]).toMatchObject({
      method: "POST",
      path: "/api/documents/my%20doc/comments/t1/resolve",
    });
    expect(calls[2]).toMatchObject({
      method: "POST",
      path: "/api/documents/my%20doc/comments/t1/reopen",
    });
  });

  it("handles suggestions: list, create, accept/reject, changeset accept/reject", async () => {
    const { api, calls } = fakeApi();
    await api.getSuggestions();
    await api.createSuggestion([{ start: 1, end: 2, insert: "x" }], "note");
    await api.acceptSuggestion("s1");
    await api.rejectSuggestion("s1");
    await api.acceptChangeSet("c1");
    await api.rejectChangeSet("c1");
    expect(calls[0]).toMatchObject({
      method: "GET",
      path: "/api/documents/my%20doc/suggestions",
      query: { status: "pending" },
    });
    expect(calls[1]).toMatchObject({
      method: "POST",
      path: "/api/documents/my%20doc/suggestions",
      body: { edits: [{ start: 1, end: 2, insert: "x" }], note: "note" },
    });
    expect(calls[2]).toMatchObject({
      method: "POST",
      path: "/api/documents/my%20doc/suggestions/s1/accept",
    });
    expect(calls[3]).toMatchObject({
      method: "POST",
      path: "/api/documents/my%20doc/suggestions/s1/reject",
    });
    expect(calls[4]).toMatchObject({
      method: "POST",
      path: "/api/documents/my%20doc/suggestions/changesets/c1/accept",
    });
    expect(calls[5]).toMatchObject({
      method: "POST",
      path: "/api/documents/my%20doc/suggestions/changesets/c1/reject",
    });
  });
});
