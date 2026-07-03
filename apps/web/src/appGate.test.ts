import { describe, expect, it } from "vitest";
import { decideAppView } from "./appGate";
import type { AuthInfo } from "./identity";
import type { Route } from "./route.svelte";

const home: Route = { kind: "home", view: "root", folderId: null };
const settings: Route = { kind: "settings", section: "profile" };
const ownDoc: Route = { kind: "doc", docId: "my-notes", shareToken: null };
const sharedDoc: Route = { kind: "doc", docId: "my-notes", shareToken: "tok-123" };

const open: AuthInfo = { mode: "open", user: null };
const signedOut: AuthInfo = { mode: "oidc", user: null };
const signedIn: AuthInfo = {
  mode: "oidc",
  user: { id: "u1", email: "a@b.com", display_name: "Al", avatar_url: null, onboarded_at: null },
};

describe("decideAppView", () => {
  it("holds the splash while auth is loading on gated surfaces", () => {
    expect(decideAppView(home, null)).toBe("loading");
    expect(decideAppView(ownDoc, null)).toBe("loading");
    expect(decideAppView(settings, null)).toBe("loading");
  });

  it("sends a signed-out OIDC user to the auth page on the main app", () => {
    expect(decideAppView(home, signedOut)).toBe("auth");
    expect(decideAppView(settings, signedOut)).toBe("auth");
    expect(decideAppView(ownDoc, signedOut)).toBe("auth");
  });

  it("renders the real app for an authenticated user", () => {
    expect(decideAppView(home, signedIn)).toBe("app");
    expect(decideAppView(ownDoc, signedIn)).toBe("app");
    expect(decideAppView(settings, signedIn)).toBe("app");
  });

  it("never gates open mode — the whole app is public", () => {
    expect(decideAppView(home, open)).toBe("app");
    expect(decideAppView(ownDoc, open)).toBe("app");
    expect(decideAppView(sharedDoc, open)).toBe("app");
  });

  it("PRESERVES guest share access: a share-token doc opens for a signed-out user", () => {
    expect(decideAppView(sharedDoc, signedOut)).toBe("app");
    // even before auth resolves, so the shared doc shows immediately
    expect(decideAppView(sharedDoc, null)).toBe("app");
    expect(decideAppView(sharedDoc, signedIn)).toBe("app");
  });

  it("does NOT treat a token-less doc route as guest access", () => {
    expect(decideAppView(ownDoc, signedOut)).toBe("auth");
  });
});
