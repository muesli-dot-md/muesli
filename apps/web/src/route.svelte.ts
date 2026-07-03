// Reactive hash router. The hash is the single source of truth: navigation just
// sets location.hash and the hashchange listener re-parses it into the reactive
// `route` store — no location.reload() anywhere, so module state (auth, loaded
// chunks) survives home <-> doc moves and browser back/forward works for free.
//
// Route grammar:
//   ''             -> home (root)
//   'f/<folder>'   -> home, showing that folder
//   '~recent'      -> home, recent view
//   '~starred'     -> home, starred view
//   '~shared'      -> home, shared-with-me view
//   '~trash'       -> home, trash view
//   '~settings'    -> settings page (also '~settings/<section>'; unknown
//                     sections fall back to the first one, settings.md §1)
//   '~login'       -> the sign-in fallback page (organization-SSO chooser). NOT
//                     the default gate — signed-out visitors are sent straight
//                     to /auth/login (appGate "redirect"); this route exists so
//                     the SSO entry point stays reachable by URL.
//   '~<other>'     -> not-found (an unknown reserved route → the 404 page)
//   anything else  -> a document slug, optional '?share=<token>' (ADR 0011)
//
// slugify() can never produce '~' or '/', so the home views can't collide with
// document slugs — and any other '~'-prefixed hash is a dead route, not a doc.

export type HomeView = "root" | "folder" | "recent" | "starred" | "shared" | "trash";

export const settingsSections = [
  "profile",
  "preferences",
  "notifications",
  "api-keys",
  "connections",
  "shortcuts",
  "about",
  "general",
  "members",
] as const;
export type SettingsSection = (typeof settingsSections)[number];

// "appearance" was the pre-Multica name for "preferences"; keep old hashes alive.
const SECTION_ALIASES: Record<string, SettingsSection> = { appearance: "preferences" };

export type Route =
  | { kind: "home"; view: HomeView; folderId: string | null }
  | { kind: "settings"; section: SettingsSection }
  | { kind: "login" }
  | { kind: "doc"; docId: string; shareToken: string | null }
  | { kind: "notfound" };

function parseHash(): Route {
  const hash = decodeURIComponent(location.hash.slice(1));
  if (!hash) return { kind: "home", view: "root", folderId: null };
  if (hash === "~recent") return { kind: "home", view: "recent", folderId: null };
  if (hash === "~starred") return { kind: "home", view: "starred", folderId: null };
  if (hash === "~shared") return { kind: "home", view: "shared", folderId: null };
  if (hash === "~trash") return { kind: "home", view: "trash", folderId: null };
  if (hash === "~settings" || hash.startsWith("~settings/")) {
    const raw = hash.slice("~settings/".length);
    const section = (settingsSections as readonly string[]).includes(raw)
      ? (raw as SettingsSection)
      : (SECTION_ALIASES[raw] ?? settingsSections[0]);
    return { kind: "settings", section };
  }
  if (hash === "~login") return { kind: "login" };
  if (hash.startsWith("f/")) return { kind: "home", view: "folder", folderId: hash.slice(2) };
  // Any other '~'-reserved hash is a dead route, not a document slug (slugify
  // never produces '~'), so it lands on the 404 page rather than minting a doc.
  if (hash.startsWith("~")) return { kind: "notfound" };
  const [rawId, hashQuery] = hash.split("?", 2);
  return {
    kind: "doc",
    docId: rawId,
    shareToken: new URLSearchParams(hashQuery ?? "").get("share"),
  };
}

class RouteStore {
  current: Route = $state(parseHash());
}

export const route = new RouteStore();

window.addEventListener("hashchange", () => {
  route.current = parseHash();
});

// --- navigation: set the hash, hashchange drives the store ---------------------
// Setting an unchanged hash fires no event, so same-target navigation is a no-op.

export function gotoDoc(slug: string): void {
  if (!slug) return;
  location.hash = `#${encodeURIComponent(slug)}`;
}

export function gotoHome(): void {
  location.hash = "";
}

export function gotoFolder(folderId: string): void {
  location.hash = `#f/${encodeURIComponent(folderId)}`;
}

export function gotoRecent(): void {
  location.hash = "#~recent";
}

export function gotoStarred(): void {
  location.hash = "#~starred";
}

export function gotoShared(): void {
  location.hash = "#~shared";
}

export function gotoTrash(): void {
  location.hash = "#~trash";
}

export function gotoSettings(section: SettingsSection = settingsSections[0]): void {
  // Entering settings pushes ONE history entry; switching sections inside
  // replaces it, so back (button or browser) always returns to wherever the
  // user was before settings — not back through every section they visited.
  // location.replace on a same-document hash URL still fires hashchange.
  const target = `#~settings/${section}`;
  if (route.current.kind === "settings") {
    location.replace(target);
  } else {
    location.hash = target;
  }
}
