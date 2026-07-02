import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---- mocks (registered before the module under test is imported) -----------
// House pattern: see keychainConsent.test.ts — vi.mock module fakes + a fresh
// module import per test (the store is a singleton with timer/handle state).

const check = vi.fn();
vi.mock("@tauri-apps/plugin-updater", () => ({
  check: (...args: unknown[]) => check(...args),
}));

const relaunch = vi.fn();
vi.mock("@tauri-apps/plugin-process", () => ({
  relaunch: (...args: unknown[]) => relaunch(...args),
}));

// Mutable settings fake mirroring the real store's autoUpdate surface.
const settingsState = {
  autoUpdate: true,
  setAutoUpdate: vi.fn((v: boolean) => {
    settingsState.autoUpdate = v;
  }),
};
vi.mock("$lib/settings.svelte", () => ({ settings: settingsState }));

// ---- helpers ----------------------------------------------------------------

type DownloadEvent =
  | { event: "Started"; data: { contentLength?: number } }
  | { event: "Progress"; data: { chunkLength: number } }
  | { event: "Finished" };
type DownloadHandler = (event: DownloadEvent) => void;

/** A fake Update handle matching the plugin's surface the store uses. */
function fakeUpdate(version = "0.2.0") {
  return {
    version,
    download: vi.fn(async (onEvent?: DownloadHandler) => {
      onEvent?.({ event: "Started", data: { contentLength: 100 } });
      onEvent?.({ event: "Progress", data: { chunkLength: 60 } });
      onEvent?.({ event: "Progress", data: { chunkLength: 40 } });
      onEvent?.({ event: "Finished" });
    }),
    install: vi.fn(async () => {}),
  };
}

async function freshUpdates() {
  vi.resetModules();
  const mod = await import("./updates.svelte");
  return mod.updates;
}

const TEN_S = 10_000;
const FOUR_H = 4 * 60 * 60 * 1000;

beforeEach(() => {
  vi.useFakeTimers();
  check.mockReset();
  relaunch.mockReset();
  relaunch.mockResolvedValue(undefined);
  settingsState.autoUpdate = true;
});

afterEach(() => {
  vi.useRealTimers();
});

// ---- tests --------------------------------------------------------------------

describe("dev builds", () => {
  it("start(true): stays idle forever, never checks, exactly one debug line", async () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    const updates = await freshUpdates();
    updates.start(true);
    await vi.advanceTimersByTimeAsync(FOUR_H * 2);
    expect(updates.state).toBe("idle");
    expect(updates.pillVisible).toBe(false);
    expect(check).not.toHaveBeenCalled();
    expect(debug).toHaveBeenCalledTimes(1);
    debug.mockRestore();
  });
});

describe("scheduling", () => {
  it("first check runs after the ~10s launch delay, not before", async () => {
    check.mockResolvedValue(null);
    const updates = await freshUpdates();
    updates.start(false);
    await vi.advanceTimersByTimeAsync(TEN_S - 1);
    expect(check).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(check).toHaveBeenCalledTimes(1);
    expect(updates.state).toBe("idle"); // no update found → back to idle
    updates.stop();
  });

  it("re-checks every 4 hours", async () => {
    check.mockResolvedValue(null);
    const updates = await freshUpdates();
    updates.start(false);
    await vi.advanceTimersByTimeAsync(TEN_S);
    expect(check).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(FOUR_H);
    expect(check).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(FOUR_H);
    expect(check).toHaveBeenCalledTimes(3);
    updates.stop();
  });

  it("stop() cancels both timers", async () => {
    check.mockResolvedValue(null);
    const updates = await freshUpdates();
    updates.start(false);
    updates.stop();
    await vi.advanceTimersByTimeAsync(FOUR_H * 2);
    expect(check).not.toHaveBeenCalled();
  });

  it("a scheduled tick is skipped while a download is in flight", async () => {
    let resolveDownload!: () => void;
    const update = {
      version: "0.2.0",
      download: vi.fn(
        (_onEvent?: DownloadHandler) =>
          new Promise<void>((res) => {
            resolveDownload = res;
          }),
      ),
      install: vi.fn(async () => {}),
    };
    check.mockResolvedValue(update);
    const updates = await freshUpdates();
    updates.start(false);
    await vi.advanceTimersByTimeAsync(TEN_S); // check #1 → downloading (hangs)
    expect(updates.state).toBe("downloading");
    await vi.advanceTimersByTimeAsync(FOUR_H); // tick during download
    expect(check).toHaveBeenCalledTimes(1); // skipped
    resolveDownload();
    await vi.advanceTimersByTimeAsync(0);
    expect(updates.state).toBe("ready");
    updates.stop();
  });

  it("once ready, later cycles do not re-check (update already staged)", async () => {
    check.mockResolvedValue(fakeUpdate());
    const updates = await freshUpdates();
    updates.start(false);
    await vi.advanceTimersByTimeAsync(TEN_S);
    expect(updates.state).toBe("ready");
    await vi.advanceTimersByTimeAsync(FOUR_H);
    expect(check).toHaveBeenCalledTimes(1);
    updates.stop();
  });
});

