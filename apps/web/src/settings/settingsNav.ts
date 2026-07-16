// The Multica-style settings navigation: a small-caps "My Account" header over
// icon rows. DOM-free + Yjs-free so it can be unit-tested directly and
// imported by SettingsPage without side effects. The icon is resolved in the
// component (lucide imports stay out of this pure module); here we only carry a
// stable string `icon` key the component maps to a component.
//
// There is no per-workspace nav group anymore: the former General and Members
// pages merged into the single "workspace" page, which carries its own
// workspace selector — the nav contributes one item, appended when a real,
// signed-in workspace exists.

import type { MessageKey } from "../i18n/en";
import type { SettingsSection } from "../route.svelte";

export type SettingsIconKey =
  "user" | "sliders" | "languages" | "bell" | "keyRound" | "cable" | "info" | "settings";

export type SettingsNavItem = {
  section: SettingsSection;
  labelKey: MessageKey;
  icon: SettingsIconKey;
};

/** "My Account" — the per-user pages, in Multica's order (Profile first). */
export const ACCOUNT_ITEMS: SettingsNavItem[] = [
  { section: "profile", labelKey: "settings.nav.profile", icon: "user" },
  {
    section: "preferences",
    labelKey: "settings.nav.preferences",
    icon: "sliders",
  },
  { section: "language", labelKey: "settings.language", icon: "languages" },
  {
    section: "notifications",
    labelKey: "settings.nav.notifications",
    icon: "bell",
  },
  { section: "api-keys", labelKey: "settings.nav.apiKeys", icon: "keyRound" },
  {
    section: "connections",
    labelKey: "settings.nav.connections",
    icon: "cable",
  },
  { section: "shortcuts", labelKey: "settings.nav.shortcuts", icon: "info" },
  { section: "about", labelKey: "settings.nav.about", icon: "info" },
];

/** The single workspace entry: one page with a workspace selector on top of
 *  the General + Members content (the only Multica items muesli backs). */
export const WORKSPACE_ITEM: SettingsNavItem = {
  section: "workspace",
  labelKey: "settings.nav.workspace",
  icon: "settings",
};

/** Ordered item list (sidebar rail + mobile tab strip). `showWorkspace` is
 *  false in open mode / signed out (the workspace page needs a real
 *  workspace), so the workspace item is dropped entirely. */
export function settingsNavItems(showWorkspace: boolean): SettingsNavItem[] {
  return showWorkspace ? [...ACCOUNT_ITEMS, WORKSPACE_ITEM] : ACCOUNT_ITEMS;
}
