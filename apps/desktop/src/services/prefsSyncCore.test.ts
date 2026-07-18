// prefsSyncCore invariants: sparse apply (absent server keys never yank local
// defaults), the echo-loop guard (an applied server value must never PATCH back
// out), dirty-key protection (a mid-flight edit or a failed PATCH is never
// clobbered or absorbed by a GET), round-trip serialization (a flush never
// overlaps another flush or a GET — the overlap cases re-materialized or
// resurrected deleted keys), debounce coalescing, refresh coalescing,
// null-flushing explicit resets, and silent-failure retry. This file is
// IDENTICAL in apps/web/src and apps/desktop/src/lib — mirror any change.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPrefsSync,
  diffPrefs,
  pickKnown,
  type Prefs,
  type PrefsPatch,
} from "./prefsSyncCore";

/** A stand-in for the real stores: a plain object the engine reads/applies. */
function makeHarness(initial: Prefs, opts?: { failPatch?: boolean }) {
  const local: Prefs = { ...initial };
  const sendPatch = vi.fn((patch: PrefsPatch) => {
    if (opts?.failPatch) return Promise.reject(new Error("offline"));
    return Promise.resolve({ ...patch });
  });
  const fetchRemote = vi.fn(() => Promise.resolve({} as Record<string, unknown>));
  const engine = createPrefsSync({
    read: () => ({ ...local }),
    apply: (present) => Object.assign(local, present),
    fetchRemote,
    sendPatch,
  });
  return { local, engine, sendPatch, fetchRemote };
}

const DEFAULTS: Prefs = {
  theme: "system",
  accent: "gray",
  tint_strength: 0,
  tint_hue: 244,
  folder_hue: 262,
};

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("diffPrefs / pickKnown", () => {
  it("diffs only the changed keys", () => {
    expect(diffPrefs(DEFAULTS, DEFAULTS)).toEqual({});
    expect(diffPrefs({ ...DEFAULTS, theme: "dark", tint_hue: 100 }, DEFAULTS)).toEqual({
      theme: "dark",
      tint_hue: 100,
    });
  });

  it("picks only known primitively-typed keys from a server object", () => {
    expect(
      pickKnown({
        theme: "dark",
        folder_hue: 120,
        unknown_key: "x",
        tint_hue: null,
        accent: { nested: true },
      }),
    ).toEqual({ theme: "dark", folder_hue: 120 });
  });
});

