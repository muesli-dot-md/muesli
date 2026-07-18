// Seamless-update store (spec 2026-07-02 §3). Port of src/lib/updates.svelte.ts.
// Drives the sidebar UpdatePill: state machine idle → checking → available →
// downloading → ready | error. Checks at launch (after a ~10s idle delay so
// startup stays snappy) and every 4 hours; with settings.autoUpdate (default
// on) a found update downloads silently and the pill appears only at READY.
// Every check/download failure is console.warn-silent — an update checker must
// never interrupt writing — and retries at the next scheduled cycle. Dev builds
// (import.meta.env.DEV) stay idle with exactly one debug line.
//
// The Svelte `pillVisible` getter is a state FIELD here, recomputed by every
// state/failureMessage transition and by a settings.autoUpdate subscription
// (the only external input it reads).

import { createStore } from "zustand/vanilla";
import { useStore } from "zustand";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { settingsStore } from "./settings";

export type UpdateState = "idle" | "checking" | "available" | "downloading" | "ready" | "error";

const INITIAL_DELAY_MS = 10_000;
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

export interface UpdatesState {
  state: UpdateState;
  version: string | null;
  progress: { downloaded: number; total: number | null } | null;
  /** Set ONLY by an install failure — the one error the popover surfaces. */
  failureMessage: string | null;
  /** Whether AppShell should render the sidebar pill: staged update (ready),
   *  an install failure to surface, or the manual path's available/downloading. */
  pillVisible: boolean;
  start(isDev?: boolean): void;
  stop(): void;
  installAndRelaunch(): Promise<void>;
}

// Non-reactive plumbing.
/** The pending Update handle from check(). */
let update: Update | null = null;
let initialTimer: ReturnType<typeof setTimeout> | null = null;
let intervalTimer: ReturnType<typeof setInterval> | null = null;

function computePillVisible(state: UpdateState, failureMessage: string | null): boolean {
  if (state === "ready") return true;
  if (failureMessage !== null) return true;
  const autoUpdate = settingsStore.getState().autoUpdate;
  if (!autoUpdate && (state === "available" || state === "downloading")) return true;
  return false;
}

export const updatesStore = createStore<UpdatesState>()((set, get) => {
  /** Every transition routes through here so pillVisible stays derived. */
  function patch(
    p: Partial<Pick<UpdatesState, "state" | "version" | "progress" | "failureMessage">>,
  ) {
    const state = p.state ?? get().state;
    const failureMessage = p.failureMessage !== undefined ? p.failureMessage : get().failureMessage;
    set({ ...p, pillVisible: computePillVisible(state, failureMessage) });
  }

  /** One scheduled cycle. Skipped while a check/download is in flight and once
   *  an update is staged (ready); runs again from idle/available/error. */
  async function runCheck(): Promise<void> {
    const s = get().state;
    if (s === "checking" || s === "downloading" || s === "ready") return;
    patch({ state: "checking", failureMessage: null });
    try {
      const found = await check();
      if (!found) {
        patch({ state: "idle" });
        return;
      }
      update = found;
      patch({ version: found.version });
      if (settingsStore.getState().autoUpdate) {
        await download(); // silent
      } else {
        patch({ state: "available" }); // pill appears; the user drives the download
      }
    } catch (e) {
      console.warn("[updates] check failed:", e);
      patch({ state: "error" }); // silent to UI; retried next cycle
    }
  }

  async function download(): Promise<void> {
    if (!update) return;
    patch({ state: "downloading", progress: { downloaded: 0, total: null } });
    try {
      await update.download((event) => {
        if (event.event === "Started") {
          patch({ progress: { downloaded: 0, total: event.data.contentLength ?? null } });
        } else if (event.event === "Progress") {
          const prev = get().progress;
          patch({
            progress: {
              downloaded: (prev?.downloaded ?? 0) + event.data.chunkLength,
              total: prev?.total ?? null,
            },
          });
        }
      });
      patch({ state: "ready" });
    } catch (e) {
      console.warn("[updates] download failed:", e);
      update = null; // stale handle — re-check() next cycle
      patch({ state: "error" });
    }
  }

  return {
    state: "idle",
    version: null,
    progress: null,
    failureMessage: null,
    pillVisible: false,

    /** Schedule the launch check (~10s) + the 4h interval. Dev builds stay idle. */
    start(isDev: boolean = import.meta.env.DEV): void {
      if (initialTimer !== null || intervalTimer !== null) return; // double-start guard
      if (isDev) {
        console.debug("[updates] dev build — updater disabled");
        return;
      }
      initialTimer = setTimeout(() => void runCheck(), INITIAL_DELAY_MS);
      intervalTimer = setInterval(() => void runCheck(), CHECK_INTERVAL_MS);
    },

    stop(): void {
      if (initialTimer !== null) {
        clearTimeout(initialTimer);
        initialTimer = null;
      }
      if (intervalTimer !== null) {
        clearInterval(intervalTimer);
        intervalTimer = null;
      }
    },

    /** The popover's "Restart and Update" button. `available` → download first
     *  (progress shows on the pill); then install + relaunch. An install failure
     *  surfaces in the popover; a relaunch failure leaves the app running — the
     *  swapped bundle applies on the next manual quit/launch. */
    async installAndRelaunch(): Promise<void> {
      if (get().state === "available") await download();
      if (get().state !== "ready" || !update) return;
      try {
        await update.install();
      } catch (e) {
        console.warn("[updates] install failed:", e);
        update = null;
        patch({ state: "error", failureMessage: "Update failed — will retry later" });
        return;
      }
      try {
        await relaunch();
      } catch (e) {
        console.warn("[updates] relaunch failed:", e);
        // Keep state 'ready': the update applies on the next quit/launch.
      }
    },
  };
});

// pillVisible reads settings.autoUpdate — re-derive when that flips (the Svelte
// getter tracked it automatically).
settingsStore.subscribe((next, prev) => {
  if (next.autoUpdate === prev.autoUpdate) return;
  const { state, failureMessage, pillVisible } = updatesStore.getState();
  const computed = computePillVisible(state, failureMessage);
  if (computed !== pillVisible) updatesStore.setState({ pillVisible: computed });
});

export const useUpdates = <T>(sel: (s: UpdatesState) => T): T => useStore(updatesStore, sel);
