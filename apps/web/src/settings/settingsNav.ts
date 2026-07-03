// The Multica-style two-level settings navigation: small-caps GROUP headers
// over icon rows. DOM-free + Yjs-free so it can be unit-tested directly and
// imported by SettingsPage without side effects. The icon is resolved in the
// component (lucide imports stay out of this pure module); here we only carry a
// stable string `icon` key the component maps to a component.
//
// Two groups model Multica's layout:
//   - "account": My Account — per-user settings (Profile, Preferences, …)
//   - "workspace": the active workspace — its General + Members pages. Its
//     header is the workspace NAME (filled in by the component), not a static
//     label, exactly like Multica's "southlakelabs" group.

import type { MessageKey } from "../i18n/en";
import type { SettingsSection } from "../route.svelte";

export type SettingsIconKey =
  | "user"
  | "sliders"
  | "bell"
  | "keyRound"
  | "cable"
  | "info"
  | "settings"
  | "users";

export type SettingsNavItem = {
  section: SettingsSection;
  labelKey: MessageKey;
  icon: SettingsIconKey;
};

export type SettingsNavGroupId = "account" | "workspace";

export type SettingsNavGroup = {
  id: SettingsNavGroupId;
  /** Static i18n header for the account group; the workspace group overrides
   *  this with the live workspace name in the component (titleKey unused there). */
  titleKey: MessageKey;
  items: SettingsNavItem[];
};

/** "My Account" — the per-user pages, in Multica's order (Profile first). */
export const ACCOUNT_GROUP: SettingsNavGroup = {
  id: "account",
  titleKey: "settings.group.account",
  items: [
    { section: "profile", labelKey: "settings.nav.profile", icon: "user" },
    {
      section: "preferences",
      labelKey: "settings.nav.preferences",
      icon: "sliders",
    },
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
  ],
};

/** The workspace group — General + Members (the only two Multica items muesli
 *  has real backing for). Shown only when an OIDC workspace is loaded. */
export const WORKSPACE_GROUP: SettingsNavGroup = {
  id: "workspace",
  titleKey: "settings.group.workspace",
  items: [
    { section: "general", labelKey: "settings.nav.general", icon: "settings" },
    { section: "members", labelKey: "settings.nav.members", icon: "users" },
  ],
};

/** The full group list. `showWorkspace` is false in open mode / signed out (the
 *  workspace pages need a real workspace), so the group is dropped entirely. */
export function settingsNavGroups(showWorkspace: boolean): SettingsNavGroup[] {
  return showWorkspace ? [ACCOUNT_GROUP, WORKSPACE_GROUP] : [ACCOUNT_GROUP];
}

/** Flat ordered item list (used by the mobile tab strip + lookups). */
export function settingsNavItems(showWorkspace: boolean): SettingsNavItem[] {
  return settingsNavGroups(showWorkspace).flatMap((g) => g.items);
}

/** Which group a section belongs to (workspace sections are scoped to a ws). */
export function groupForSection(section: SettingsSection): SettingsNavGroupId {
  return WORKSPACE_GROUP.items.some((i) => i.section === section)
    ? "workspace"
    : "account";
}
