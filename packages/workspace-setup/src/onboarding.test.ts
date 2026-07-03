import { describe, it, expect } from "vitest";
import { EN } from "./copy";
import {
  createOnboardingFlow,
  forkActions,
  screenCopyKeys,
  splitAtParam,
  type OnboardingContext,
} from "./onboarding";

const CONTEXTS: OnboardingContext[] = [
  { kind: "create" },
  { kind: "invited", workspaceName: "Team Docs" },
  { kind: "desktop" },
];
const SCREENS = ["welcome", "concepts", "action"] as const;

describe("onboarding flow", () => {
  it("walks welcome → concepts → action and back, refusing to fall off the ends", () => {
    const f = createOnboardingFlow();
    expect(f.state.screen).toBe("welcome");
    expect(f.state.screenIndex).toBe(0);
    expect(f.state.totalScreens).toBe(3);
    expect(f.next()).toBe(true);
    expect(f.state.screen).toBe("concepts");
    expect(f.state.screenIndex).toBe(1);
    expect(f.next()).toBe(true);
    expect(f.state.screen).toBe("action");
    // the action screen finishes through the host, never through next()
    expect(f.next()).toBe(false);
    expect(f.state.screen).toBe("action");
    expect(f.back()).toBe(true);
    expect(f.state.screen).toBe("concepts");
    expect(f.back()).toBe(true);
    expect(f.back()).toBe(false); // no-op at the first screen
    expect(f.state.screen).toBe("welcome");
  });

  it("forks the action screen by context kind (spec §3)", () => {
    expect(forkActions({ kind: "create" })).toEqual(["create"]);
    expect(forkActions({ kind: "invited", workspaceName: "x" })).toEqual(["open-invited"]);
    expect(forkActions({ kind: "desktop" })).toEqual(["local", "server"]);
  });

  it("every screen's copy keys exist in the built-in English catalog", () => {
    for (const ctx of CONTEXTS) {
      for (const screen of SCREENS) {
        for (const key of screenCopyKeys(screen, ctx)) {
          expect(EN[key], `${screen}/${ctx.kind}/${key}`).toBeTruthy();
        }
      }
    }
  });

  it("the skip affordance is part of every screen (spec: skip always visible)", () => {
    for (const ctx of CONTEXTS) {
      for (const screen of SCREENS) {
        expect(screenCopyKeys(screen, ctx)).toContain("onboarding.skip");
      }
    }
  });

  it("splitAtParam splits the invited headline around {workspace}", () => {
    expect(splitAtParam("You're already in {workspace}", "workspace"))
      .toEqual(["You're already in ", ""]);
    expect(splitAtParam("{workspace} — schon dabei", "workspace"))
      .toEqual(["", " — schon dabei"]);
    // a catalog that lost the placeholder degrades to plain text, not a crash
    expect(splitAtParam("Já estás lá", "workspace")).toEqual(["Já estás lá", ""]);
  });
});
