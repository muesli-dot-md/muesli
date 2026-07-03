import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Capture the structure-event handler the store registers so the test can drive it.
let structureHandler: ((evt: any) => void) | null = null;
const unlisten = vi.fn();

const startWorkspaceSync = vi.fn(async () => {});
const stopWorkspaceSync = vi.fn(async () => {});
const workspaceSyncStatus = vi.fn(async () => ({
  running: true,
  dir: "/ws",
  files: 3,
  last_activity: null,
  events: 0,
  error: null,
}));
const onStructureEvent = vi.fn(async (h: (evt: any) => void) => {
  structureHandler = h;
  return unlisten;
});
const refresh = vi.fn(async () => {});

vi.mock("$lib/tauri", () => ({
  startWorkspaceSync,
  stopWorkspaceSync,
  workspaceSyncStatus,
  onStructureEvent,
}));
vi.mock("$lib/workspace.svelte", () => ({ workspace: { refresh } }));

// Import AFTER the mocks are registered.
const { daemon } = await import("./daemon.svelte");

describe("DaemonStore push subscription", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    structureHandler = null;
    startWorkspaceSync.mockClear();
    stopWorkspaceSync.mockClear();
    workspaceSyncStatus.mockClear();
    onStructureEvent.mockClear();
    unlisten.mockClear();
    refresh.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("populates status once and subscribes on start (no recurring poll)", async () => {
    await daemon.start("http://s", "/ws", "w1");
    expect(startWorkspaceSync).toHaveBeenCalledWith("http://s", "/ws", "w1");
    expect(workspaceSyncStatus).toHaveBeenCalledTimes(1);
    expect(onStructureEvent).toHaveBeenCalledTimes(1);
    // Advance well past any old 1s poll interval: status must NOT be re-fetched.
    await vi.advanceTimersByTimeAsync(5000);
    expect(workspaceSyncStatus).toHaveBeenCalledTimes(1);
    await daemon.stop();
  });

  it("debounces a structural event into a single workspace.refresh()", async () => {
    await daemon.start("http://s", "/ws", "w1");
    refresh.mockClear();
    structureHandler!({ kind: "doc_created", slug: "a", folder_id: null, title: "A" });
    structureHandler!({ kind: "folder_renamed", id: "f1", name: "F" });
    expect(refresh).not.toHaveBeenCalled(); // still within debounce window
    await vi.advanceTimersByTimeAsync(200);
    expect(refresh).toHaveBeenCalledTimes(1); // coalesced
    await daemon.stop();
  });

  it("ignores doc_updated (content-only, not structural)", async () => {
    await daemon.start("http://s", "/ws", "w1");
    refresh.mockClear();
    structureHandler!({ kind: "doc_updated", slug: "a" });
    await vi.advanceTimersByTimeAsync(200);
    expect(refresh).not.toHaveBeenCalled();
    await daemon.stop();
  });

  it("unsubscribes and clears status on stop", async () => {
    await daemon.start("http://s", "/ws", "w1");
    await daemon.stop();
    expect(unlisten).toHaveBeenCalledTimes(1);
    expect(stopWorkspaceSync).toHaveBeenCalledTimes(1);
    expect(daemon.status).toBeNull();
  });
});
