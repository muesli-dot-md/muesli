// Whether the desktop shows first-launch onboarding (BYO storage phase 3,
// spec §2). The local settings flag is primary — desktop "first launch" is not
// "first login"; local-folder-only users never authenticate. A logged-in
// identity already onboarded elsewhere silences it: mark the local flag done,
// show nothing (no double onboarding across devices for server users).

export type OnboardingDecision = "show" | "mark-silently" | "none";

export function onboardingDecision(
  localOnboarded: boolean,
  serverOnboardedAt: string | null | undefined,
): OnboardingDecision {
  if (localOnboarded) return "none";
  if (serverOnboardedAt) return "mark-silently";
  return "show";
}
