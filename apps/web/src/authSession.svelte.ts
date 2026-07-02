// App-level auth resolution (Commit 1). The top-level shell needs to know, once,
// whether the visitor is signed in so it can choose between the real app and the
// dedicated AuthPage. fetchMe() is hit a single time on boot and the result is
// exposed reactively; `auth` is null until /api/me answers (the gate treats that
// as "loading"). Home and DocApp still fetch their own copy for their internal
// needs — this store only drives the top-level gate. Yjs-free, identity.ts only.

import { fetchMe, type AuthInfo } from "./identity";

let auth: AuthInfo | null = $state(null);
let started = false;

/** Kick off the one-time /api/me probe (idempotent). */
function ensureLoaded(): void {
  if (started) return;
  started = true;
  fetchMe().then((a) => (auth = a));
}

ensureLoaded();

export const authSession = {
  /** The resolved auth info, or null while /api/me is still in flight. */
  get current(): AuthInfo | null {
    return auth;
  },
  /** Re-probe (e.g. after the sign-out flow drops the cookie). */
  refresh(): void {
    fetchMe().then((a) => (auth = a));
  },
};
