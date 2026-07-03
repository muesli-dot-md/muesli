// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { mount, unmount, flushSync } from "svelte";
import * as Y from "yjs";
import CommentsPanel from "./CommentsPanel.svelte";
import { CollabStore } from "./collabStore.svelte";
import type { CollabApi, Thread } from "./collabApi";

function storeWith(threads: Thread[]): CollabStore {
  const api = {
    getComments: vi.fn(async () => ({ threads })),
    getSuggestions: vi.fn(async () => ({ suggestions: [] })),
    reply: vi.fn(),
  } as unknown as CollabApi;
  const store = new CollabStore(api, new Y.Doc());
  store.threads = threads;
  store.availability = "ok";
  return store;
}

const thread: Thread = {
  id: "t1",
  status: "open",
  range: { start: 0, end: 4 },
  created_by: "u1",
  created_at: new Date().toISOString(),
  comments: [
    {
      id: "c1",
      body: "First comment body",
      created_at: new Date().toISOString(),
      author: { id: "u1", display_name: "Ada", kind: "human" },
    },
  ],
};

let host: HTMLElement | undefined;
let component: ReturnType<typeof mount> | undefined;

afterEach(() => {
  if (component) unmount(component);
  host?.remove();
  component = undefined;
  host = undefined;
});

describe("CommentsPanel", () => {
  it("renders an open thread's comment body and author", () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(CommentsPanel, { target: host, props: { store: storeWith([thread]) } });
    flushSync();
    expect(host.textContent).toContain("First comment body");
    expect(host.textContent).toContain("Ada");
  });

  it("shows the 'no comments yet' state for an empty store", () => {
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(CommentsPanel, { target: host, props: { store: storeWith([]) } });
    flushSync();
    expect(host.textContent).toContain("No comments yet.");
  });
});
