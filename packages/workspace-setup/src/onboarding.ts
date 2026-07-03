// The first-login onboarding flow's logic (BYO storage phase 3, spec 2026-07-02),
// kept rune-free so it unit-tests in node — the machine.ts/sharepoint.ts split.
// OnboardingFlow.svelte wraps the flow in $state and does the rendering; all IO
// (stamping flags, opening wizards/pickers) goes through the injected
// OnboardingHost the same way the wizard talks to WizardHost.

import type { WizardKey } from "./copy";

/** Which Screen 3 the host wants (spec §3). Web computes create-vs-invited from
 *  its workspace list; the desktop is always the local-vs-server fork. */
export type OnboardingContext =
  | { kind: "create" }
  | { kind: "invited"; workspaceName: string }
  | { kind: "desktop" };

export type OnboardingAction = "create" | "open-invited" | "local" | "server";

export type OnboardingHost = {
  context: OnboardingContext;
  /** Stamp the onboarded flag(s) and close the flow. skipped=true when the user
   *  bailed early (skip is a decision, not a snooze — it stamps too). MUST close
   *  even when stamping fails: errors are console.warn-level only (spec §5). */
  finish(skipped: boolean): Promise<void>;
  /** Screen-3 fork handover: open the wizard / jump to the workspace / picker /
   *  login. The flow calls finish(false) FIRST (spec §3: stamped at wizard-open,
   *  an abandoned wizard must not re-trigger onboarding). */
  primaryAction(action: OnboardingAction): void;
  /** Optional i18n override; defaults to built-in English (copy.ts). */
  t?: (key: string, params?: Record<string, string | number>) => string;
};

export type OnboardingScreen = "welcome" | "concepts" | "action";

const ORDER: OnboardingScreen[] = ["welcome", "concepts", "action"];

export type OnboardingState = {
  screen: OnboardingScreen;
  screenIndex: number;
  totalScreens: number;
};

export function createOnboardingFlow() {
  const state: OnboardingState = {
    screen: "welcome",
    screenIndex: 0,
    totalScreens: ORDER.length,
  };

  function goto(i: number) {
    state.screenIndex = i;
    state.screen = ORDER[i];
  }

  /** Advance one screen; false at the action screen (it exits via the host). */
  function next(): boolean {
    if (state.screenIndex >= ORDER.length - 1) return false;
    goto(state.screenIndex + 1);
    return true;
  }

  /** Step back one screen; false (no-op) at the first. */
  function back(): boolean {
    if (state.screenIndex === 0) return false;
    goto(state.screenIndex - 1);
    return true;
  }

  return { state, next, back };
}

/** The primary actions Screen 3 offers per context — the fork (spec §3). */
export function forkActions(context: OnboardingContext): OnboardingAction[] {
  switch (context.kind) {
    case "create":
      return ["create"];
    case "invited":
      return ["open-invited"];
    case "desktop":
      return ["local", "server"];
  }
}

/** Split a raw template around a {param} placeholder so markup can wrap the
 *  interpolated value — the invited headline puts the workspace name in
 *  Multica's italic-serif <em> without trusting the catalog with markup.
 *  A template missing the placeholder degrades to [whole, ""] (plain text). */
export function splitAtParam(template: string, param: string): [string, string] {
  const token = `{${param}}`;
  const i = template.indexOf(token);
  if (i === -1) return [template, ""];
  return [template.slice(0, i), template.slice(i + token.length)];
}

/** The copy keys each screen renders per context. OnboardingFlow.svelte reads
 *  the same names; the copy-key existence test walks this (spec §6). */
export function screenCopyKeys(
  screen: OnboardingScreen,
  context: OnboardingContext,
): WizardKey[] {
  switch (screen) {
    case "welcome":
      return ["onboarding.welcomeTitle", "onboarding.welcomeBody", "onboarding.skip", "wizard.next", "wizard.stepOf"];
    case "concepts":
      return [
        "onboarding.conceptsTitle",
        "onboarding.conceptWorkspace",
        "onboarding.conceptWorkspaceBody",
        "onboarding.conceptDocument",
        "onboarding.conceptDocumentBody",
        "onboarding.conceptStorage",
        "onboarding.conceptStorageBody",
        "onboarding.conceptSharing",
        "onboarding.conceptSharingBody",
        "onboarding.skip",
        "wizard.next",
        "wizard.back",
        "wizard.stepOf",
      ];
    case "action":
      switch (context.kind) {
        case "create":
          return ["onboarding.createTitle", "onboarding.createBody", "onboarding.createButton", "onboarding.skip", "wizard.back", "wizard.stepOf"];
        case "invited":
          return ["onboarding.invitedTitle", "onboarding.invitedBody", "onboarding.invitedButton", "onboarding.skip", "wizard.back", "wizard.stepOf"];
        case "desktop":
          return [
            "onboarding.desktopTitle",
            "onboarding.desktopBody",
            "onboarding.localCard",
            "onboarding.localCardBody",
            "onboarding.serverCard",
            "onboarding.serverCardBody",
            "onboarding.skip",
            "wizard.back",
            "wizard.stepOf",
          ];
      }
  }
}
