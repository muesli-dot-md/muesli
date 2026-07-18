// Cross-app appearance preference sync, web glue — React/zustand port of
// src/prefsSync.svelte.ts: binds the pure engine (services/prefsSyncCore.ts —
// identical to the desktop copy) to this app's stores and to GET/PATCH
// /api/me/prefs over the session cookie (same-origin fetch, credentials:
// "include", exactly like notificationsApi.ts). Self-starting on import (the
// Svelte App imported it like accent.svelte.ts) but entirely dormant while
// signed out or in open mode — a guest stays purely local, exactly as before
// this module existed. start() stays exported and idempotent for explicit
// boot wiring.
//
// Mapping (the synced keys): theme ↔ theme.mode, accent ↔ accentStore.id,
// tint_strength ↔ background.tint, tint_hue ↔ background.hue,
// folder_hue ↔ folderColor.hue. The desktop syncs the same five; its
// translucency is deliberately NOT synced (no web counterpart).
//
// Echo-loop guard lives in the engine: applying a server value re-baselines
// before the store watchers below can observe the change, so a refresh never
// PATCHes its own values back out. All failures are silent by spec.
//
// The Svelte $effect.root's two effects become zustand store subscriptions:
// the engine-lifecycle watcher follows authSession, and one change-watcher per
// synced store pokes engine.onLocalChange().

import { httpBase } from "@/services/identity";
import {
  createPrefsSync,
  type Prefs,
  type PrefsPatch,
  type PrefsSync,
} from "@/services/prefsSyncCore";
import { accentStore, ACCENT_PRESETS, type AccentId } from "./accent";
import { authSessionStore } from "./authSession";
import { backgroundStore } from "./background";
import { folderColorStore } from "./folderColor";
import { themeStore } from "./theme";

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

async function fetchRemote(): Promise<Record<string, unknown>> {
  const res = await fetch(`${httpBase}/api/me/prefs`, { credentials: "include" });
  if (!res.ok) throw new Error(`prefs GET ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}

async function sendPatch(patch: PrefsPatch): Promise<unknown> {
  const res = await fetch(`${httpBase}/api/me/prefs`, {
    method: "PATCH",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`prefs PATCH ${res.status}`);
  return res.json();
}

let engine: PrefsSync | null = null;
let started = false;

/** Two open apps converge without websockets: refetch whenever this one
 *  regains focus or becomes visible again. Focus and visibilitychange both
 *  fire on one activation; the engine coalesces them into a single GET. */
function onWindowActive(): void {
  if (engine && document.visibilityState === "visible") void engine.refresh();
}

/** The Preferences page's "Reset to default" buttons route through these so
 *  the synced keys are DELETED server-side (null in the PATCH) — restoring
 *  the sparse object, so the desktop falls back to ITS OWN defaults — rather
 *  than written out as this app's defaults. Signed out (engine null), only
 *  the local store resets, exactly as before sync existed. */
export function resetBackground(): void {
  backgroundStore.getState().reset();
  engine?.onLocalReset(["tint_strength", "tint_hue"]);
}

export function resetFolderColor(): void {
  folderColorStore.getState().reset();
  engine?.onLocalReset(["folder_hue"]);
}

/** Engine lifecycle follows auth: created (and immediately refreshed) once
 *  /api/me reports a signed-in user; torn down on sign-out so a guest session
 *  never issues prefs requests. */
function syncEngineLifecycle(): void {
  const current = authSessionStore.getState().current;
  const authed = current?.mode === "oidc" && current.user != null;
  if (authed && !engine) {
    engine = createPrefsSync({ read, apply, fetchRemote, sendPatch });
    void engine.refresh();
  } else if (!authed && engine) {
    engine.dispose();
    engine = null;
  }
}

/** Any synced-value change (user edit or server apply) pokes the engine, which
 *  diffs against its baseline to decide whether anything actually goes out. */
function onLocalChange(): void {
  engine?.onLocalChange();
}

/** Install the auth-following engine + store watchers (idempotent; also runs
 *  on module import — the module lives for the whole page, like the stores it
 *  watches). */
export function start(): void {
  if (started || typeof window === "undefined") return;
  started = true;

  authSessionStore.subscribe((next, prev) => {
    if (next.current === prev.current) return;
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

start();

export const prefsSync = { start, resetBackground, resetFolderColor };
