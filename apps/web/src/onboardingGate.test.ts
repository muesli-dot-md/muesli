import { describe, it, expect } from "vitest";
import {
  localOnboarded,
  markLocalOnboarded,
  ONBOARDED_KEY,
  shouldShowOnboarding,
} from "./onboardingGate";
import type { AuthInfo, Me } from "./identity";

function memStore(initial: Record<string, string> = {}) {
  const m = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
  };
}
const user = (onboarded_at: string | null): Me => ({
  id: "u1",
  email: null,
  display_name: null,
  avatar_url: null,
  onboarded_at,
});

describe("shouldShowOnboarding (spec §2 trigger matrix)", () => {
  it("oidc: shows only for a signed-in user whose flag is null", () => {
    const oidc = (u: Me | null): AuthInfo => ({ mode: "oidc", user: u });
    expect(shouldShowOnboarding(oidc(user(null)), memStore())).toBe(true);
    expect(shouldShowOnboarding(oidc(user("2026-07-02T08:00:00Z")), memStore())).toBe(false);
    // signed out: the app gate shows AuthPage anyway — never onboarding
    expect(shouldShowOnboarding(oidc(null), memStore())).toBe(false);
  });

  it("open mode falls back to the muesli:onboarded localStorage flag", () => {
    const open: AuthInfo = { mode: "open", user: null };
    expect(shouldShowOnboarding(open, memStore())).toBe(true);
    expect(shouldShowOnboarding(open, memStore({ [ONBOARDED_KEY]: "1" }))).toBe(false);
  });

  it("an unreachable /api/me shows nothing — fail-quiet (spec §5)", () => {
    const dead: AuthInfo = { mode: "open", user: null, unreachable: true };
    expect(shouldShowOnboarding(dead, memStore())).toBe(false);
  });

  it("a failed workspace list suppresses onboarding in oidc mode only", () => {
    // oidc: memberships classify the invited-vs-create fork, so a failed list
    // must bail — never guess the fork over a degraded load (spec §5).
    const oidc: AuthInfo = { mode: "oidc", user: user(null) };
    expect(shouldShowOnboarding(oidc, memStore(), true)).toBe(false);
    expect(shouldShowOnboarding(oidc, memStore(), false)).toBe(true);
    // open mode: GET /api/workspaces answers 503 BY DESIGN, so the list
    // "fails" on every load — the flag must not veto the localStorage rule
    // (there are no memberships to misread; the fork is always "create").
    const open: AuthInfo = { mode: "open", user: null };
    expect(shouldShowOnboarding(open, memStore(), true)).toBe(true);
    expect(shouldShowOnboarding(open, memStore({ [ONBOARDED_KEY]: "1" }), true)).toBe(false);
  });

  it("unavailable/throwing storage counts as onboarded — never loop (spec §5)", () => {
    const broken = {
      getItem: (): string | null => {
        throw new Error("denied");
      },
      setItem: (): void => {
        throw new Error("denied");
      },
    };
    expect(localOnboarded(broken)).toBe(true);
    expect(() => markLocalOnboarded(broken)).not.toThrow();
    expect(shouldShowOnboarding({ mode: "open", user: null }, broken)).toBe(false);
  });

  it("markLocalOnboarded writes the exact key/value the spec names", () => {
    const store = memStore();
    markLocalOnboarded(store);
    expect(ONBOARDED_KEY).toBe("muesli:onboarded");
    expect(store.getItem("muesli:onboarded")).toBe("1");
  });
});
