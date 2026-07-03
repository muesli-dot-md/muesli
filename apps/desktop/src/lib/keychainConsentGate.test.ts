import { describe, expect, it } from "vitest";
import { consentDecision } from "./keychainConsentGate";

describe("keychain consent decision (spec 2026-07-02 §3/§6)", () => {
  it("non-macOS always proceeds — the gate is always open and no dialog exists", () => {
    expect(consentDecision(false, false)).toBe("proceed");
    expect(consentDecision(false, true)).toBe("proceed");
  });

  it("macOS with consent already granted proceeds — the caller silently (re)opens the Rust gate", () => {
    // On macOS "proceed" obliges the caller to invoke keychain_consent(true)
    // once per session first: the Rust gate is process state, closed again at
    // every launch.
    expect(consentDecision(true, true)).toBe("proceed");
  });

  it("macOS without consent asks — but only a user-initiated sign-in raises the dialog", () => {
    // The launch path treats "ask" as skip-the-keychain / render logged-out
    // (spec Decisions §3): NEVER a dialog, NEVER an OS prompt at launch.
    expect(consentDecision(true, false)).toBe("ask");
  });
});
