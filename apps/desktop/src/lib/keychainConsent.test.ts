import { describe, it, expect, vi, beforeEach } from "vitest";

// ---- mocks (registered before the module under test is imported) -----------

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
}));

// Mutable platform fake — per-test control of the macOS flag.
const platformState = { macos: true };
vi.mock("$lib/platform.svelte", () => ({
  platform: {
    get macos() {
      return platformState.macos;
    },
    init: vi.fn(async () => {}),
  },
}));

// Mutable settings fake mirroring the real store's consent surface.
const settingsState = {
  keychainConsent: false,
  setKeychainConsent: vi.fn((v: boolean) => {
    settingsState.keychainConsent = v;
  }),
};
vi.mock("$lib/settings.svelte", () => ({ settings: settingsState }));

// The store is a module singleton with per-session state (pending promise,
// once-per-session command latch) — re-import fresh for every test.
async function freshConsent() {
  vi.resetModules();
  return await import("./keychainConsent.svelte");
}

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue(undefined);
  platformState.macos = true;
  settingsState.keychainConsent = false;
  settingsState.setKeychainConsent.mockClear();
});

// ---- tests ------------------------------------------------------------------

describe("keychainGateAtLaunch (spec 2026-07-02 §3 launch row): NEVER a dialog", () => {
  it("non-macOS: true — no dialog, no command", async () => {
    platformState.macos = false;
    const { keychainGateAtLaunch, keychainConsent } = await freshConsent();
    await expect(keychainGateAtLaunch()).resolves.toBe(true);
    expect(keychainConsent.asking).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("macOS, consent previously granted: silently opens the Rust gate (once per session) and proceeds", async () => {
    settingsState.keychainConsent = true;
    const { keychainGateAtLaunch, keychainConsent } = await freshConsent();
    await expect(keychainGateAtLaunch()).resolves.toBe(true);
    await expect(keychainGateAtLaunch()).resolves.toBe(true);
    expect(keychainConsent.asking).toBe(false);
    expect(invoke).toHaveBeenCalledTimes(1); // idempotent per session
    expect(invoke).toHaveBeenCalledWith("keychain_consent", { granted: true });
  });

  it("macOS, no consent: false — skip the keychain, NO dialog, NO command (logged-out launch)", async () => {
    const { keychainGateAtLaunch, keychainConsent } = await freshConsent();
    await expect(keychainGateAtLaunch()).resolves.toBe(false);
    expect(keychainConsent.asking).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
    expect(settingsState.setKeychainConsent).not.toHaveBeenCalled();
  });

  it("macOS, granted, but the command fails: false (fail closed) + console.warn", async () => {
    settingsState.keychainConsent = true;
    invoke.mockRejectedValue(new Error("ipc down"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { keychainGateAtLaunch } = await freshConsent();
    await expect(keychainGateAtLaunch()).resolves.toBe(false);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("ensureKeychainConsent — the sign-in chokepoint (spec 2026-07-02 §3/§5)", () => {
  it("non-macOS: resolves true immediately — no dialog, no command", async () => {
    platformState.macos = false;
    const { ensureKeychainConsent, keychainConsent } = await freshConsent();
    await expect(ensureKeychainConsent()).resolves.toBe(true);
    expect(keychainConsent.asking).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("macOS, consent previously granted: no dialog; opens the Rust gate once per session", async () => {
    settingsState.keychainConsent = true;
    const { ensureKeychainConsent, keychainConsent } = await freshConsent();
    await expect(ensureKeychainConsent()).resolves.toBe(true);
    await expect(ensureKeychainConsent()).resolves.toBe(true);
    expect(keychainConsent.asking).toBe(false);
    expect(invoke).toHaveBeenCalledTimes(1); // idempotent per session
    expect(invoke).toHaveBeenCalledWith("keychain_consent", { granted: true });
  });

  it("macOS, granted, but the command fails: resolves false (fail closed), warns, persists nothing new", async () => {
    settingsState.keychainConsent = true;
    invoke.mockRejectedValue(new Error("ipc down"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { ensureKeychainConsent } = await freshConsent();
    await expect(ensureKeychainConsent()).resolves.toBe(false);
    expect(warn).toHaveBeenCalled();
    expect(settingsState.setKeychainConsent).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("grant: persists the flag, opens the gate, resolves every waiter true — one shared dialog", async () => {
    const { ensureKeychainConsent, keychainConsent } = await freshConsent();
    const a = ensureKeychainConsent();
    const b = ensureKeychainConsent(); // concurrent caller shares the pending dialog
    // Let the async decision run to the ask state.
    await vi.waitFor(() => expect(keychainConsent.asking).toBe(true));
    await keychainConsent.grant();
    await expect(a).resolves.toBe(true);
    await expect(b).resolves.toBe(true);
    expect(settingsState.setKeychainConsent).toHaveBeenCalledWith(true);
    expect(invoke).toHaveBeenCalledWith("keychain_consent", { granted: true });
    expect(keychainConsent.asking).toBe(false);
  });

  it("decline: resolves false, persists NOTHING, invokes nothing — and re-asks on the next sign-in", async () => {
    const { ensureKeychainConsent, keychainConsent } = await freshConsent();
    const p = ensureKeychainConsent();
    await vi.waitFor(() => expect(keychainConsent.asking).toBe(true));
    keychainConsent.decline();
    await expect(p).resolves.toBe(false);
    expect(settingsState.setKeychainConsent).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
    expect(keychainConsent.asking).toBe(false);

    // Next sign-in: the explainer comes back (no sticky decline).
    const again = ensureKeychainConsent();
    await vi.waitFor(() => expect(keychainConsent.asking).toBe(true));
    keychainConsent.decline();
    await expect(again).resolves.toBe(false);
  });

  it("grant with a failing command: fail closed — waiters resolve false, no keyring path opens", async () => {
    invoke.mockRejectedValue(new Error("ipc down"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { ensureKeychainConsent, keychainConsent } = await freshConsent();
    const p = ensureKeychainConsent();
    await vi.waitFor(() => expect(keychainConsent.asking).toBe(true));
    await keychainConsent.grant();
    await expect(p).resolves.toBe(false);
    warn.mockRestore();
  });
});
