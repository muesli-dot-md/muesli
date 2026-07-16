// @vitest-environment jsdom
// Invariant: Profile is the sole home for auth controls. It must offer Sign
// in when signed out, Sign out when signed in, and render workspaces.error
// next to whichever control is showing so a failed sign-in always has both
// the reason and a retry in one place.
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mount, unmount, flushSync } from "svelte";
import ProfileSection from "./ProfileSection.svelte";
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

function render() {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(ProfileSection, { target: host });
  flushSync();
  return host;
}

describe("ProfileSection", () => {
  it("offers Sign in when signed out", () => {
    const el = render();
    expect(el.textContent).toContain("Not signed in");
    const button = el.querySelector("button");
    expect(button?.textContent).toContain("Sign in");
  });

  it("offers Sign out when signed in", () => {
    workspaces.identity = identity;
    const el = render();
    expect(el.textContent).toContain("Ada Lovelace");
    const buttons = [...el.querySelectorAll("button")];
    expect(buttons.some((b) => b.textContent?.includes("Sign out"))).toBe(true);
  });

  it("renders no sign-in-method row (the IdP is the server's concern, not the user's)", () => {
    workspaces.identity = identity;
    const el = render();
    expect(el.textContent).not.toContain("Single sign-on");
    expect(el.textContent).not.toContain("signed in through your server's identity provider");
  });

  it("treats a sub-only OIDC identity (no email/display_name) as signed in", () => {
    workspaces.identity = { ...identity, email: null, display_name: null };
    const el = render();
    expect(el.textContent).not.toContain("Not signed in");
    const buttons = [...el.querySelectorAll("button")];
    expect(buttons.some((b) => b.textContent?.includes("Sign out"))).toBe(true);
  });

  it("shows the sign-in error next to the retry control after a failed sign-in", () => {
    workspaces.identity = null;
    workspaces.error = "Sign-in failed: could not reach server";
    const el = render();
    expect(el.textContent).toContain("Not signed in");
    expect(el.textContent).toContain("Sign-in failed: could not reach server");
    const button = el.querySelector("button");
    expect(button?.textContent).toContain("Sign in");
  });
});
