import { describe, expect, it } from "vitest";
import { onboardingDecision } from "./onboardingGate";

describe("desktop onboarding decision (spec §2)", () => {
  it("first launch with no (or never-onboarded) server identity shows onboarding", () => {
    expect(onboardingDecision(false, null)).toBe("show");
    expect(onboardingDecision(false, undefined)).toBe("show");
  });
  it("an identity already onboarded on another device silences it (mark local, show nothing)", () => {
    expect(onboardingDecision(false, "2026-07-02T08:00:00Z")).toBe("mark-silently");
  });
  it("the local flag wins once set — nothing ever shows again", () => {
    expect(onboardingDecision(true, null)).toBe("none");
    expect(onboardingDecision(true, "2026-07-02T08:00:00Z")).toBe("none");
  });
});
