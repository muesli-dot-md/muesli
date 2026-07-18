import { describe, expect, it } from "vitest";
import { logoutRedirect } from "./identity";

// RP-initiated logout: the server's POST /auth/logout answer tells the browser
// whether it must visit the IdP's end_session URL (so the IdP SSO session dies
// with the app session) or stay put (local-only logout).
describe("logoutRedirect", () => {
  it("extracts the end_session URL from an OIDC logout response", () => {
    const url =
      "https://auth.muesli.md/oidc/v1/end_session?id_token_hint=a.b.c&post_logout_redirect_uri=https%3A%2F%2Fapp.muesli.md%2F&state=xyz";
    expect(logoutRedirect({ logout_url: url })).toBe(url);
  });

  it("treats a null logout_url as local-only logout (issuer without end_session, e.g. dev dex)", () => {
    expect(logoutRedirect({ logout_url: null })).toBeNull();
  });

  it("is defensive about non-JSON / legacy / malformed bodies", () => {
    // open mode and older servers answer 204 with no body → callers pass null
    expect(logoutRedirect(null)).toBeNull();
    expect(logoutRedirect(undefined)).toBeNull();
    // unexpected shapes never turn into a navigation
    expect(logoutRedirect({})).toBeNull();
    expect(logoutRedirect({ logout_url: "" })).toBeNull();
    expect(logoutRedirect({ logout_url: 42 })).toBeNull();
    expect(logoutRedirect("https://evil.example")).toBeNull();
  });
});
