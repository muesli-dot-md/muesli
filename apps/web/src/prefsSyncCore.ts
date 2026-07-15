// Pure engine behind the per-app prefsSync glue (prefsSync.svelte.ts): the
// debounce/diff/echo-guard logic for syncing appearance preferences through
// GET/PATCH /api/me/prefs, kept free of Svelte, fetch, and store imports so it
// unit-tests with plain objects and fake timers. This file is intentionally
// IDENTICAL in apps/web/src and apps/desktop/src/lib — if you touch one, mirror
// the other (same convention as livePreview/, see AGENTS.md).
//
// Sync model (owner spec):
//   - The server object is SPARSE: a key exists only once the user has picked
//     something, so each app keeps its own local default until then (web
//     defaults accent "gray", desktop periwinkle — neither must be yanked).
//   - refresh() (boot + window focus) applies every PRESENT key to the local
//     stores and re-baselines; absent keys leave local state untouched. A key
//     that is locally DIRTY — edited while the GET was in flight, or left
//     unsent by a failed PATCH — is never overwritten by the response: it
//     keeps its local value and stays scheduled to PATCH out. Concurrent
//     refresh() calls share one round-trip, and ALL round-trips are
//     serialized: a flush never overlaps another flush or a refresh's GET.
//   - onLocalChange() debounces (~1s) and PATCHes ONLY the keys that differ
//     from the baseline. Applying a server value re-baselines first, so it can
//     never echo back as a PATCH.
//   - onLocalReset() (explicit "Reset to default") flushes the keys as JSON
//     null — a server-side DELETE that restores the sparse invariant, so the
//     other app falls back to ITS default instead of inheriting this app's.
//   - Failures are silent: a failed PATCH keeps its keys dirty (the baseline
//     stays stale), so the diff is retried by the next change or focus
//     refresh; a failed GET just keeps local state.

/** The synced keys — must match the server's validator (prefs_api.rs). */
export const PREF_KEYS = ["theme", "accent", "tint_strength", "tint_hue", "folder_hue"] as const;

export type PrefKey = (typeof PREF_KEYS)[number];

/** A sparse preference object; values are validated by the stores on apply. */
export type Prefs = Partial<Record<PrefKey, string | number>>;

/** A PATCH body: JSON null DELETES the key server-side (explicit reset). */
export type PrefsPatch = Partial<Record<PrefKey, string | number | null>>;

/** The keys of `current` whose values differ from `baseline`. */
export function diffPrefs(current: Prefs, baseline: Prefs): Prefs {
  const out: Prefs = {};
  for (const key of PREF_KEYS) {
    if (current[key] !== baseline[key]) out[key] = current[key];
  }
  return out;
}

/** The known, primitively-typed subset of a fetched server object. */
export function pickKnown(remote: Record<string, unknown>): Prefs {
  const out: Prefs = {};
  for (const key of PREF_KEYS) {
    const v = remote[key];
    if (typeof v === "string" || (typeof v === "number" && Number.isFinite(v))) out[key] = v;
  }
  return out;
}

export type PrefsSyncOpts = {
  /** Snapshot the local stores' current synced values. */
  read(): Prefs;
  /** Write every present key into the local stores (stores clamp/validate). */
  apply(present: Prefs): void;
  /** GET /api/me/prefs. Reject on any failure (handled silently here). */
  fetchRemote(): Promise<Record<string, unknown>>;
  /** PATCH /api/me/prefs with only the changed keys (null = delete). Reject on failure. */
  sendPatch(patch: PrefsPatch): Promise<unknown>;
  /** Debounce for local edits (default 1000ms). */
  debounceMs?: number;
};

export type PrefsSync = ReturnType<typeof createPrefsSync>;

