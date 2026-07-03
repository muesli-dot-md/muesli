// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as Y from "yjs";
import { CollabStore, authorName, relativeTime } from "./collabStore.svelte";
import type { CollabApi, Thread } from "./collabApi";

function fakeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: "t1",
    status: "open",
    range: { start: 1, end: 5 }, // bytes
    created_by: "u1",
    created_at: new Date().toISOString(),
    comments: [
      { id: "c1", body: "hello", created_at: new Date().toISOString(), author: { id: "u1", display_name: "Ada", kind: "human" } },
    ],
    ...overrides,
  };
}

function fakeApi(threads: Thread[]): CollabApi {
  return {
    getComments: vi.fn(async () => ({ threads })),
    getSuggestions: vi.fn(async () => ({ suggestions: [] })),
    createComment: vi.fn(),
    replyToThread: vi.fn(),
    resolveThread: vi.fn(),
    reopenThread: vi.fn(),
    createSuggestion: vi.fn(),
    acceptSuggestion: vi.fn(),
    rejectSuggestion: vi.fn(),
    acceptChangeSet: vi.fn(),
    rejectChangeSet: vi.fn(),
    getHistory: vi.fn(async () => ({ entries: [] })),
    getText: vi.fn(async () => ({ seq: 1, text: "" })),
  } as unknown as CollabApi;
}

describe("CollabStore", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("exposes threads after refresh and computes open/resolved buckets", async () => {
    const ydoc = new Y.Doc();
    const store = new CollabStore(fakeApi([fakeThread()]), ydoc);
    await store.refresh();
    expect(store.threads.length).toBe(1);
    expect(store.openThreads.length).toBe(1);
    expect(store.availability).toBe("ok");
  });

  it("syncDecorations converts server byte ranges to UTF-16 and dispatches", () => {
    const ydoc = new Y.Doc();
    const store = new CollabStore(fakeApi([]), ydoc);
    // Stub a view with a multi-byte doc; emoji is 4 bytes / 2 units.
    const dispatched: unknown[] = [];
    store.view = {
      state: { doc: { toString: () => "a😀b" } },
      dispatch: (tr: unknown) => dispatched.push(tr),
    } as never;
    store.threads = [fakeThread({ range: { start: 1, end: 5 } })];
    store.syncDecorations();
    // The dispatched effect carries a comment at UTF-16 { from: 1, to: 3 }.
    const tr = dispatched[0] as { effects: { value: { comments: { from: number; to: number }[] } } };
    expect(tr.effects.value.comments[0]).toMatchObject({ from: 1, to: 3 });
  });

  it("start() polls and returns a stop function", async () => {
    const ydoc = new Y.Doc();
    const api = fakeApi([fakeThread()]);
    const store = new CollabStore(api, ydoc);
    const stop = store.start();
    await vi.advanceTimersByTimeAsync(0); // initial refresh
    expect(api.getComments).toHaveBeenCalled();
    stop();
  });

  it("authorName falls back to 'Anonymous'", () => {
    expect(authorName({ display_name: "Ada" })).toBe("Ada");
    expect(authorName(null)).toBe("Anonymous");
  });

  it("relativeTime returns a string", () => {
    expect(typeof relativeTime(new Date().toISOString())).toBe("string");
  });
});
