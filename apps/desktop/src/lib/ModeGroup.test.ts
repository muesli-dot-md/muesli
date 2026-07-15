// @vitest-environment jsdom
// Invariants under test: the mode group is a three-segment WAI-ARIA radiogroup
// with exactly one checked segment at all times (Reading wins while the tab is
// in read mode; otherwise a live store's suggestMode or a pending Suggesting
// intent picks Suggesting vs Editing); the Suggesting segment is aria-disabled
// (still focusable, activation ignored) unless the doc is collab-capable with
// a non-degraded availability; arrows/Home/End move focus WITHOUT selecting
// (selection has side effects — Reading tears the editor down) and Space/Enter
// commit; a Suggesting click made while Reading (store torn down) applies only
// once a recreated store reports healthy availability, and expires on tab
// change, on read mode returning, on auth/volatile, or on a mount that fails
// to produce a store.
import { describe, it, expect, vi, afterEach } from "vitest";
import { mount, unmount, flushSync } from "svelte";
import * as Y from "yjs";
import ModeGroup from "./ModeGroup.svelte";
import { tabs } from "$lib/tabs.svelte";
import { docCollab } from "$lib/collab/docCollab.svelte";
import { CollabStore } from "$lib/collab/collabStore.svelte";
import type { CollabApi } from "$lib/collab/collabApi";

function emptyApi(): CollabApi {
  return {
    getComments: vi.fn(async () => ({ threads: [] })),
    getSuggestions: vi.fn(async () => ({ suggestions: [] })),
  } as unknown as CollabApi;
}

function liveStore(): CollabStore {
  const store = new CollabStore(emptyApi(), new Y.Doc());
  store.availability = "ok";
  return store;
}

/** A store whose availability the server has not answered for yet. */
function unknownStore(): CollabStore {
  return new CollabStore(emptyApi(), new Y.Doc());
}

const NOTE = "/ws/note.md";

let host: HTMLElement | undefined;
let component: ReturnType<typeof mount> | undefined;

afterEach(() => {
  if (component) unmount(component);
  host?.remove();
  component = undefined;
  host = undefined;
  // tabs and docCollab are module singletons — drain them so state can never
  // leak between tests. (docCollab.wireFailures is monotonic by design; the
  // component captures a baseline at arm time, so no reset is needed.)
  for (const t of [...tabs.tabs]) tabs.close(t.id);
  docCollab.reset();
});

function render(): HTMLElement {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(ModeGroup, { target: host });
  flushSync();
  return host;
}

function radios(el: HTMLElement): HTMLButtonElement[] {
  return [...el.querySelectorAll('[role="radio"]')] as HTMLButtonElement[];
}

function checkedLabels(el: HTMLElement): string[] {
  return radios(el)
    .filter((r) => r.getAttribute("aria-checked") === "true")
    .map((r) => r.textContent?.trim() ?? "");
}

function key(el: HTMLElement, k: string): void {
  el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  flushSync();
}

function openRemoteDoc(store: CollabStore | null): void {
  tabs.open(NOTE, "note.md");
  docCollab.set({ slug: "note", isRemote: true, server: "https://example.test" });
  docCollab.store = store;
}

function openLocalDoc(): void {
  tabs.open(NOTE, "note.md");
  docCollab.set({ slug: null, isRemote: false, server: null });
}

