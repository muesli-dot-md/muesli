// Whether the desktop may touch the OS Keychain without asking (spec
// 2026-07-02). Pure decision logic — the house pattern from onboardingGate.ts —
// so the branching is table-testable apart from the dialog/invoke plumbing in
// keychainConsent.svelte.ts.
//
// - "proceed": no dialog needed. Off macOS the Rust gate is always open; on
//   macOS it means consent was granted on a previous run, and the caller must
//   silently (re)open the process-state Rust gate via the keychain_consent
//   command (once per session) before touching the keyring.
// - "ask": no consent yet. ONLY a user-initiated sign-in raises the explainer
//   (spec Decisions §3); the launch path treats "ask" as skip-the-keychain and
//   renders logged-out — never a dialog, never an OS prompt. A user who only
//   works locally and never signs in never sees either.

export type KeychainConsentDecision = "proceed" | "ask";

export function consentDecision(
  isMac: boolean,
  consentGranted: boolean,
): KeychainConsentDecision {
  if (!isMac) return "proceed";
  if (consentGranted) return "proceed";
  return "ask";
}
