// @vitest-environment jsdom
// Invariants pinned here:
//   - Avatar edits (pick AND remove) PATCH /api/me the moment they happen and
//     the server response flows straight to `onupdated` (the shared-user-store
//     seam) — there is no picked-but-unsaved local state a closed settings
//     page could silently discard, which is exactly how avatar changes used
//     to vanish. (SettingsPage's own forwarding of `onupdated` into
//     `onuserchanged` is pinned in SettingsPage.test.ts.)
//   - PATCH responses are full user snapshots, so a stale (superseded)
//     response is dropped, never applied or forwarded out of order.
//   - Profile carries no User ID / identity-provider rows and no helper copy.
// The pick path mocks ./avatarResize: jsdom has no image decoding or 2D
// canvas, and the resize output is not what's under test here.
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";
import type { AccountUser } from "../accountApi";
import type { AuthInfo } from "../identity";
import ProfileSection from "./ProfileSection.svelte";

const STUB_DATA_URL = "data:image/webp;base64,STUB";

vi.mock("./avatarResize", () => ({
  resizeToDataUrl: vi.fn(async () => STUB_DATA_URL),
}));

const user: AccountUser = {
  id: "u1",
  email: "ada@example.com",
  display_name: "Ada Lovelace",
  avatar_url: "data:image/png;base64,AAAA",
  onboarded_at: "2026-01-01T00:00:00Z",
};

const auth: AuthInfo = { mode: "oidc", user };

let host: HTMLElement | undefined;
let component: ReturnType<typeof mount> | undefined;

afterEach(() => {
  if (component) unmount(component);
  host?.remove();
  component = undefined;
  host = undefined;
  vi.unstubAllGlobals();
});

function render(props: { onupdated?: (u: AccountUser) => void; toast?: () => void } = {}) {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(ProfileSection, {
    target: host,
    props: {
      auth,
      toast: props.toast ?? (() => {}),
      onupdated: props.onupdated ?? (() => {}),
    },
  });
  flushSync();
  return host;
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** Fire the hidden file input's change event with `file` selected. */
function pickFile(el: HTMLElement, file: File) {
  const input = el.querySelector<HTMLInputElement>('input[type="file"]');
  expect(input).not.toBeNull();
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  // bubbles: Svelte 5 delegates `change` to the render root.
  input!.dispatchEvent(new Event("change", { bubbles: true }));
}

describe("ProfileSection", () => {
  it("PATCHes an avatar removal immediately and hands the response to onupdated", async () => {
    const patched: AccountUser = { ...user, avatar_url: null };
    const fetchMock = vi.fn(async () => jsonResponse(patched));
    vi.stubGlobal("fetch", fetchMock);
    const onupdated = vi.fn();
    const el = render({ onupdated });

    const remove = [...el.querySelectorAll("button")].find((b) => b.textContent?.match(/Remove/));
    expect(remove).toBeDefined();
    remove?.click();

    await vi.waitFor(() => expect(onupdated).toHaveBeenCalledWith(patched));
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toContain("/api/me");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(String(init.body))).toEqual({ avatar_url: null });
  });

  it("PATCHes a picked avatar immediately with the resized data URL", async () => {
    const patched: AccountUser = { ...user, avatar_url: STUB_DATA_URL };
    const fetchMock = vi.fn(async () => jsonResponse(patched));
    vi.stubGlobal("fetch", fetchMock);
    const onupdated = vi.fn();
    const el = render({ onupdated });

    pickFile(el, new File(["png-bytes"], "me.png", { type: "image/png" }));

    await vi.waitFor(() => expect(onupdated).toHaveBeenCalledWith(patched));
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toContain("/api/me");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(String(init.body))).toEqual({ avatar_url: STUB_DATA_URL });
  });

  it("drops a stale PATCH response that resolves after a later-issued one", async () => {
    // Remove-avatar (request 1) resolves AFTER a name save (request 2): the
    // full-snapshot response of request 1 must not be applied or forwarded —
    // it would revert the name change on screen.
    const resolvers: Array<(r: Response) => void> = [];
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => resolvers.push(resolve)));
    vi.stubGlobal("fetch", fetchMock);
    const onupdated = vi.fn();
    const el = render({ onupdated });

    const remove = [...el.querySelectorAll("button")].find((b) => b.textContent?.match(/Remove/));
    remove?.click(); // request 1 (in flight)
    const form = el.querySelector("form");
    expect(form).not.toBeNull();
    form?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); // request 2
    await vi.waitFor(() => expect(resolvers).toHaveLength(2));

    const fromNameSave: AccountUser = { ...user, display_name: "Countess" };
    const staleFromRemove: AccountUser = { ...user, avatar_url: null };
    resolvers[1](jsonResponse(fromNameSave)); // latest-issued wins…
    await vi.waitFor(() => expect(onupdated).toHaveBeenCalledWith(fromNameSave));
    resolvers[0](jsonResponse(staleFromRemove)); // …and the stale one is dropped
    await new Promise((r) => setTimeout(r, 0));
    expect(onupdated).toHaveBeenCalledTimes(1);
    expect(onupdated).not.toHaveBeenCalledWith(staleFromRemove);
  });

  it("renders the avatar image from the shared auth user", () => {
    const el = render();
    const img = el.querySelector("img");
    expect(img?.getAttribute("src")).toBe(user.avatar_url);
  });

  it("carries no User ID row and no identity-provider sign-in row", () => {
    const el = render();
    expect(el.textContent).not.toContain("User ID");
    expect(el.textContent).not.toContain("OpenID Connect");
    expect(el.textContent).not.toContain(user.id);
  });

  it("carries no helper copy under the display-name and avatar controls", () => {
    const el = render();
    expect(el.textContent).not.toContain("Overrides the name from your identity provider");
    expect(el.textContent).not.toContain("Square images work best");
  });
});