export function createPrefsSync(opts: PrefsSyncOpts) {
  const debounceMs = opts.debounceMs ?? 1000;
  // What the server is believed to hold for the local stores' values. Starting
  // from the local snapshot (not {}) means nothing is "dirty" at creation:
  // local defaults are never pushed until the user actually changes something.
  let baseline: Prefs = opts.read();
  let timer: ReturnType<typeof setTimeout> | null = null;
  // Set by dispose(): a torn-down engine (sign-out, server switch) must never
  // flush to — or apply a late GET response from — the wrong account.
  let disposed = false;
  // Keys the user explicitly reset, mapped to the local (default) value the
  // store held at reset time. They flush as JSON null (a server-side DELETE):
  // sending the local default as a VALUE would pin THIS app's default onto
  // every other client. An edit to the key after the reset supersedes it — the
  // ordinary diff then carries the new value instead.
  const resetKeys = new Map<PrefKey, string | number | undefined>();
  // Every round-trip runs on this chain: a flush never overlaps another flush
  // or a refresh (whose pre-GET flush and GET occupy ONE chain slot). Overlap
  // is exactly where the reset machinery breaks — two concurrent flushes both
  // sending a key's null, the second success handler then reading the
  // already-consumed resetKeys entry (undefined) into the baseline, creating
  // a perpetual diff that re-materializes the deleted key as a VALUE write;
  // or a null-PATCH landing mid-GET, letting the stale pre-delete response
  // resurrect the key locally while the server no longer holds it.
  let chain: Promise<void> = Promise.resolve();
  // Coalesces concurrent refresh() calls: window "focus" and "visibilitychange"
  // both fire on a single activation, and must share one GET.
  let inflight: Promise<void> | null = null;

  function serialized(op: () => Promise<void>): Promise<void> {
    const run = chain.then(op);
    // The chain must survive a rejected op (not expected — flushOnce and
    // refreshOnce swallow their own failures — but one stray throw must not
    // wedge every later round-trip).
    chain = run.catch(() => {});
    return run;
  }

  function clearTimer() {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function schedule() {
    clearTimer();
    timer = setTimeout(() => void serialized(flushOnce), debounceMs);
  }

  /** PATCH the keys that drifted from the baseline plus any pending resets
   *  (as nulls); no-op when clean. Only ever runs on the chain (serialized()),
   *  or inside refreshOnce, which itself holds a chain slot. */
  async function flushOnce(): Promise<void> {
    clearTimer();
    if (disposed) return;
    const current = opts.read();
    const patch: PrefsPatch = diffPrefs(current, baseline);
    // The resets THIS flush delivers are captured here at build time: the
    // success handler below must consult its own snapshot, never the live
    // map — which other machinery may touch during the PATCH's round-trip.
    const sentResets = new Map<PrefKey, string | number | undefined>();
    for (const [key, resetValue] of resetKeys) {
      if (current[key] === resetValue) {
        patch[key] = null;
        sentResets.set(key, resetValue);
      } else {
        resetKeys.delete(key); // superseded by a later edit — the diff carries it
      }
    }
    if (Object.keys(patch).length === 0) return;
    try {
      await opts.sendPatch(patch);
      // Advance the baseline by what was SENT, not by re-reading: a change made
      // while the PATCH was in flight stays dirty and flushes on its own timer.
      // A delivered null leaves the server without the key, which every client
      // renders as its local default — for THIS one, the value captured at
      // reset time; record that as the baseline so the key reads clean.
      const next = { ...baseline };
      for (const key of PREF_KEYS) {
        if (!(key in patch)) continue;
        const sent = patch[key];
        if (sent === null) {
          next[key] = sentResets.get(key);
          // Consume the live entry only while it still holds the reset this
          // flush delivered — never a newer one registered mid-round-trip.
          if (resetKeys.get(key) === sentResets.get(key)) resetKeys.delete(key);
        } else {
          next[key] = sent;
        }
      }
      baseline = next;
    } catch {
      // Silent by spec: the baseline (and any pending resets) stay stale, so
      // the keys stay dirty. The next local change retries them implicitly and
      // refresh() retries them explicitly — and shields them from the GET it
      // performs (see the dirty-key handling below).
    }
  }

  async function refreshOnce(): Promise<void> {
    await flushOnce();
    // Torn down during the flush (sign-out / server switch): the GET must not
    // go out at all — the transport may already point at a different account.
    if (disposed) return;
    // Snapshot before the GET. A key is DIRTY when its local value moved
    // during the round-trip (a mid-flight edit), when it already differed from
    // the baseline at snapshot time (the flush above failed), or when a reset
    // is still pending. The response must neither clobber a dirty key (apply)
    // nor absorb it (re-baseline): it keeps its local value and is
    // rescheduled to PATCH out.
    const snapshot = opts.read();
    let remote: Record<string, unknown>;
    try {
      remote = await opts.fetchRemote();
    } catch {
      return; // silent: keep local, retry on the next focus/change
    }
    if (disposed) return;
    const present = pickKnown(remote);
    const current = opts.read();
    const dirty = new Set<PrefKey>(resetKeys.keys());
    for (const key of PREF_KEYS) {
      if (current[key] !== snapshot[key] || snapshot[key] !== baseline[key]) dirty.add(key);
    }
    const clean: Prefs = {};
    for (const key of PREF_KEYS) {
      if (key in present && !dirty.has(key)) clean[key] = present[key];
    }
    opts.apply(clean);
    // Re-baseline from the stores (post-clamping), which is exactly what makes
    // the apply un-echoable. A dirty key instead baselines to what the server
    // just reported (or keeps its stale baseline when absent remotely), so its
    // local value still diffs and the reschedule below carries it out.
    const next = opts.read();
    for (const key of dirty) {
      next[key] = key in present ? present[key] : baseline[key];
    }
    baseline = next;
    if (resetKeys.size > 0 || Object.keys(diffPrefs(opts.read(), baseline)).length > 0) {
      schedule();
    }
  }

  return {
    /**
     * Boot/focus resync: push any pending local edits FIRST (so the GET below
     * can't clobber an unsent change), then apply every clean key the server
     * holds and re-baseline. Concurrent calls share one round-trip — a single
     * window activation fires both "focus" and "visibilitychange" — and the
     * whole thing takes one chain slot, so no flush can land mid-GET.
     */
    refresh(): Promise<void> {
      inflight ??= serialized(refreshOnce).finally(() => {
        inflight = null;
      });
      return inflight;
    },

    /** Call on every local store change; coalesces into one PATCH per ~1s. */
    onLocalChange(): void {
      schedule();
    },

    /**
     * Call AFTER an explicit "Reset to default" has reset the local stores:
     * the keys are DELETED server-side (null in the PATCH) instead of written
     * as this app's default, so the other app falls back to ITS OWN default.
     */
    onLocalReset(keys: readonly PrefKey[]): void {
      const current = opts.read();
      for (const key of keys) resetKeys.set(key, current[key]);
      schedule();
    },

    flush(): Promise<void> {
      return serialized(flushOnce);
    },

    dispose(): void {
      disposed = true;
      clearTimer();
    },
  };
}