describe("auto-download path (settings.autoUpdate = true, the default)", () => {
  it("available flows straight into downloading and lands ready with version + progress", async () => {
    const update = fakeUpdate("0.2.0");
    check.mockResolvedValue(update);
    const updates = await freshUpdates();
    updates.start(false);
    await vi.advanceTimersByTimeAsync(TEN_S);
    expect(update.download).toHaveBeenCalledTimes(1);
    expect(updates.state).toBe("ready");
    expect(updates.version).toBe("0.2.0");
    expect(updates.progress).toEqual({ downloaded: 100, total: 100 });
    expect(updates.pillVisible).toBe(true); // pill appears only at READY
    updates.stop();
  });

  it("pill stays hidden while the silent download is in flight", async () => {
    let resolveDownload!: () => void;
    const update = {
      version: "0.2.0",
      download: vi.fn(
        (_onEvent?: DownloadHandler) =>
          new Promise<void>((res) => {
            resolveDownload = res;
          }),
      ),
      install: vi.fn(async () => {}),
    };
    check.mockResolvedValue(update);
    const updates = await freshUpdates();
    updates.start(false);
    await vi.advanceTimersByTimeAsync(TEN_S);
    expect(updates.state).toBe("downloading");
    expect(updates.pillVisible).toBe(false); // silent — never interrupt writing
    resolveDownload();
    await vi.advanceTimersByTimeAsync(0);
    expect(updates.pillVisible).toBe(true);
    updates.stop();
  });
});

describe("manual path (settings.autoUpdate = false)", () => {
  it("stops at available: pill visible, nothing downloaded", async () => {
    settingsState.autoUpdate = false;
    const update = fakeUpdate("0.3.0");
    check.mockResolvedValue(update);
    const updates = await freshUpdates();
    updates.start(false);
    await vi.advanceTimersByTimeAsync(TEN_S);
    expect(updates.state).toBe("available");
    expect(updates.version).toBe("0.3.0");
    expect(update.download).not.toHaveBeenCalled();
    expect(updates.pillVisible).toBe(true);
    updates.stop();
  });

  it("installAndRelaunch from available: downloads with progress, installs, relaunches", async () => {
    settingsState.autoUpdate = false;
    const update = fakeUpdate("0.3.0");
    check.mockResolvedValue(update);
    const updates = await freshUpdates();
    updates.start(false);
    await vi.advanceTimersByTimeAsync(TEN_S);
    await updates.installAndRelaunch();
    expect(update.download).toHaveBeenCalledTimes(1);
    expect(updates.progress).toEqual({ downloaded: 100, total: 100 });
    expect(update.install).toHaveBeenCalledTimes(1);
    expect(relaunch).toHaveBeenCalledTimes(1);
    updates.stop();
  });
});

describe("failures — always console.warn-silent, retried next cycle", () => {
  it("check failure: warn, state error, NO pill; next 4h tick retries and recovers", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    check.mockRejectedValueOnce(new Error("offline"));
    check.mockResolvedValueOnce(null);
    const updates = await freshUpdates();
    updates.start(false);
    await vi.advanceTimersByTimeAsync(TEN_S);
    expect(updates.state).toBe("error");
    expect(updates.pillVisible).toBe(false); // check/download errors show no UI
    expect(warn).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(FOUR_H);
    expect(check).toHaveBeenCalledTimes(2);
    expect(updates.state).toBe("idle"); // recovered
    updates.stop();
    warn.mockRestore();
  });

  it("silent download failure: warn, state error, no pill, retried next cycle", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const update = fakeUpdate("0.2.0");
    update.download.mockRejectedValueOnce(new Error("rate-limited"));
    check.mockResolvedValue(update);
    const updates = await freshUpdates();
    updates.start(false);
    await vi.advanceTimersByTimeAsync(TEN_S);
    expect(updates.state).toBe("error");
    expect(updates.pillVisible).toBe(false);
    await vi.advanceTimersByTimeAsync(FOUR_H); // retry: check again, download succeeds
    expect(updates.state).toBe("ready");
    updates.stop();
    warn.mockRestore();
  });

  it("install failure: surfaces 'Update failed — will retry later', pill stays up, no relaunch", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const update = fakeUpdate("0.2.0");
    update.install.mockRejectedValue(new Error("disk"));
    check.mockResolvedValue(update);
    const updates = await freshUpdates();
    updates.start(false);
    await vi.advanceTimersByTimeAsync(TEN_S); // auto-downloads to ready
    await updates.installAndRelaunch();
    expect(updates.state).toBe("error");
    expect(updates.failureMessage).toBe("Update failed — will retry later");
    expect(updates.pillVisible).toBe(true); // error surfaces in the popover
    expect(relaunch).not.toHaveBeenCalled();
    updates.stop();
    warn.mockRestore();
  });

  it("relaunch failure: warn only — app keeps running with the update staged (ready)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    relaunch.mockRejectedValue(new Error("spawn failed"));
    const update = fakeUpdate("0.2.0");
    check.mockResolvedValue(update);
    const updates = await freshUpdates();
    updates.start(false);
    await vi.advanceTimersByTimeAsync(TEN_S);
    await expect(updates.installAndRelaunch()).resolves.toBeUndefined();
    expect(update.install).toHaveBeenCalledTimes(1);
    expect(updates.state).toBe("ready"); // applies on the next manual quit/launch
    expect(warn).toHaveBeenCalled();
    updates.stop();
    warn.mockRestore();
  });
});