describe("createPrefsSync", () => {
  it("applies only present server keys on refresh — absent keys keep local defaults", async () => {
    const { local, engine, fetchRemote } = makeHarness(DEFAULTS);
    fetchRemote.mockResolvedValueOnce({ theme: "dark", folder_hue: 44 });
    await engine.refresh();
    expect(local).toEqual({ ...DEFAULTS, theme: "dark", folder_hue: 44 });
  });

  it("never echoes an applied server value back as a PATCH", async () => {
    const { engine, fetchRemote, sendPatch } = makeHarness(DEFAULTS);
    fetchRemote.mockResolvedValueOnce({ accent: "amber", tint_strength: 80 });
    await engine.refresh();
    // The store watchers fire on any value change, applied-from-server or not —
    // the engine must recognize this one as clean and send nothing.
    engine.onLocalChange();
    await vi.runAllTimersAsync();
    expect(sendPatch).not.toHaveBeenCalled();
  });

  it("does not push local defaults at boot when the server object is empty", async () => {
    const { engine, sendPatch } = makeHarness(DEFAULTS);
    await engine.refresh();
    engine.onLocalChange();
    await vi.runAllTimersAsync();
    expect(sendPatch).not.toHaveBeenCalled();
  });

  it("debounces local edits into one PATCH carrying only the changed keys", async () => {
    const { local, engine, sendPatch } = makeHarness(DEFAULTS);
    local.theme = "dark";
    engine.onLocalChange();
    await vi.advanceTimersByTimeAsync(500);
    local.tint_hue = 140;
    engine.onLocalChange();
    // 500ms after the second edit: still within the (reset) debounce window.
    await vi.advanceTimersByTimeAsync(500);
    expect(sendPatch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);
    expect(sendPatch).toHaveBeenCalledTimes(1);
    expect(sendPatch).toHaveBeenCalledWith({ theme: "dark", tint_hue: 140 });
  });

  it("sends nothing when an edit is reverted before the debounce fires", async () => {
    const { local, engine, sendPatch } = makeHarness(DEFAULTS);
    local.accent = "blue";
    engine.onLocalChange();
    local.accent = "gray";
    engine.onLocalChange();
    await vi.runAllTimersAsync();
    expect(sendPatch).not.toHaveBeenCalled();
  });

  it("keeps a failed PATCH dirty and retries it on the next change", async () => {
    const harness = makeHarness(DEFAULTS, { failPatch: true });
    harness.local.theme = "light";
    harness.engine.onLocalChange();
    await vi.runAllTimersAsync();
    expect(harness.sendPatch).toHaveBeenCalledTimes(1);

    // Back online: a later edit re-flushes BOTH the old and the new key.
    harness.sendPatch.mockImplementation((patch: PrefsPatch) => Promise.resolve({ ...patch }));
    harness.local.folder_hue = 199;
    harness.engine.onLocalChange();
    await vi.runAllTimersAsync();
    expect(harness.sendPatch).toHaveBeenLastCalledWith({ theme: "light", folder_hue: 199 });

    // ...after which everything is clean again.
    harness.engine.onLocalChange();
    await vi.runAllTimersAsync();
    expect(harness.sendPatch).toHaveBeenCalledTimes(2);
  });

  it("does not flip-flop a failed PATCH when the following GET succeeds", async () => {
    const harness = makeHarness(DEFAULTS, { failPatch: true });
    harness.local.theme = "dark";
    harness.engine.onLocalChange();
    await vi.runAllTimersAsync();
    expect(harness.sendPatch).toHaveBeenCalledTimes(1); // failed, key stays dirty

    // Focus refresh: the pre-GET flush fails again, but the GET succeeds and
    // returns the value the failed PATCH was trying to replace.
    harness.fetchRemote.mockResolvedValueOnce({ theme: "light" });
    await harness.engine.refresh();
    // The dirty key is NOT overwritten by the stale remote value...
    expect(harness.local.theme).toBe("dark");
    // ...and the refresh reschedules it, so it flushes once the network is back.
    harness.sendPatch.mockImplementation((patch: PrefsPatch) => Promise.resolve({ ...patch }));
    await vi.runAllTimersAsync();
    expect(harness.sendPatch).toHaveBeenLastCalledWith({ theme: "dark" });
  });

  it("keeps a mid-flight local edit over a remote value for the same key (no clobber)", async () => {
    const { local, engine, sendPatch, fetchRemote } = makeHarness(DEFAULTS);
    let resolveGet!: (v: Record<string, unknown>) => void;
    fetchRemote.mockImplementationOnce(
      () =>
        new Promise<Record<string, unknown>>((r) => {
          resolveGet = r;
        }),
    );
    const refreshing = engine.refresh();
    await vi.advanceTimersByTimeAsync(0); // the GET is now in flight
    local.theme = "dark"; // lands during the round-trip
    engine.onLocalChange();
    resolveGet({ theme: "light", accent: "amber" });
    await refreshing;
    // The untouched key applied; the edited one kept its local value...
    expect(local.accent).toBe("amber");
    expect(local.theme).toBe("dark");
    // ...and still PATCHes out — it is dirty against the server's "light".
    await vi.runAllTimersAsync();
    expect(sendPatch).toHaveBeenCalledTimes(1);
    expect(sendPatch).toHaveBeenCalledWith({ theme: "dark" });
  });

  it("PATCHes a mid-flight edit even when the server object lacks the key (no absorb)", async () => {
    const { local, engine, sendPatch, fetchRemote } = makeHarness(DEFAULTS);
    let resolveGet!: (v: Record<string, unknown>) => void;
    fetchRemote.mockImplementationOnce(
      () =>
        new Promise<Record<string, unknown>>((r) => {
          resolveGet = r;
        }),
    );
    const refreshing = engine.refresh();
    await vi.advanceTimersByTimeAsync(0); // the GET is now in flight
    local.theme = "dark"; // lands during the round-trip
    engine.onLocalChange();
    resolveGet({});
    await refreshing;
    expect(local.theme).toBe("dark");
    // Re-baselining from the stores would silently absorb the edit; instead it
    // stays dirty and goes out.
    await vi.runAllTimersAsync();
    expect(sendPatch).toHaveBeenCalledTimes(1);
    expect(sendPatch).toHaveBeenCalledWith({ theme: "dark" });
  });

  it("coalesces concurrent refreshes into one GET (focus + visibilitychange)", async () => {
    const { engine, fetchRemote } = makeHarness(DEFAULTS);
    let resolveGet!: (v: Record<string, unknown>) => void;
    fetchRemote.mockImplementationOnce(
      () =>
        new Promise<Record<string, unknown>>((r) => {
          resolveGet = r;
        }),
    );
    const first = engine.refresh();
    const second = engine.refresh();
    await vi.advanceTimersByTimeAsync(0); // the (single) GET is now in flight
    resolveGet({});
    await Promise.all([first, second]);
    expect(fetchRemote).toHaveBeenCalledTimes(1);
    // A later activation fetches again.
    await engine.refresh();
    expect(fetchRemote).toHaveBeenCalledTimes(2);
  });

  it("flushes pending local edits before a focus refresh can clobber them", async () => {
    const { local, engine, sendPatch, fetchRemote } = makeHarness(DEFAULTS);
    const order: string[] = [];
    sendPatch.mockImplementation((patch: PrefsPatch) => {
      order.push("patch");
      return Promise.resolve({ ...patch });
    });
    fetchRemote.mockImplementation(() => {
      order.push("get");
      return Promise.resolve({ theme: "dark" });
    });
    local.theme = "dark"; // unsent edit, debounce still pending
    engine.onLocalChange();
    await engine.refresh();
    expect(order).toEqual(["patch", "get"]);
    expect(sendPatch).toHaveBeenCalledWith({ theme: "dark" });
    // The pending timer was absorbed by the refresh — nothing fires later.
    await vi.runAllTimersAsync();
    expect(sendPatch).toHaveBeenCalledTimes(1);
  });

  it("keeps local state and stays quiet when the GET fails", async () => {
    const { local, engine, fetchRemote, sendPatch } = makeHarness(DEFAULTS);
    fetchRemote.mockRejectedValueOnce(new Error("offline"));
    local.tint_strength = 55;
    await engine.refresh();
    expect(local.tint_strength).toBe(55);
    expect(sendPatch).toHaveBeenCalledTimes(1); // the pre-GET flush still ran
  });

  it("flushes an explicit reset as null so the key is deleted, not set to a default", async () => {
    const { local, engine, sendPatch, fetchRemote } = makeHarness(DEFAULTS);
    // The user picked a value earlier and it synced.
    local.folder_hue = 120;
    engine.onLocalChange();
    await vi.runAllTimersAsync();
    expect(sendPatch).toHaveBeenLastCalledWith({ folder_hue: 120 });

    // Reset: the store returns to the app default; the key is DELETED remotely.
    local.folder_hue = DEFAULTS.folder_hue;
    engine.onLocalReset(["folder_hue"]);
    await vi.runAllTimersAsync();
    expect(sendPatch).toHaveBeenLastCalledWith({ folder_hue: null });

    // Clean afterward: the now-sparse GET leaves the local default in place
    // (the other app would equally fall back to ITS default) and nothing
    // echoes back out.
    fetchRemote.mockResolvedValueOnce({});
    await engine.refresh();
    expect(local.folder_hue).toBe(DEFAULTS.folder_hue);
    engine.onLocalChange();
    await vi.runAllTimersAsync();
    expect(sendPatch).toHaveBeenCalledTimes(2);
  });

  it("sends a pending reset's null exactly once when a refresh overlaps the flush", async () => {
    const { local, engine, sendPatch } = makeHarness({ ...DEFAULTS, tint_strength: 42 });
    // PATCHes resolve only when released, so a round-trip can be held open.
    const sent: PrefsPatch[] = [];
    const releases: Array<() => void> = [];
    sendPatch.mockImplementation((patch: PrefsPatch) => {
      sent.push({ ...patch });
      return new Promise((res) => releases.push(() => res({ ...patch })));
    });

    local.tint_strength = 0; // the store's reset
    engine.onLocalReset(["tint_strength"]);
    await vi.advanceTimersByTimeAsync(1000); // debounce fires: null in flight
    expect(sent).toEqual([{ tint_strength: null }]);

    // Window focus during that PATCH's round-trip. Unserialized, the
    // refresh's pre-GET flush would send the null AGAIN, and the two success
    // handlers would race over resetKeys — corrupting the baseline into a
    // perpetual diff that re-materializes the deleted key as a VALUE write
    // of the local default.
    const refreshing = engine.refresh();
    await vi.advanceTimersByTimeAsync(0);
    releases.shift()?.(); // first (and only) null succeeds
    await refreshing;
    await vi.runAllTimersAsync();
    while (releases.length) releases.shift()?.();
    await vi.runAllTimersAsync();

    // Exactly one delete went out and nothing wrote the default back.
    expect(sent).toEqual([{ tint_strength: null }]);
    expect(local.tint_strength).toBe(0);
  });

  it("a reset during a slow GET is not undone by the stale pre-delete response", async () => {
    const { local, engine, sendPatch, fetchRemote } = makeHarness(DEFAULTS);
    // Another device stored 42; the GET carrying it is slow enough that the
    // user's reset (store already at its local default, so the mid-flight
    // edit rule alone can't see it) lands during the round-trip.
    let resolveGet!: (v: Record<string, unknown>) => void;
    fetchRemote.mockImplementationOnce(
      () =>
        new Promise<Record<string, unknown>>((r) => {
          resolveGet = r;
        }),
    );
    const refreshing = engine.refresh();
    await vi.advanceTimersByTimeAsync(0); // the GET is now in flight
    engine.onLocalReset(["tint_strength"]);
    // The debounce elapses mid-GET: serialization queues the null-PATCH
    // behind the refresh instead of letting it land during the round-trip.
    await vi.advanceTimersByTimeAsync(1000);
    expect(sendPatch).not.toHaveBeenCalled();
    resolveGet({ tint_strength: 42 }); // the stale pre-delete response
    await refreshing;
    await vi.runAllTimersAsync();

    // The reset survived: 42 was never applied, and the delete went out once.
    expect(local.tint_strength).toBe(DEFAULTS.tint_strength);
    expect(sendPatch).toHaveBeenCalledTimes(1);
    expect(sendPatch).toHaveBeenCalledWith({ tint_strength: null });
  });

  it("an edit after a pending reset supersedes it — the value is sent, not null", async () => {
    const { local, engine, sendPatch } = makeHarness(DEFAULTS);
    local.folder_hue = 120;
    engine.onLocalChange();
    await vi.runAllTimersAsync();
    expect(sendPatch).toHaveBeenLastCalledWith({ folder_hue: 120 });

    local.folder_hue = DEFAULTS.folder_hue;
    engine.onLocalReset(["folder_hue"]);
    local.folder_hue = 30; // picked again before the reset's debounce fired
    engine.onLocalChange();
    await vi.runAllTimersAsync();
    expect(sendPatch).toHaveBeenLastCalledWith({ folder_hue: 30 });
  });

  it("dispose cancels a pending debounce", async () => {
    const { local, engine, sendPatch } = makeHarness(DEFAULTS);
    local.theme = "dark";
    engine.onLocalChange();
    engine.dispose();
    await vi.runAllTimersAsync();
    expect(sendPatch).not.toHaveBeenCalled();
  });

  it("skips the GET entirely when disposed during the pre-refresh flush", async () => {
    const { local, engine, sendPatch, fetchRemote } = makeHarness(DEFAULTS);
    let releasePatch!: () => void;
    sendPatch.mockImplementationOnce(
      (patch: PrefsPatch) =>
        new Promise((res) => {
          releasePatch = () => res({ ...patch });
        }),
    );
    local.theme = "dark";
    const refreshing = engine.refresh();
    await vi.advanceTimersByTimeAsync(0); // the pre-GET flush's PATCH is in flight
    engine.dispose(); // e.g. the desktop switched servers mid-flush
    releasePatch();
    await refreshing;
    // The stale GET never goes out — it would hit the NEW server's transport.
    expect(fetchRemote).not.toHaveBeenCalled();
  });

  it("never applies a GET that resolves after dispose (sign-out / server switch)", async () => {
    const { local, engine, fetchRemote } = makeHarness(DEFAULTS);
    let resolveGet!: (v: Record<string, unknown>) => void;
    fetchRemote.mockImplementationOnce(
      () =>
        new Promise<Record<string, unknown>>((r) => {
          resolveGet = r;
        }),
    );
    const refreshing = engine.refresh();
    await vi.advanceTimersByTimeAsync(0); // the GET is now in flight
    engine.dispose();
    resolveGet({ theme: "dark" });
    await refreshing;
    expect(local.theme).toBe(DEFAULTS.theme);
  });
});
