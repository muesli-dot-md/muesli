// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { mount, unmount, flushSync } from "svelte";
import * as Y from "yjs";
import SuggestionsPanel from "./SuggestionsPanel.svelte";
import { CollabStore } from "./collabStore.svelte";
import type { CollabApi, Suggestion } from "./collabApi";

function emptyApi(): CollabApi {
  return {
    getComments: vi.fn(async () => ({ threads: [] })),
    getSuggestions: vi.fn(async () => ({ suggestions: [] })),
    acceptSuggestion: vi.fn(),
    rejectSuggestion: vi.fn(),
  } as unknown as CollabApi;
}

const suggestion: Suggestion = {
  id: "s1",
  change_set_id: "cs1",
  status: "pending",
  range: { start: 0, end: 3 },
  op: { start: 0, end: 3, insert: "new text", old_text: "old" },
  note: "please review",
  author: { id: "u1", display_name: "Ada", kind: "human" },
  created_at: new Date().toISOString(),
};

let host: HTMLElement | undefined;
let component: ReturnType<typeof mount> | undefined;

afterEach(() => {
  if (component) unmount(component);
  host?.remove();
  component = undefined;
  host = undefined;
});

function render(suggestions: Suggestion[]) {
  const store = new CollabStore(emptyApi(), new Y.Doc());
  store.suggestions = suggestions;
  store.availability = "ok";
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(SuggestionsPanel, { target: host, props: { store } });
  flushSync();
  return host;
}

describe("SuggestionsPanel", () => {
  it("renders a pending suggestion's op text plus accept/reject controls", () => {
    const el = render([suggestion]);
    expect(el.textContent).toContain("new text");
    expect(el.textContent).toContain("old");
    expect(el.textContent).toContain("Accept");
    expect(el.textContent).toContain("Reject");
  });

  it("shows the empty state when no suggestions are pending", () => {
    const el = render([]);
    expect(el.textContent).toContain("No pending suggestions.");
  });
});