describe("ModeGroup", () => {
  it("renders Edit | Read | Suggest with exactly one segment checked", () => {
    openRemoteDoc(liveStore());
    const el = render();
    const group = el.querySelector('[role="radiogroup"]');
    expect(group).not.toBeNull();
    expect(radios(el).map((r) => r.textContent?.trim())).toEqual(["Edit", "Read", "Suggest"]);
    expect(checkedLabels(el)).toEqual(["Edit"]);
  });

  it("clicking Reading flips the tab to read mode; clicking Editing returns to edit", () => {
    openRemoteDoc(liveStore());
    const el = render();
    const [editing, reading] = radios(el);

    reading.click();
    flushSync();
    expect(tabs.active()?.mode).toBe("read");
    expect(checkedLabels(el)).toEqual(["Read"]);

    editing.click();
    flushSync();
    expect(tabs.active()?.mode).toBe("edit");
    expect(checkedLabels(el)).toEqual(["Edit"]);
  });

  it("clicking Suggesting sets suggestMode with read mode off; Editing clears it", () => {
    const store = liveStore();
    openRemoteDoc(store);
    const el = render();
    const [editing, , suggesting] = radios(el);

    suggesting.click();
    flushSync();
    expect(tabs.active()?.mode).toBe("edit");
    expect(store.suggestMode).toBe(true);
    expect(checkedLabels(el)).toEqual(["Suggest"]);

    editing.click();
    flushSync();
    expect(tabs.active()?.mode).toBe("edit");
    expect(store.suggestMode).toBe(false);
    expect(checkedLabels(el)).toEqual(["Edit"]);
  });

  it("Reading wins over a live store still in suggest mode", () => {
    const store = liveStore();
    store.suggestMode = true;
    openRemoteDoc(store);
    tabs.setMode(NOTE, "read");
    const el = render();
    expect(checkedLabels(el)).toEqual(["Read"]);
  });

  it("marks Suggesting aria-disabled (focusable, title present) for a local-only doc and ignores activation", () => {
    openLocalDoc();
    const el = render();
    const [editing, reading, suggesting] = radios(el);

    expect(suggesting.getAttribute("aria-disabled")).toBe("true");
    // NOT the disabled attribute: focus, hover, and the title tooltip keep
    // working so the reason stays perceivable.
    expect(suggesting.disabled).toBe(false);
    expect(suggesting.title).toContain("synced");
    expect(editing.hasAttribute("aria-disabled")).toBe(false);
    expect(reading.hasAttribute("aria-disabled")).toBe(false);

    suggesting.click();
    flushSync();
    expect(tabs.active()?.mode).toBe("edit");
    expect(checkedLabels(el)).toEqual(["Edit"]);
    key(suggesting, "Enter");
    expect(checkedLabels(el)).toEqual(["Edit"]);

    reading.click();
    flushSync();
    expect(tabs.active()?.mode).toBe("read");
    expect(checkedLabels(el)).toEqual(["Read"]);
  });

  it("marks Suggesting aria-disabled while the store is auth-degraded", () => {
    const store = liveStore();
    store.availability = "auth";
    openRemoteDoc(store);
    const el = render();
    expect(radios(el)[2].getAttribute("aria-disabled")).toBe("true");
  });

  it("keeps Suggesting disabled during Reading when the doc was degraded before entering", () => {
    const store = liveStore();
    store.availability = "auth";
    openRemoteDoc(store);
    const el = render();

    // Entering Reading tears the editor (and store) down; the last-known
    // availability must keep gating the segment.
    tabs.setMode(NOTE, "read");
    docCollab.store = null;
    flushSync();
    expect(checkedLabels(el)).toEqual(["Read"]);
    expect(radios(el)[2].getAttribute("aria-disabled")).toBe("true");
  });

  it("moves the Tab stop off a checked Suggesting segment that degrades to disabled", () => {
    const store = liveStore();
    openRemoteDoc(store);
    const el = render();
    const [editing, , suggesting] = radios(el);

    suggesting.click();
    flushSync();
    expect(suggesting.tabIndex).toBe(0);

    store.availability = "auth";
    flushSync();
    // The doc is still in suggest mode (checked), but the segment is no longer
    // operable — the group's single Tab stop falls back to Editing so the
    // radiogroup never drops out of the Tab order.
    expect(checkedLabels(el)).toEqual(["Suggest"]);
    expect(suggesting.getAttribute("aria-disabled")).toBe("true");
    expect(editing.tabIndex).toBe(0);
    expect(suggesting.tabIndex).toBe(-1);
  });

  it("applies a Suggesting click made while Reading once the recreated store is known-good", () => {
    // Reading tears the editor (and collab store) down: store is null but the
    // doc context stays remote, so the segment must remain clickable.
    openRemoteDoc(null);
    tabs.setMode(NOTE, "read");
    const el = render();
    const suggesting = radios(el)[2];
    expect(suggesting.hasAttribute("aria-disabled")).toBe(false);

    suggesting.click();
    flushSync();
    // Read mode is off immediately; the checked segment already reads
    // Suggesting (pending intent) — never a flicker through Editing.
    expect(tabs.active()?.mode).toBe("edit");
    expect(checkedLabels(el)).toEqual(["Suggest"]);

    // The editor remounts and wires a fresh store — the intent lands on it.
    const store = liveStore();
    docCollab.store = store;
    flushSync();
    expect(store.suggestMode).toBe(true);
    expect(checkedLabels(el)).toEqual(["Suggest"]);
  });

  it("full Reading -> Suggesting round-trip through EditorPane's real docCollab lifecycle", () => {
    // Mirrors what EditorPane actually does at each transition — including the
    // docCollab.reset() its edit-mount cleanup runs when Reading is entered —
    // rather than handing ModeGroup a pre-shaped context.
    const first = liveStore();
    openRemoteDoc(first);
    const el = render();

    // User clicks Reading. EditorPane: edit-run cleanup resets the context,
    // then the read-branch re-publishes it (store stays torn down).
    radios(el)[1].click();
    docCollab.reset();
    docCollab.set({ slug: "note", isRemote: true, server: "https://example.test" });
    flushSync();
    expect(checkedLabels(el)).toEqual(["Read"]);
    const suggesting = radios(el)[2];
    expect(suggesting.hasAttribute("aria-disabled")).toBe(false);

    // User clicks Suggesting. EditorPane remounts the editor (read-run had no
    // cleanup), re-publishes the context, and the store lands async with its
    // availability still unprobed.
    suggesting.click();
    docCollab.set({ slug: "note", isRemote: true, server: "https://example.test" });
    flushSync();
    expect(tabs.active()?.mode).toBe("edit");
    expect(checkedLabels(el)).toEqual(["Suggest"]);

    const store = unknownStore();
    docCollab.store = store;
    flushSync();
    expect(store.suggestMode).toBe(true);
    expect(checkedLabels(el)).toEqual(["Suggest"]);
  });

  it("applies the pending intent to a store whose availability is still unknown (same gate as a direct click)", () => {
    openRemoteDoc(null);
    tabs.setMode(NOTE, "read");
    const el = render();
    radios(el)[2].click();
    flushSync();

    // Fresh store still probing the server: "unknown" is not a blocker — a
    // server that never answers cleanly keeps availability "unknown" forever
    // (refresh() retains the last state on network errors), and the direct
    // click path applies under exactly this condition. Waiting for "ok" here
    // would deadlock the Reading -> Suggesting path on such servers.
    const store = unknownStore();
    docCollab.store = store;
    flushSync();
    expect(store.suggestMode).toBe(true);
    expect(checkedLabels(el)).toEqual(["Suggest"]);
  });

  it("drops the pending intent when the store lands already degraded, falling back to Editing", () => {
    openRemoteDoc(null);
    tabs.setMode(NOTE, "read");
    const el = render();
    radios(el)[2].click();
    flushSync();

    const store = unknownStore();
    store.availability = "auth";
    docCollab.store = store;
    flushSync();
    expect(store.suggestMode).toBe(false);
    expect(checkedLabels(el)).toEqual(["Edit"]);
    expect(radios(el)[2].getAttribute("aria-disabled")).toBe("true");
  });

  it("clears the pending intent when the tab returns to read mode from any path (the ⌘E leak)", () => {
    openRemoteDoc(null);
    tabs.setMode(NOTE, "read");
    const el = render();
    radios(el)[2].click();
    flushSync();
    expect(tabs.active()?.mode).toBe("edit");

    // ⌘E back to Reading before the async store wire ever completed.
    tabs.toggleMode(NOTE);
    flushSync();
    expect(checkedLabels(el)).toEqual(["Read"]);

    // A later plain ⌘E exit must land in Editing: the stale intent may not
    // apply suggest mode from a pure keyboard toggle.
    tabs.toggleMode(NOTE);
    flushSync();
    const store = liveStore();
    docCollab.store = store;
    flushSync();
    expect(store.suggestMode).toBe(false);
    expect(checkedLabels(el)).toEqual(["Edit"]);
  });

  it("expires the pending intent when the mount completes without producing a store", () => {
    openRemoteDoc(null);
    tabs.setMode(NOTE, "read");
    const el = render();
    radios(el)[2].click();
    flushSync();
    expect(checkedLabels(el)).toEqual(["Suggest"]);

    // EditorPane signals that the mount failed (session attach / disk read):
    // the intent must stop rendering a checked segment it can never honor.
    docCollab.markWireFailed();
    flushSync();
    expect(checkedLabels(el)).toEqual(["Edit"]);

    // A store from a LATER mount must not receive the expired intent.
    const store = liveStore();
    docCollab.store = store;
    flushSync();
    expect(store.suggestMode).toBe(false);
  });

  it("drops the pending Suggesting intent when the active tab changes first", () => {
    openRemoteDoc(null);
    tabs.setMode(NOTE, "read");
    const el = render();
    radios(el)[2].click();
    flushSync();

    tabs.open("/ws/other.md", "other.md");
    flushSync();
    const store = liveStore();
    docCollab.store = store;
    flushSync();
    expect(store.suggestMode).toBe(false);
  });

  it("tracks an external mode change (the ⌘E toggle path) without a click", () => {
    openRemoteDoc(liveStore());
    const el = render();
    expect(checkedLabels(el)).toEqual(["Edit"]);

    // AppShell's keymap/palette command flips the same tabs state directly.
    tabs.toggleMode(NOTE);
    flushSync();
    expect(checkedLabels(el)).toEqual(["Read"]);

    tabs.toggleMode(NOTE);
    flushSync();
    expect(checkedLabels(el)).toEqual(["Edit"]);
  });

  it("moves focus without selecting on arrows; Space/Enter commit the focused segment", () => {
    openRemoteDoc(liveStore());
    const el = render();
    const [editing, reading, suggesting] = radios(el);

    editing.focus();
    key(editing, "ArrowRight");
    // Focus moved; selection did NOT follow (selecting Reading tears the whole
    // editor down, so it must be an explicit commit).
    expect(document.activeElement).toBe(reading);
    expect(tabs.active()?.mode).toBe("edit");
    expect(checkedLabels(el)).toEqual(["Edit"]);

    key(reading, "ArrowRight");
    expect(document.activeElement).toBe(suggesting);
    expect(checkedLabels(el)).toEqual(["Edit"]);

    // Wraps past the end back to the first segment.
    key(suggesting, "ArrowRight");
    expect(document.activeElement).toBe(editing);

    key(editing, "ArrowRight");
    key(reading, "Enter");
    expect(tabs.active()?.mode).toBe("read");
    expect(checkedLabels(el)).toEqual(["Read"]);

    key(reading, "ArrowLeft");
    expect(document.activeElement).toBe(editing);
    expect(checkedLabels(el)).toEqual(["Read"]);
    key(editing, " ");
    expect(tabs.active()?.mode).toBe("edit");
    expect(checkedLabels(el)).toEqual(["Edit"]);
  });

  it("lets arrows focus an aria-disabled Suggesting segment but ignores committing it", () => {
    openLocalDoc();
    const el = render();
    const [, reading, suggesting] = radios(el);

    reading.focus();
    key(reading, "ArrowRight");
    // aria-disabled keeps the segment perceivable: focus may land on it (the
    // title/reason is announced), only activation is ignored.
    expect(document.activeElement).toBe(suggesting);
    key(suggesting, " ");
    expect(checkedLabels(el)).toEqual(["Edit"]);
    expect(tabs.active()?.mode).toBe("edit");
  });

  it("Home/End jump focus to the first/last segment without selecting", () => {
    openRemoteDoc(liveStore());
    const el = render();
    const [editing, , suggesting] = radios(el);

    editing.focus();
    key(editing, "End");
    expect(document.activeElement).toBe(suggesting);
    expect(checkedLabels(el)).toEqual(["Edit"]);

    key(suggesting, "Home");
    expect(document.activeElement).toBe(editing);
    expect(checkedLabels(el)).toEqual(["Edit"]);
  });
});
