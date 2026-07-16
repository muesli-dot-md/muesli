// REST data layer for account-level settings (internal/design/settings.md):
// profile overrides (PATCH /api/me), the delegated API-key lifecycle
// (GET/POST /api/me/tokens, DELETE /api/me/tokens/{id}) and the
// unauthenticated /api/meta version probe (About section).
//
// Deliberately DOM-free and self-contained (no relative imports), so headless
// integration tests (scripts/settings-ui-e2e.mjs) can import this file directly
// under node type-stripping and drive the EXACT functions the UI uses — the
// same convention as workspaceApi.ts.
//
// Server contract notes:
//   - PATCH /api/me distinguishes an ABSENT field (unchanged) from null (clear
//     the override) — JSON.stringify drops undefined keys and keeps nulls, so
//     the patch object maps 1:1 onto that contract.
//   - POST /api/me/tokens returns the raw `mua_` secret exactly once.
//   - non-2xx responses throw AccountApiError (status + plain-text body);
//     callers map 401 → signed out, 403 → agent principal, 503 → open mode.

export type AccountUser = {
  id: string;
  email: string | null;
  display_name: string | null;
  avatar_url: string | null;
  /** First-login onboarding stamp (migration 0016); null = show onboarding. */
  onboarded_at: string | null;
};

/** The two v1 scope presets the server accepts (order-forgiven server-side). */
export type TokenScopes = ["read"] | ["read", "write"];

export type ApiTokenSummary = {
  id: string;
  label: string | null;
  scopes: string[];
  created_at: string;
  expires_at: string | null;
};

export type MintedToken = {
  /** The raw secret — shown once, never retrievable again. */
  token: string;
  id: string;
  label: string;
  scopes: string[];
  expires_at: string | null;
};

export type ServerMeta = {
  version: string;
  commit: string | null;
  mode: "open" | "oidc";
};

export class AccountApiError extends Error {
  status: number;
  bodyText: string;
  constructor(status: number, bodyText: string) {
    super(bodyText.trim() || `HTTP ${status}`);
    this.name = "AccountApiError";
    this.status = status;
    this.bodyText = bodyText;
  }
}

export type AccountApiConfig = {
  httpBase: string;
  /** Override fetch (tests inject a cookie-carrying wrapper); defaults to globalThis.fetch. */
  fetchFn?: typeof fetch;
};

export function createAccountApi(cfg: AccountApiConfig) {
  const fetchFn = cfg.fetchFn ?? ((...args: Parameters<typeof fetch>) => fetch(...args));

  async function req<T>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
    const res = await fetchFn(`${cfg.httpBase}${path}`, {
      method: opts.method ?? "GET",
      credentials: "include",
      headers: opts.body !== undefined ? { "content-type": "application/json" } : undefined,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) throw new AccountApiError(res.status, text);
    // DELETE answers 204 with an empty body.
    return (text ? JSON.parse(text) : undefined) as T;
  }

  return {
    /** Set/clear profile overrides, and/or stamp first-login onboarding.
     *  Absent key = unchanged; null = back to the IdP claim; onboarded only
     *  accepts true (false is the server's 400). */
    patchMe: (patch: {
      display_name?: string | null;
      avatar_url?: string | null;
      onboarded?: boolean;
    }) => req<AccountUser>("/api/me", { method: "PATCH", body: patch }),

    listTokens: () => req<{ tokens: ApiTokenSummary[] }>("/api/me/tokens"),

    mintToken: (input: { label: string; scopes: TokenScopes; expires_in_days?: number | null }) =>
      req<MintedToken>("/api/me/tokens", { method: "POST", body: input }),

    revokeToken: (id: string) =>
      req<void>(`/api/me/tokens/${encodeURIComponent(id)}`, { method: "DELETE" }),

    /** Unauthenticated version probe for the About section. */
    getMeta: () => req<ServerMeta>("/api/meta"),
  };
}

export type AccountApi = ReturnType<typeof createAccountApi>;
