// @vitest-environment jsdom
// Invariants pinned here:
//   - A #~settings/workspace deep link survives the initial load: the
//     "no workspace available → bounce to Profile" effect must not fire while
//     fetchMe/loadWorkspaces are still in flight (showWorkspace is false then
//     for the wrong reason), only once they have settled.
//   - Profile PATCH responses flow up through onuserchanged, so the host's
//     copy of the signed-in user (Home's sidebar chip) follows live.
// The route layer's alias tests live in settings/settingsNav.test.ts; this
// suite mounts the real SettingsPage against a stubbed fetch.
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushSync, mount, unmount } from "svelte";

// theme.svelte.ts (reached via SettingsPage → AccountMenu → ThemeModeControl)
// calls window.matchMedia at module scope; jsdom doesn't implement it. Hoisted
// so it runs before the imports below evaluate that module.
vi.hoisted(() => {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
});

import type { Me } from "./identity";
import SettingsPage from "./SettingsPage.svelte";

const me: Me = {
  id: "u1",
  email: "ada@example.com",
  display_name: "Ada Lovelace",
  avatar_url: "data:image/png;base64,AAAA",
  onboarded_at: "2026-01-01T00:00:00Z",
};

const ws = { id: "w1", name: "Acme", role: "admin", is_personal: true };
const wsDetail = { ...ws, members: [] };

let host: HTMLElement | undefined;
let component: ReturnType<typeof mount> | undefined;

afterEach(() => {
  if (component) unmount(component);
  host?.remove();
  component = undefined;
  host = undefined;
  vi.unstubAllGlobals();
  // Leave the hash clean for whatever runs next in this environment.
  location.hash = "";
  window.dispatchEvent(new HashChangeEvent("hashchange"));
});

function setHash(hash: string) {
  location.hash = hash;
  window.dispatchEvent(new HashChangeEvent("hashchange"));
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

type Handler = (url: string, init?: RequestInit) => Promise<Response> | Response;

function stubFetch(handler: Handler) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => handler(String(input), init)),
  );
}

function render(props: { section: "workspace" | "profile"; onuserchanged?: (user: Me) => void }) {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(SettingsPage, {
    target: host,
    props: { section: props.section, embedded: true, onuserchanged: props.onuserchanged },
  });
  flushSync();
  return host;
}

describe("SettingsPage", () => {
  it("keeps a #~settings/workspace deep link while the initial fetches are in flight", async () => {
    setHash("#~settings/workspace");
    let resolveMe!: (r: Response) => void;
    const mePromise = new Promise<Response>((r) => (resolveMe = r));
    stubFetch((url) => {
      if (url.endsWith("/api/me")) return mePromise;
      if (url.endsWith("/api/workspaces")) return jsonResponse({ workspaces: [ws] });
      if (url.includes("/audit")) return jsonResponse({ entries: [] });
      if (url.includes("/api/workspaces/")) return jsonResponse(wsDetail);
      throw new Error(`unexpected fetch: ${url}`);
    });
    const el = render({ section: "workspace" });

    // The bounce effect has already run (flushSync) with the fetches
    // unresolved — the deep link must survive it.
    expect(location.hash).toBe("#~settings/workspace");

    // Once auth + the workspace list land, the page renders instead of bouncing.
    resolveMe(jsonResponse({ mode: "oidc", user: me }));
    await vi.waitFor(() => expect(el.querySelector("#settings-workspace-select")).not.toBeNull());
    expect(location.hash).toBe("#~settings/workspace");
  });

  it("bounces #~settings/workspace to Profile once load settles with no workspace", async () => {
    setHash("#~settings/workspace");
    stubFetch((url) => {
      // Open mode: loadWorkspaces returns early, no /api/workspaces call.
      if (url.endsWith("/api/me")) return jsonResponse({ mode: "open", user: null });
      throw new Error(`unexpected fetch: ${url}`);
    });
    render({ section: "workspace" });

    await vi.waitFor(() => expect(location.hash).toBe("#~settings/profile"));
  });

  it("forwards profile PATCH responses through onuserchanged", async () => {
    setHash("#~settings/profile");
    const patched: Me = { ...me, avatar_url: null };
    stubFetch((url, init) => {
      if (url.endsWith("/api/me") && init?.method === "PATCH") return jsonResponse(patched);
      if (url.endsWith("/api/me")) return jsonResponse({ mode: "oidc", user: me });
      if (url.endsWith("/api/workspaces")) return jsonResponse({ workspaces: [] });
      throw new Error(`unexpected fetch: ${url}`);
    });
    const onuserchanged = vi.fn();
    const el = render({ section: "profile", onuserchanged });

    // Wait for the signed-in profile (auth resolved), then remove the avatar.
    let removeBtn: HTMLButtonElement | undefined;
    await vi.waitFor(() => {
      removeBtn = [...el.querySelectorAll("button")].find((b) =>
        /Remove/.test(b.textContent ?? ""),
      );
      expect(removeBtn).toBeDefined();
    });
    removeBtn?.click();

    await vi.waitFor(() => expect(onuserchanged).toHaveBeenCalledWith(patched));
  });
});
