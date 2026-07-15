// Cross-app appearance preference sync, web glue: binds the pure engine
// (prefsSyncCore.ts) to this app's stores and to GET/PATCH /api/me/prefs over
// the session cookie (same-origin fetch, credentials: "include", exactly like
// notificationsApi.ts). Self-starting on import (App.svelte imports it like
// accent.svelte.ts) but entirely dormant while signed out or in open mode —
// a guest stays purely local, exactly as before this module existed.
//
// Mapping (the synced keys): theme ↔ theme.mode, accent ↔ accentStore.id,
// tint_strength ↔ background.tint, tint_hue ↔ background.hue,
// folder_hue ↔ folderColor.hue. The desktop syncs the same five; its
// translucency is deliberately NOT synced (no web counterpart).
//
// Echo-loop guard lives in the engine: applying a server value re-baselines
// before the store watcher below can observe the change, so a refresh never
// PATCHes its own values back out. All failures are silent by spec.

import { accentStore, ACCENT_PRESETS, type AccentId } from "./accent.svelte";
import { authSession } from "./authSession.svelte";
import { background } from "./background.svelte";
import { folderColor } from "./folderColor.svelte";
import { httpBase } from "./identity";
import { createPrefsSync, type Prefs, type PrefsPatch, type PrefsSync } from "./prefsSyncCore";
import { theme } from "./theme.svelte";

const ACCENT_IDS = new Set<string>(ACCENT_PRESETS.map((p) => p.id));

function read(): Prefs {
  return {
    theme: theme.mode,
    accent: accentStore.id,
    tint_strength: background.tint,
    tint_hue: background.hue,
    folder_hue: folderColor.hue,
  };
}

/** Write present keys into the stores. The server validates strictly, so these
 *  guards only matter against a newer server speaking a wider schema. */
function apply(p: Prefs): void {
  if (p.theme === "light" || p.theme === "dark" || p.theme === "system") theme.mode = p.theme;
  if (typeof p.accent === "string" && ACCENT_IDS.has(p.accent)) {
    accentStore.id = p.accent as AccentId;
  }
  if (typeof p.tint_strength === "number") background.tint = p.tint_strength;
  if (typeof p.tint_hue === "number") background.hue = p.tint_hue;
  if (typeof p.folder_hue === "number") folderColor.hue = p.folder_hue;
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
  background.reset();
  engine?.onLocalReset(["tint_strength", "tint_hue"]);
}

export function resetFolderColor(): void {
  folderColor.reset();
  engine?.onLocalReset(["folder_hue"]);
}

// Unowned root: this module lives for the whole page, like the stores it watches.
$effect.root(() => {
  // Engine lifecycle follows auth: created (and immediately refreshed) once
  // /api/me reports a signed-in user; torn down on sign-out so a guest session
  // never issues prefs requests.
  $effect(() => {
    const authed = authSession.current?.mode === "oidc" && authSession.current.user != null;
    if (authed && !engine) {
      engine = createPrefsSync({ read, apply, fetchRemote, sendPatch });
      void engine.refresh();
    } else if (!authed && engine) {
      engine.dispose();
      engine = null;
    }
  });

  // One watcher over every synced value: any change (user edit or server
  // apply) pokes the engine, which diffs against its baseline to decide
  // whether anything actually needs to go out.
  $effect(() => {
    void theme.mode;
    void accentStore.id;
    void background.tint;
    void background.hue;
    void folderColor.hue;
    engine?.onLocalChange();
  });
});

window.addEventListener("focus", onWindowActive);
document.addEventListener("visibilitychange", onWindowActive);
