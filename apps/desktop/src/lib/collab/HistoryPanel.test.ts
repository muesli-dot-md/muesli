// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { mount, unmount, flushSync } from "svelte";
import * as Y from "yjs";
import HistoryPanel from "./HistoryPanel.svelte";
import { CollabStore } from "./collabStore.svelte";
import type { CollabApi, HistoryEntry } from "./collabApi";

const entries: HistoryEntry[] = [
  { first_seq: 10, last_seq: 12, origin: "edit", change_set_id: null, created_at: new Date().toISOString(), author: { id: "u1", display_name: "Ada", kind: "human" } },
  { first_seq: 1, last_seq: 4, origin: "edit", change_set_id: null, created_at: new Date().toISOString(), author: { id: "u2", display_name: "Bo", kind: "human" } },
];

function makeStore(getText: ReturnType<typeof vi.fn>) {
  const api = {
    getComments: vi.fn(async () => ({ threads: [] })),
    getSuggestions: vi.fn(async () => ({ suggestions: [] })),
    getHistory: vi.fn(async () => ({ entries: [] })),
    getText,
  } as unknown as CollabApi;
  const store = new CollabStore(api, new Y.Doc());
  store.history = entries;
  store.historyDone = true;
  store.availability = "ok";
  return store;
}

let host: HTMLElement | undefined;
let component: ReturnType<typeof mount> | undefined;

afterEach(() => {
  if (component) unmount(component);
  host?.remove();
  component = undefined;
  host = undefined;
});

describe("HistoryPanel", () => {
  it("renders the history entries and fetches a snapshot on click", async () => {
    const getText = vi.fn(async (seq?: number) => ({ seq: seq ?? 0, text: "snapshot text" }));
    const store = makeStore(getText);
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(HistoryPanel, { target: host, props: { store } });
    flushSync();

    expect(host.textContent).toContain("Ada");
    expect(host.textContent).toContain("Bo");

    // Click the first entry's card.
    const card = host.querySelector("button") as HTMLButtonElement;
    card.click();
    await Promise.resolve();
    await Promise.resolve();

    // getText is called with the entry's last_seq (12 for the first entry).
    expect(getText).toHaveBeenCalledWith(12);
    expect(store.snapshot?.text).toBe("snapshot text");

    // Closing the snapshot restores the live view (snapshot cleared).
    store.closeSnapshot();
    expect(store.snapshot).toBeNull();
  });

  it("shows the empty state when there is no history", async () => {
    const store = makeStore(vi.fn(async () => ({ seq: 0, text: "" })));
    store.history = [];
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(HistoryPanel, { target: host, props: { store } });
    flushSync();
    // onMount triggers a lazy first-page load (returns []); wait it out so the
    // historyLoading guard clears, then the empty state shows.
    await Promise.resolve();
    await Promise.resolve();
    flushSync();
    expect(host.textContent).toContain("No history yet.");
  });
});
