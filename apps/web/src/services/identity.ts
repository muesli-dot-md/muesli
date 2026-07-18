// Identity + server endpoints, deliberately free of yjs/websocket imports: the
// Drive-style home screen (Home.svelte) imports this module without spinning up
// a doc room. Routing lives in route.svelte.ts (reactive hash router); per-doc
// collab state lives in session.ts.

import { colorFromId } from "./presence";

// Dev: vite serves the app, the server is on :8787. Prod: the server serves the app
// (single image, ADR 0017), so the websocket is same-origin.
export const wsUrl =
  import.meta.env.VITE_MUESLI_WS ??
  (import.meta.env.DEV
    ? "ws://localhost:8787/ws"
    : `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
// The server's HTTP side (auth + share API) is the same host as the websocket.
export const httpBase = wsUrl.replace(/^ws/, "http").replace(/\/ws$/, "");

// --- presence identity ----------------------------------------------------------
// Picked once per page load so the same name/color follows the user across doc
// switches (sessions are per-doc, the person is not).

const PALETTE = [
  { color: "#f59e0b", light: "#f59e0b33" },
  { color: "#10b981", light: "#10b98133" },
  { color: "#3b82f6", light: "#3b82f633" },
  { color: "#ef4444", light: "#ef444433" },
  { color: "#8b5cf6", light: "#8b5cf633" },
  { color: "#ec4899", light: "#ec489933" },
];

const NAMES = ["Oat", "Almond", "Raisin", "Hazelnut", "Berry", "Honey", "Flake", "Seed"];

const pick = <T>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];

// The presence identity published into awareness. `userId` is the dedup key —
// null until /api/me resolves an authenticated user (stays null in open mode, so
// each guest tab stays its own indicator, keyed by awareness clientId downstream).
// The random palette color is the guest default; once a userId resolves, the color
// is re-derived from it (colorFromId) so the same person is one stable color across
// tabs and apps. setMeIdentity() performs that update.
export const me: {
  userId: string | null;
  name: string;
  color: string;
  light: string;
  avatar: string | null;
} = {
  userId: null,
  name: `${pick(NAMES)} ${Math.floor(Math.random() * 90) + 10}`,
  avatar: null,
  ...pick(PALETTE),
};

/** Promote `me` to an authenticated identity once /api/me resolves. Re-derives a
 *  stable color from the user id so the person looks the same everywhere. */
export function setMeIdentity(user: Me): void {
  me.userId = user.id;
  if (user.display_name) me.name = user.display_name;
  me.avatar = user.avatar_url ?? null;
  const { color, colorLight } = colorFromId(user.id);
  me.color = color;
  me.light = colorLight;
}

// --- identity (ADR 0012): the server tells us whether auth is even on. ---------

export type Me = {
  id: string;
  email: string | null;
  display_name: string | null;
  avatar_url: string | null;
  /** First-login onboarding stamp (migration 0016); null = show onboarding. */
  onboarded_at: string | null;
};
export type AuthInfo = {
  mode: "open" | "oidc";
  user: Me | null;
  /** Which storage backends the server can actually connect (env-derived flags,
   *  e.g. {s3, github, gdrive, sharepoint}) — the workspace wizard's picker
   *  disables the rest. Absent on older servers and on the unreachable fallback;
   *  consumers parse it defensively (parseStorageCapabilities fails open). */
  storage?: Record<string, boolean>;
  /** True when /api/me was UNREACHABLE (network/CORS) rather than a real
   *  open-mode answer — fail-quiet consumers (onboarding) then do nothing. */
  unreachable?: boolean;
};

export async function fetchMe(): Promise<AuthInfo> {
  try {
    const res = await fetch(`${httpBase}/api/me`, { credentials: "include" });
    if (!res.ok) throw new Error(`${res.status}`);
    return (await res.json()) as AuthInfo;
  } catch (e) {
    // Server unreachable OR a credentialed-CORS mismatch (e.g. vite hopped off the
    // MUESLI_WEB_ORIGIN port). Behave like open mode so the UI stays usable, but say so.
    console.warn(
      `muesli: /api/me unreachable from origin ${location.origin} — falling back to open-mode UI. ` +
        "If the editor connects but auth/history/comments fail, check that this origin matches " +
        "the server's MUESLI_WEB_ORIGIN.",
      e,
    );
    return { mode: "open", user: null, unreachable: true };
  }
}

/** The post-login destination: the current URL — except on the #~login fallback
 *  page, where a completed sign-in should land on the app, not back on the chooser. */
function nextAfterLogin(): string {
  return location.hash.startsWith("#~login")
    ? location.href.slice(0, location.href.indexOf("#"))
    : location.href;
}

export function loginUrl(): string {
  const next = encodeURIComponent(nextAfterLogin());
  return `${httpBase}/auth/login?next=${next}`;
}

/** Organization SSO (Phase 5): the server maps the email's domain to its workspace IdP
 *  and 302s into /auth/login?issuer=… — or answers 404 when no workspace claims it. */
export function orgLoginUrl(email: string): string {
  const next = encodeURIComponent(nextAfterLogin());
  return `${httpBase}/auth/login/select?email=${encodeURIComponent(email)}&next=${next}`;
}

/** The end_session URL a logout response tells the browser to visit, if any.
 *  Defensive: open mode answers 204 with no body (null here), older servers answered
 *  204 in OIDC mode too, and an issuer without RP-initiated logout (dev dex) yields
 *  `logout_url: null` — all of those mean "local logout only, stay in the app". */
export function logoutRedirect(body: unknown): string | null {
  if (body !== null && typeof body === "object" && "logout_url" in body) {
    const url = (body as { logout_url?: unknown }).logout_url;
    if (typeof url === "string" && url) return url;
  }
  return null;
}

/** Sign out. Kills the app session, then — when the server answers with the issuer's
 *  end_session URL (OIDC RP-initiated logout) — navigates the browser there so the
 *  IdP's SSO session dies too. Without that hop the app gate's next /auth/login would
 *  silently sign the user right back in. Resolves true when the browser is off to the
 *  IdP (callers must do nothing more); false means local-only logout (open mode, or
 *  an issuer without end_session support) and the caller keeps its usual after-logout
 *  behavior. */
export async function logout(): Promise<boolean> {
  const res = await fetch(`${httpBase}/auth/logout`, { method: "POST", credentials: "include" });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // 204 (open mode / older server): no body, nothing to navigate to.
  }
  const url = logoutRedirect(body);
  if (url) {
    window.location.assign(url);
    return true;
  }
  return false;
}
