import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock the binding layer: each store method must call exactly these, in order.
const calls: string[] = [];
vi.mock("$lib/tauri", () => ({
  promoteWorkspace: vi.fn(async () => {
    calls.push("promoteWorkspace");
    return "srv-promoted";
  }),
  registerClonedWorkspace: vi.fn(async () => {
    calls.push("registerClonedWorkspace");
  }),
  // Pulled in by refresh(); keep them inert so refresh() resolves.
  hasToken: vi.fn(async () => false),
  currentIdentity: vi.fn(async () => null),
  listWorkspacesMerged: vi.fn(async () => {
    calls.push("refresh");
    return [];
  }),
  serverLogin: vi.fn(),
  serverLogout: vi.fn(),
  registerLocalWorkspace: vi.fn(),
  cloneWorkspace: vi.fn(),
}));

// openFolderWithSync delegates to these; stub them so no real daemon/tree work runs.
vi.mock("$lib/workspace.svelte", () => ({
  workspace: { openWorkspace: vi.fn(async () => calls.push("openWorkspace")), root: "" },
}));
vi.mock("$lib/sync/daemon.svelte", () => ({
  daemon: {
    start: vi.fn(async () => calls.push("daemon.start")),
    stop: vi.fn(async () => calls.push("daemon.stop")),
  },
}));
vi.mock("$lib/settings.svelte", () => ({
  settings: { wsBase: "ws://localhost:8787/ws" },
}));

// Keychain-consent plumbing: launch gate open and consent granted by default so
// existing flows run; individual tests flip them with mockResolvedValueOnce.
const launchGate = vi.fn(async () => true);
const consent = vi.fn(async () => true);
vi.mock("$lib/keychainConsent.svelte", () => ({
  keychainGateAtLaunch: () => launchGate(),
  ensureKeychainConsent: () => consent(),
}));

import { workspaces } from "./workspaces.svelte";
import type { Identity, WorkspaceView } from "./tauri";

beforeEach(() => {
  calls.length = 0;
  workspaces.identity = { server: "ws://localhost:8787/ws", id: null, display_name: null, email: null, avatar_url: null, mode: "open", onboarded_at: null };
  workspaces.busy = false;
  workspaces.error = null;
  launchGate.mockClear();
  consent.mockClear();
});

describe("workspaces store — Plan 5 promotion", () => {
  it("finishRemoteWorkspace: registers clone → opens+syncs → refreshes; busy flips", async () => {
    const p = workspaces.finishRemoteWorkspace("srv-new", "Notes", "/Users/me/Notes");
    expect(workspaces.busy).toBe(true); // set synchronously before the first await resolves
    await p;
    expect(workspaces.busy).toBe(false);
    expect(calls).toEqual([
      "registerClonedWorkspace",
      "openWorkspace",
      "daemon.start",
      "refresh",
    ]);
  });

  it("promoteLocalToRemote: promotes → opens+syncs the SAME path → refreshes", async () => {
    const view: WorkspaceView = {
      id: "/Users/me/Notes",
      server: null,
      name: "Notes",
      local_path: "/Users/me/Notes",
      local_only: true,
      state: "local-only",
    };
    await workspaces.promoteLocalToRemote(view);
    expect(workspaces.busy).toBe(false);
    expect(calls).toEqual(["promoteWorkspace", "openWorkspace", "daemon.start", "refresh"]);
  });

  it("finishRemoteWorkspace: no-ops (no commands) when there's no active server", async () => {
    const { settings } = await import("$lib/settings.svelte");
    settings.wsBase = "";
    await workspaces.finishRemoteWorkspace("srv-new", "Notes", "/Users/me/Notes");
    expect(calls).toEqual([]);
    expect(workspaces.busy).toBe(false);
    settings.wsBase = "ws://localhost:8787/ws"; // restore for any later tests in this file
  });
});

describe("workspaces store — keychain consent (spec 2026-07-02 §3)", () => {
  it("refresh(): launch gate closed → no token read, logged-out list — and NEVER the dialog chokepoint", async () => {
    launchGate.mockResolvedValueOnce(false);
    const tauri = await import("$lib/tauri");
    vi.mocked(tauri.hasToken).mockClear();
    vi.mocked(tauri.listWorkspacesMerged).mockClear();

    await workspaces.refresh();

    expect(consent).not.toHaveBeenCalled(); // launch never routes through ensureKeychainConsent
    expect(vi.mocked(tauri.hasToken)).not.toHaveBeenCalled();
    expect(vi.mocked(tauri.listWorkspacesMerged)).toHaveBeenCalledWith(null);
    expect(workspaces.identity).toBeNull();
    expect(workspaces.error).toBeNull();
  });

  it("refresh(): launch gate open → the token check runs as before", async () => {
    const tauri = await import("$lib/tauri");
    vi.mocked(tauri.hasToken).mockClear();

    await workspaces.refresh();

    expect(launchGate).toHaveBeenCalled();
    expect(consent).not.toHaveBeenCalled();
    expect(vi.mocked(tauri.hasToken)).toHaveBeenCalled();
  });

  it("login(): consent declined → aborts quietly (no login attempt, no error)", async () => {
    consent.mockResolvedValueOnce(false);
    const tauri = await import("$lib/tauri");
    vi.mocked(tauri.serverLogin).mockClear();

    await workspaces.login();

    expect(vi.mocked(tauri.serverLogin)).not.toHaveBeenCalled();
    expect(workspaces.error).toBeNull();
  });

  it("login(): after a grant, an already-stored token signs in WITHOUT a new device flow", async () => {
    const tauri = await import("$lib/tauri");
    vi.mocked(tauri.serverLogin).mockClear();
    const existing: Identity = {
      server: "http://localhost:8787",
      id: "u1",
      display_name: null,
      email: null,
      avatar_url: null,
      mode: "oidc",
      onboarded_at: null,
    };
    // Two Once values each: the login re-check consumes the first, the
    // refresh() that follows consumes the second (defaults stay untouched).
    vi.mocked(tauri.hasToken).mockResolvedValueOnce(true).mockResolvedValueOnce(true);
    vi.mocked(tauri.currentIdentity)
      .mockResolvedValueOnce(existing)
      .mockResolvedValueOnce(existing);

    await workspaces.login();

    expect(vi.mocked(tauri.serverLogin)).not.toHaveBeenCalled();
    expect(vi.mocked(tauri.currentIdentity)).toHaveBeenCalled();
    expect(workspaces.identity).toEqual(existing);
  });

  it("login(): no stored token after consent → proceeds into the normal device flow", async () => {
    const tauri = await import("$lib/tauri");
    vi.mocked(tauri.serverLogin).mockClear();
    vi.mocked(tauri.serverLogin).mockResolvedValueOnce({
      server: "http://localhost:8787",
      id: "u1",
      display_name: null,
      email: null,
      avatar_url: null,
      mode: "oidc",
      onboarded_at: null,
    });

    await workspaces.login(); // hasToken default mock resolves false

    expect(vi.mocked(tauri.serverLogin)).toHaveBeenCalled();
  });
});
