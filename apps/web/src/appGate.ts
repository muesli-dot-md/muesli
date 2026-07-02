// Top-level view gate (Commit 1). The app boots into one of three shells:
//   - "loading": auth hasn't resolved yet (avoid flashing the wrong screen)
//   - "auth":    a signed-out user on the main app → the dedicated AuthPage
//   - "app":     everything else → the real app (Home / DocApp / Settings)
//
// The single subtlety is GUEST SHARE ACCESS (ADR 0011): a signed-out visitor
// who opens a document with a `?share=<token>` link must still reach that doc.
// So a doc route carrying a share token is always "app", regardless of auth —
// only the home/dashboard/own-document surfaces are gated behind sign-in.
//
// Open mode (no accounts at all) is never gated: there is no one to sign in as,
// so the whole app is public. This module is yjs-free and DOM-free so the
// decision is unit-testable in the node test environment.

import type { AuthInfo } from "./identity";
import type { Route } from "./route.svelte";

export type AppView = "loading" | "auth" | "app";

/** Decide which top-level shell to render.
 *
 *  @param route the current parsed hash route
 *  @param auth  the resolved auth info, or null while /api/me is in flight
 */
export function decideAppView(route: Route, auth: AuthInfo | null): AppView {
  // A valid share link is a guest's only door in — never gate it, even before
  // auth resolves, so the shared doc opens immediately for an anonymous visitor.
  if (route.kind === "doc" && route.shareToken) return "app";

  // Auth still loading: hold the splash rather than flash Home or the AuthPage.
  if (auth === null) return "loading";

  // Open mode (no accounts) or an authenticated user → the real app.
  // OIDC mode with no user → the dedicated sign-in page.
  if (auth.mode === "oidc" && auth.user === null) return "auth";
  return "app";
}
