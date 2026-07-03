// Top-level view gate (Commit 1). The app boots into one of four shells:
//   - "loading":  auth hasn't resolved yet (avoid flashing the wrong screen)
//   - "redirect": a signed-out user on the main app → straight to the server's
//                 /auth/login (which 303s into the IdP). No interstitial, no
//                 extra click — App.svelte performs the navigation.
//   - "auth":     the dedicated sign-in fallback page, ONLY on its own route
//                 (#~login) — kept routable as the organization-SSO chooser.
//   - "app":      everything else → the real app (Home / DocApp / Settings)
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

export type AppView = "loading" | "redirect" | "auth" | "app";

/** Decide which top-level shell to render.
 *
 *  @param route the current parsed hash route
 *  @param auth  the resolved auth info, or null while /api/me is in flight
 */
export function decideAppView(route: Route, auth: AuthInfo | null): AppView {
  // A valid share link is a guest's only door in — never gate it, even before
  // auth resolves, so the shared doc opens immediately for an anonymous visitor.
  if (route.kind === "doc" && route.shareToken) return "app";

  // Auth still loading: hold the splash rather than flash Home or a redirect.
  if (auth === null) return "loading";

  // OIDC mode, signed out: the explicit #~login route renders the SSO-chooser
  // fallback page; everywhere else goes DIRECTLY into the IdP redirect.
  if (auth.mode === "oidc" && auth.user === null) {
    return route.kind === "login" ? "auth" : "redirect";
  }

  // Open mode (no accounts) or an authenticated user → the real app.
  return "app";
}
