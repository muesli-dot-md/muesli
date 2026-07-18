// Pure helpers for the Linear-style workspace selector + account dropdown
// (WorkspaceMenu.svelte). DOM-free and dependency-light so the menu's behaviour
// — what each row renders and which workspace is active — is unit-testable
// directly (workspaceMenu.test.ts), independent of the Svelte component shell.

import { colorFromId } from "./presence";
import type { Me } from "./identity";
import type { WorkspaceSummary } from "./workspaceApi";

/** One menu row for a workspace: display label + whether it's the active one. */
export type WorkspaceMenuRow = {
  id: string;
  label: string;
  active: boolean;
  /** First letter of the label, for the small square avatar. */
  letter: string;
};

/**
 * Build the workspace rows shown in the dropdown. Every workspace shows the
 * name its creator gave it in the wizard; the localized "My workspace" label
 * (passed in so it re-translates with the locale) is only the fallback for a
 * personal workspace with no name. The row whose id matches `selectedId` is
 * marked active (it gets the checkmark).
 */
export function workspaceMenuRows(
  workspaces: WorkspaceSummary[],
  selectedId: string | null,
  personalLabel: string,
): WorkspaceMenuRow[] {
  return workspaces.map((w) => {
    const label = w.name.trim() || (w.is_personal ? personalLabel : w.name);
    return {
      id: w.id,
      label,
      active: w.id === selectedId,
      letter: avatarLetter(label),
    };
  });
}

/** Uppercase first alphanumeric character of a string, or "?" when none. */
export function avatarLetter(name: string): string {
  const m = (name ?? "").trim().match(/[\p{L}\p{N}]/u);
  return m ? m[0].toUpperCase() : "?";
}

/** The signed-in user's identity, normalized for the dropdown header. Avatar is
 *  the photo URL when present; otherwise initials over a stable color derived
 *  from the user id (reusing colorFromId — the one color derivation in the app). */
export type MenuIdentity = {
  name: string;
  email: string | null;
  avatarUrl: string | null;
  initials: string;
  color: string;
};

export function menuIdentity(user: Me): MenuIdentity {
  const name = user.display_name?.trim() || user.email?.trim() || "—";
  return {
    name,
    email: user.email,
    avatarUrl: user.avatar_url ?? null,
    initials: avatarLetter(name),
    color: colorFromId(user.id).color,
  };
}
