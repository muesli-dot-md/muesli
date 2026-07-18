// Cross-app appearance preference sync, desktop glue. Port of
// src/lib/prefsSync.svelte.ts: binds the pure engine (services/prefsSyncCore.ts
// — identical to the web copy) to this app's stores and to GET/PATCH
// /api/me/prefs over the authenticated `api_request` Tauri command. Started
// once from the app shell's mount effect, after the stores' init() calls;
// dormant while signed out — a signed-out desktop stays purely local.
//
// Mapping (the synced keys): theme ↔ theme.mode, accent ↔ accentStore.id,
// tint_strength ↔ background.tint, tint_hue ↔ background.hue,
// folder_hue ↔ folderColor.hue. background.translucency is deliberately NOT
// synced: it is a window-vibrancy control with no web counterpart.
//
// Echo-loop guard lives in the engine: applying a server value re-baselines
// before the store subscriptions below can observe the change, so a refresh
// never PATCHes its own values back out. All failures are silent by spec.
//
// The Svelte $effect.root's two effects become zustand store subscriptions:
// the engine-lifecycle watcher follows workspaces (identity + activeServer),
// and one change-watcher per synced store pokes engine.onLocalChange().

import { apiRequest } from "@/services/collab/apiRequest";
import {
  createPrefsSync,
  type Prefs,
  type PrefsPatch,
  type PrefsSync,
} from "@/services/prefsSyncCore";
import { accentStore, ACCENT_PRESETS, type AccentId } from "./accent";
import { backgroundStore } from "./background";
import { folderColorStore } from "./folderColor";
import { themeStore } from "./theme";
import { workspacesStore } from "./workspaces";

const ACCENT_IDS = new Set<string>(ACCENT_PRESETS.map((p) => p.id));

function read(): Prefs {
  return {
    theme: themeStore.getState().mode,
    accent: accentStore.getState().id,
    tint_strength: backgroundStore.getState().tint,
    tint_hue: backgroundStore.getState().hue,
    folder_hue: folderColorStore.getState().hue,
  };
}

/** Write present keys into the stores. The server validates strictly, so these
 *  guards only matter against a newer server speaking a wider schema. */
function apply(p: Prefs): void {
  if (p.theme === "light" || p.theme === "dark" || p.theme === "system") {
    themeStore.getState().setMode(p.theme);
  }
  if (typeof p.accent === "string" && ACCENT_IDS.has(p.accent)) {
    accentStore.getState().setId(p.accent as AccentId);
  }
  if (typeof p.tint_strength === "number") backgroundStore.getState().setTint(p.tint_strength);
  if (typeof p.tint_hue === "number") backgroundStore.getState().setHue(p.tint_hue);
  if (typeof p.folder_hue === "number") folderColorStore.getState().setHue(p.folder_hue);
}

// The transport reads engineServer, NOT workspaces.activeServer: the engine is
// bound to the server it was created for, so a request it issues can never
// land on a different server than the one its baseline was diffed against.
function fetchRemote(): Promise<Record<string, unknown>> {
  return apiRequest<Record<string, unknown>>(engineServer, {
    path: "/api/me/prefs",
  });
}

function sendPatch(patch: PrefsPatch): Promise<unknown> {
  return apiRequest<Record<string, unknown>>(engineServer, {
    method: "PATCH",
    path: "/api/me/prefs",
    body: patch,
  });
}

let engine: PrefsSync | null = null;
let engineServer = "";
let started = false;

/** Two open apps converge without websockets: refetch whenever this window
 *  regains focus or becomes visible again. Focus and visibilitychange both
 *  fire on one activation; the engine coalesces them into a single GET. */
function onWindowActive(): void {
  if (engine && document.visibilityState === "visible") void engine.refresh();
}

/** The Preferences page's "Reset to default" buttons route through these so
 *  the synced keys are DELETED server-side (null in the PATCH) — restoring
 *  the sparse object, so the web app falls back to ITS OWN defaults — rather
 *  than written out as this app's defaults. Signed out (engine null), only
 *  the local store resets, exactly as before sync existed. Translucency is
 *  covered by background.reset() but has no synced key. */
function resetBackground(): void {
  backgroundStore.getState().reset();
  engine?.onLocalReset(["tint_strength", "tint_hue"]);
}

function resetFolderColor(): void {
  folderColorStore.getState().reset();
  engine?.onLocalReset(["folder_hue"]);
}

/** Engine lifecycle follows auth AND the active server: created (and
 *  immediately refreshed) once a server identity exists; torn down on
 *  sign-out so a signed-out desktop never issues prefs requests; torn down
 *  AND recreated on a server switch, since the engine's baseline and
 *  transport (engineServer) belong to one server. Pending debounced changes
 *  for the old server are DROPPED, not flushed — a flush here would race
 *  the identity swap, and appearance edits are cheap to lose (the stores
 *  still hold them locally; the next edit or focus refresh re-syncs). */
function syncEngineLifecycle(): void {
  const { activeServer: server, identity } = workspacesStore.getState();
  const authed = identity != null && server !== "";
  if (engine && (!authed || server !== engineServer)) {
    engine.dispose();
    engine = null;
  }
  if (authed && !engine) {
    engineServer = server;
    engine = createPrefsSync({ read, apply, fetchRemote, sendPatch });
    void engine.refresh();
  }
}

/** Any synced-value change (user edit or server apply) pokes the engine, which
 *  diffs against its baseline to decide whether anything actually goes out. */
function onLocalChange(): void {
  engine?.onLocalChange();
}

/** Install the auth-following engine + store watchers (idempotent; call once
 *  from the app shell's mount, after theme/background/folderColor/accent init). */
function start(): void {
  if (started || typeof window === "undefined") return;
  started = true;

  workspacesStore.subscribe((next, prev) => {
    if (next.identity === prev.identity && next.activeServer === prev.activeServer) return;
    syncEngineLifecycle();
  });
  syncEngineLifecycle(); // initial pass (the $effect ran immediately)

  themeStore.subscribe((next, prev) => {
    if (next.mode !== prev.mode) onLocalChange();
  });
  accentStore.subscribe((next, prev) => {
    if (next.id !== prev.id) onLocalChange();
  });
  backgroundStore.subscribe((next, prev) => {
    if (next.tint !== prev.tint || next.hue !== prev.hue) onLocalChange();
  });
  folderColorStore.subscribe((next, prev) => {
    if (next.hue !== prev.hue) onLocalChange();
  });

  window.addEventListener("focus", onWindowActive);
  document.addEventListener("visibilitychange", onWindowActive);
}

export const prefsSync = { start, resetBackground, resetFolderColor };
