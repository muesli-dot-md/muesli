import { describe, it, expect } from "vitest";
import { createTabsStore } from "./tabs.svelte";

describe("tabs store", () => {
  it("open dedupes: opening the same path twice does not add a second tab", () => {
    const s = createTabsStore();
    s.open("/workspace/note.md", "note.md");
    s.open("/workspace/note.md", "note.md");
    expect(s.tabs).toHaveLength(1);
  });

  it("open activates: opening a new path makes it active", () => {
    const s = createTabsStore();
    s.open("/workspace/a.md", "a.md");
    expect(s.activeId).toBe("/workspace/a.md");
    s.open("/workspace/b.md", "b.md");
    expect(s.activeId).toBe("/workspace/b.md");
  });

  it("open dedupes: opening existing path focuses it without duplicating", () => {
    const s = createTabsStore();
    s.open("/workspace/a.md", "a.md");
    s.open("/workspace/b.md", "b.md");
    // Focus back on a
    s.open("/workspace/a.md", "a.md");
    expect(s.tabs).toHaveLength(2);
    expect(s.activeId).toBe("/workspace/a.md");
  });

  it("close: closing the active tab prefers the previous tab", () => {
    const s = createTabsStore();
    s.open("/workspace/a.md", "a.md");
    s.open("/workspace/b.md", "b.md");
    s.open("/workspace/c.md", "c.md");
    // Active is c (index 2); close it → should select b (index 1)
    s.close("/workspace/c.md");
    expect(s.tabs).toHaveLength(2);
    expect(s.activeId).toBe("/workspace/b.md");
  });

  it("close: closing the first tab selects the next tab", () => {
    const s = createTabsStore();
    s.open("/workspace/a.md", "a.md");
    s.open("/workspace/b.md", "b.md");
    s.activate("/workspace/a.md");
    s.close("/workspace/a.md");
    expect(s.tabs).toHaveLength(1);
    expect(s.activeId).toBe("/workspace/b.md");
  });

  it("close: closing the last tab sets activeId to null", () => {
    const s = createTabsStore();
    s.open("/workspace/a.md", "a.md");
    s.close("/workspace/a.md");
    expect(s.tabs).toHaveLength(0);
    expect(s.activeId).toBeNull();
  });

  it("close: closing a non-active tab does not change activeId", () => {
    const s = createTabsStore();
    s.open("/workspace/a.md", "a.md");
    s.open("/workspace/b.md", "b.md");
    s.close("/workspace/a.md");
    expect(s.activeId).toBe("/workspace/b.md");
    expect(s.tabs).toHaveLength(1);
  });

  it("setDirty: toggles the dirty flag correctly", () => {
    const s = createTabsStore();
    s.open("/workspace/a.md", "a.md");
    expect(s.tabs[0].dirty).toBe(false);
    s.setDirty("/workspace/a.md", true);
    expect(s.tabs[0].dirty).toBe(true);
    s.setDirty("/workspace/a.md", false);
    expect(s.tabs[0].dirty).toBe(false);
  });

  it("setDirty: no-op when the value is unchanged (no array/tab churn)", () => {
    const s = createTabsStore();
    s.open("/workspace/a.md", "a.md");
    const tabBefore = s.active();
    // dirty is already false → must NOT rebuild the tab object
    s.setDirty("/workspace/a.md", false);
    expect(s.active()).toBe(tabBefore);
    // flip to true → new object
    s.setDirty("/workspace/a.md", true);
    const dirtyTab = s.active();
    expect(dirtyTab).not.toBe(tabBefore);
    // already true → no-op, same object (this is the per-keystroke hot path)
    s.setDirty("/workspace/a.md", true);
    expect(s.active()).toBe(dirtyTab);
  });

  it("active() returns the correct Tab", () => {
    const s = createTabsStore();
    s.open("/workspace/a.md", "a.md");
    s.open("/workspace/b.md", "b.md");
    expect(s.active()?.id).toBe("/workspace/b.md");
    expect(s.active()?.name).toBe("b.md");
  });

  it("active() returns null when no tabs are open", () => {
    const s = createTabsStore();
    expect(s.active()).toBeNull();
  });

  it("close: invokes registered flush callback for the closed tab", () => {
    const s = createTabsStore();
    s.open("/workspace/a.md", "a.md");
    let called = false;
    s.registerFlush("/workspace/a.md", () => {
      called = true;
    });
    s.close("/workspace/a.md");
    expect(called).toBe(true);
  });

  it("close: does not invoke flush callback after unregister", () => {
    const s = createTabsStore();
    s.open("/workspace/a.md", "a.md");
    let called = false;
    s.registerFlush("/workspace/a.md", () => {
      called = true;
    });
    s.unregisterFlush("/workspace/a.md");
    s.close("/workspace/a.md");
    expect(called).toBe(false);
  });

  it("flush: a folder path flushes every open tab underneath it", async () => {
    const s = createTabsStore();
    s.open("/ws/dir/a.md", "a.md");
    s.open("/ws/dir/sub/b.md", "b.md");
    s.open("/ws/dirty.md", "dirty.md"); // shares the string prefix, NOT the folder
    const flushed: string[] = [];
    s.registerFlush("/ws/dir/a.md", () => {
      flushed.push("a");
    });
    s.registerFlush("/ws/dir/sub/b.md", () => {
      flushed.push("b");
    });
    s.registerFlush("/ws/dirty.md", () => {
      flushed.push("dirty");
    });
    await s.flush("/ws/dir");
    expect(flushed.sort()).toEqual(["a", "b"]);
  });

  it("flush: awaits the registered callback and no-ops for unknown ids", async () => {
    const s = createTabsStore();
    s.open("/workspace/a.md", "a.md");
    let settled = false;
    s.registerFlush("/workspace/a.md", async () => {
      await Promise.resolve();
      settled = true;
    });
    await s.flush("/workspace/a.md");
    expect(settled).toBe(true);
    await expect(s.flush("/workspace/nope.md")).resolves.toBeUndefined();
  });

  it("retarget: re-keys a renamed file's tab and keeps it active", () => {
    const s = createTabsStore();
    s.open("/ws/old.md", "old.md");
    s.retarget("/ws/old.md", "/ws/new.md");
    expect(s.tabs).toHaveLength(1);
    expect(s.tabs[0].id).toBe("/ws/new.md");
    expect(s.tabs[0].path).toBe("/ws/new.md");
    expect(s.tabs[0].name).toBe("new.md");
    expect(s.activeId).toBe("/ws/new.md");
  });

  it("retarget: re-keys tabs under a renamed folder (prefix move)", () => {
    const s = createTabsStore();
    s.open("/ws/dir/a.md", "a.md");
    s.open("/ws/dir/sub/b.md", "b.md");
    s.open("/ws/dirty.md", "dirty.md"); // shares the string prefix, NOT the folder
    s.retarget("/ws/dir", "/ws/renamed");
    const paths = s.tabs.map((t) => t.path);
    expect(paths).toContain("/ws/renamed/a.md");
    expect(paths).toContain("/ws/renamed/sub/b.md");
    expect(paths).toContain("/ws/dirty.md");
  });

  it("retarget: drops the old flush registration (its saver targets the old path)", () => {
    const s = createTabsStore();
    s.open("/ws/old.md", "old.md");
    let called = false;
    s.registerFlush("/ws/old.md", () => {
      called = true;
    });
    s.retarget("/ws/old.md", "/ws/new.md");
    s.close("/ws/new.md");
    expect(called).toBe(false);
  });

  it("retarget: no-op when no tab matches", () => {
    const s = createTabsStore();
    s.open("/ws/a.md", "a.md");
    const before = s.tabs;
    s.retarget("/ws/other.md", "/ws/moved.md");
    expect(s.tabs).toBe(before);
  });
});
