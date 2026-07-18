// Whether to show first-login onboarding (BYO storage phase 3, spec §2),
// extracted from Home.svelte so the trigger matrix unit-tests in node.
// OIDC mode reads the server flag on /api/me; open mode falls back to
// localStorage (the prefs.svelte.ts pattern); an UNREACHABLE /api/me shows
// nothing (fail-quiet, spec §5) — a courtesy flow never compounds an outage.

import type { AuthInfo } from "./identity";

export const ONBOARDED_KEY = "muesli:onboarded";

export type LocalFlagStore = Pick<Storage, "getItem" | "setItem">;

/** Open-mode fallback flag. Unavailable or throwing storage counts as
 *  onboarded — never loop (spec §5). */
export function localOnboarded(store?: LocalFlagStore): boolean {
  try {
    return (store ?? localStorage).getItem(ONBOARDED_KEY) === "1";
  } catch {
    return true;
  }
}

/** Best-effort write; a quota/availability error means the user may see
 *  onboarding again — acceptable, never surfaced. */
export function markLocalOnboarded(store?: LocalFlagStore): void {
  try {
    (store ?? localStorage).setItem(ONBOARDED_KEY, "1");
  } catch {
    // best-effort
  }
}

/** The web trigger matrix (spec §2).
 *
 *  `workspacesLoadFailed`: whether Home's `listWorkspaces` fetch threw. Only
 *  OIDC bails on it — the invited-vs-create fork is classified by the user's
 *  memberships, so a failed list would misread an invited user as "create"
 *  over an error banner. Open mode is unaffected BY DESIGN: there,
 *  GET /api/workspaces answers 503 on every load (workspace.rs), the list is
 *  always "failed", and open mode has no memberships anyway — its context is
 *  always "create", so the flag must not veto the localStorage trigger. */
export function shouldShowOnboarding(
  auth: AuthInfo,
  store?: LocalFlagStore,
  workspacesLoadFailed = false,
): boolean {
  if (auth.unreachable) return false;
  if (auth.mode === "oidc") {
    // Degraded load: can't tell "no workspaces" from "fetch broke" — never
    // guess the fork (fail-quiet, spec §5). The next session retries.
    if (workspacesLoadFailed) return false;
    // Strict `=== null` is load-bearing: servers predating this field omit it
    // entirely, so `onboarded_at` reads as `undefined` there, not `null`. That
    // makes this comparison false and onboarding never shows against an old
    // server — the safe failure direction. Loosening this to `== null` would
    // flip it to `true` and show onboarding to every already-onboarded user on
    // an old server.
    return auth.user !== null && auth.user.onboarded_at === null;
  }
  return !localOnboarded(store);
}
