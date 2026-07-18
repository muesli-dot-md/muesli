// App-level auth resolution — React/zustand port of src/authSession.svelte.ts.
// The top-level shell needs to know, once, whether the visitor is signed in so
// it can choose between the real app and the dedicated AuthPage. fetchMe() is
// hit a single time on boot and the result is exposed reactively; `current` is
// null until /api/me answers (the gate treats that as "loading"). Home and
// DocApp still fetch their own copy for their internal needs — this store only
// drives the top-level gate. Yjs-free, identity.ts only.

import { createStore } from "zustand/vanilla";
import { useStore } from "zustand";
import { fetchMe, type AuthInfo } from "@/services/identity";

export interface AuthSessionState {
  /** The resolved auth info, or null while /api/me is still in flight. */
  current: AuthInfo | null;
  /** Re-probe (e.g. after the sign-out flow drops the cookie). */
  refresh(): void;
}

let started = false;

export const authSessionStore = createStore<AuthSessionState>()((set) => ({
  current: null,
  refresh() {
    void fetchMe().then((a) => set({ current: a }));
  },
}));

/** Kick off the one-time /api/me probe (idempotent; runs on module import,
 *  exactly like the Svelte original's self-start). */
function ensureLoaded(): void {
  if (started || typeof window === "undefined") return;
  started = true;
  void fetchMe().then((a) => authSessionStore.setState({ current: a }));
}

ensureLoaded();

export const useAuthSession = <T>(sel: (s: AuthSessionState) => T): T =>
  useStore(authSessionStore, sel);
