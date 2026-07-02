// Seamless-update store (spec 2026-07-02 §3). A runes singleton driving the
// sidebar UpdatePill: state machine idle → checking → available → downloading
// → ready | error. Checks at launch (after a ~10s idle delay so startup stays
// snappy) and every 4 hours; with settings.autoUpdate (default on) a found
// update downloads silently and the pill appears only at READY. Every check/
// download failure is console.warn-silent — an update checker must never
// interrupt writing — and retries at the next scheduled cycle. Dev builds
// (import.meta.env.DEV) stay idle with exactly one debug line.
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { settings } from "$lib/settings.svelte";

export type UpdateState = "idle" | "checking" | "available" | "downloading" | "ready" | "error";

const INITIAL_DELAY_MS = 10_000;
const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

function createUpdatesStore() {
  let state = $state<UpdateState>("idle");
  let version = $state<string | null>(null);
  let progress = $state<{ downloaded: number; total: number | null } | null>(null);
  // Set ONLY by an install failure — the one error the popover surfaces.
  let failureMessage = $state<string | null>(null);

  // The pending Update handle from check(); non-reactive plumbing.
  let update: Update | null = null;
  let initialTimer: ReturnType<typeof setTimeout> | null = null;
  let intervalTimer: ReturnType<typeof setInterval> | null = null;

  /** One scheduled cycle. Skipped while a check/download is in flight and once
   *  an update is staged (ready); runs again from idle/available/error. */
  async function runCheck(): Promise<void> {
    if (state === "checking" || state === "downloading" || state === "ready") return;
    state = "checking";
    failureMessage = null;
    try {
      const found = await check();
      if (!found) {
        state = "idle";
        return;
      }
      update = found;
      version = found.version;
      if (settings.autoUpdate) {
        await download(); // silent
      } else {
        state = "available"; // pill appears; the user drives the download
      }
    } catch (e) {
      console.warn("[updates] check failed:", e);
      state = "error"; // silent to UI; retried next cycle
    }
  }

  async function download(): Promise<void> {
    if (!update) return;
    state = "downloading";
    progress = { downloaded: 0, total: null };
    try {
      await update.download((event) => {
        if (event.event === "Started") {
          progress = { downloaded: 0, total: event.data.contentLength ?? null };
        } else if (event.event === "Progress") {
          progress = {
            downloaded: (progress?.downloaded ?? 0) + event.data.chunkLength,
            total: progress?.total ?? null,
          };
        }
      });
      state = "ready";
    } catch (e) {
      console.warn("[updates] download failed:", e);
      update = null; // stale handle — re-check() next cycle
      state = "error";
    }
  }

  /** The popover's "Restart and Update" button. `available` → download first
   *  (progress shows on the pill); then install + relaunch. An install failure
   *  surfaces in the popover; a relaunch failure leaves the app running — the
   *  swapped bundle applies on the next manual quit/launch. */
  async function installAndRelaunch(): Promise<void> {
    if (state === "available") await download();
    if (state !== "ready" || !update) return;
    try {
      await update.install();
    } catch (e) {
      console.warn("[updates] install failed:", e);
      failureMessage = "Update failed — will retry later";
      update = null;
      state = "error";
      return;
    }
    try {
      await relaunch();
    } catch (e) {
      console.warn("[updates] relaunch failed:", e);
      // Keep state 'ready': the update applies on the next quit/launch.
    }
  }

  /** Schedule the launch check (~10s) + the 4h interval. Dev builds stay idle. */
  function start(isDev: boolean = import.meta.env.DEV): void {
    if (initialTimer !== null || intervalTimer !== null) return; // double-start guard
    if (isDev) {
      console.debug("[updates] dev build — updater disabled");
      return;
    }
    initialTimer = setTimeout(() => void runCheck(), INITIAL_DELAY_MS);
    intervalTimer = setInterval(() => void runCheck(), CHECK_INTERVAL_MS);
  }

  function stop(): void {
    if (initialTimer !== null) {
      clearTimeout(initialTimer);
      initialTimer = null;
    }
    if (intervalTimer !== null) {
      clearInterval(intervalTimer);
      intervalTimer = null;
    }
  }

  return {
    get state() {
      return state;
    },
    get version() {
      return version;
    },
    get progress() {
      return progress;
    },
    get failureMessage() {
      return failureMessage;
    },
    /** Whether AppShell should render the sidebar pill: staged update (ready),
     *  an install failure to surface, or the manual path's available/downloading. */
    get pillVisible() {
      if (state === "ready") return true;
      if (failureMessage !== null) return true;
      if (!settings.autoUpdate && (state === "available" || state === "downloading")) return true;
      return false;
    },
    start,
    stop,
    installAndRelaunch,
  };
}

export const updates = createUpdatesStore();
