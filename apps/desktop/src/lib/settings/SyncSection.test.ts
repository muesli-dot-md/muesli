// @vitest-environment jsdom
// Invariant: Sync must never render auth controls (Sign in / Sign out) — auth
// actions live exclusively in Profile. Sync only reports account/connection
// state, with an optional "Go to Profile" navigation affordance, and its
// signed-in detection must agree with Profile's (a sub-only OIDC identity
// still counts as signed in).
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { mount, unmount, flushSync } from "svelte";
import SyncSection from "./SyncSection.svelte";
import { workspaces } from "$lib/workspaces.svelte";
import type { Identity } from "$lib/tauri";

const identity: Identity = {
  server: "wss://muesli.example.com/ws",
  id: "u1",
  display_name: "Ada Lovelace",
  email: "ada@example.com",
  avatar_url: null,
  mode: "oidc",
  onboarded_at: null,
};

let host: HTMLElement | undefined;
let component: ReturnType<typeof mount> | undefined;

afterEach(() => {
  if (component) unmount(component);
  host?.remove();
  component = undefined;
  host = undefined;
});

beforeEach(() => {
  workspaces.identity = null;
  workspaces.error = null;
});

function render(onNavigateToProfile?: () => void) {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(SyncSection, {
    target: host,
    props: { statusLabel: "disconnected", onNavigateToProfile },
  });
  flushSync();
  return host;
}

describe("SyncSection", () => {
  it("renders no button and hints at Profile when signed out", () => {
    const el = render();
    expect(el.textContent).toContain("Not signed in");
    expect(el.textContent).toContain("Profile");
    // No login button: the only interactive controls left are the sync
    // toggle and the server URL text field, both <input>, never <button>.
    expect(el.querySelector("button")).toBeNull();
  });

  it("renders no sign-out button when signed in, just the account summary", () => {
    workspaces.identity = identity;
    const el = render();
    expect(el.textContent).toContain("Signed in as ada@example.com");
    expect(el.textContent).toContain("Profile");
    expect(el.textContent).not.toContain("Sign out");
    expect(el.querySelector("button")).toBeNull();
  });

  it("renders the open-server hint with no button when the server needs no sign-in", () => {
    workspaces.identity = { ...identity, mode: "open", email: null, display_name: null };
    const el = render();
    expect(el.textContent).toContain("Open server");
    expect(el.querySelector("button")).toBeNull();
  });

  it("treats a sub-only OIDC identity (no email/display_name) as signed in", () => {
    workspaces.identity = { ...identity, email: null, display_name: null };
    const el = render();
    expect(el.textContent).toContain("Signed in");
    expect(el.textContent).not.toContain("Not signed in");
  });

  it("renders a Go to Profile button when onNavigateToProfile is provided, signed out", () => {
    const onNavigateToProfile = vi.fn();
    const el = render(onNavigateToProfile);
    const button = el.querySelector("button");
    expect(button?.textContent).toContain("Go to Profile");
    button?.click();
    expect(onNavigateToProfile).toHaveBeenCalledOnce();
  });

  it("renders a Go to Profile button when onNavigateToProfile is provided, signed in", () => {
    workspaces.identity = identity;
    const onNavigateToProfile = vi.fn();
    const el = render(onNavigateToProfile);
    const button = el.querySelector("button");
    expect(button?.textContent).toContain("Go to Profile");
    button?.click();
    expect(onNavigateToProfile).toHaveBeenCalledOnce();
  });
});
