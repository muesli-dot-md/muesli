// Pure helpers for the Home workspaces sidebar (spec §2/§3). Kept DOM-free and
// dependency-free so they can be unit-tested directly (homeWorkspace.test.ts).

import type { Route } from "./route.svelte";

/** What Home's main panel renders. The workspaces sidebar is always present;
 *  the main panel switches between the document browser, the link graph, and
 *  the embedded Settings view (a settings route renders inside the panel — it is
 *  no longer a full-page takeover). The settings route wins over the local
 *  graph-open toggle so deep-linking to settings always lands on settings. */
export type HomeMainPanel = "settings" | "graph" | "documents";

export function homeMainPanel(route: Route, graphOpen: boolean): HomeMainPanel {
  if (route.kind === "settings") return "settings";
  if (graphOpen) return "graph";
  return "documents";
}

/**
 * Does a row (doc/folder) with workspace id `wsId` belong to the selected
 * workspace `selectedId`?
 *
 * - `selectedId === null` → selection unresolved (still loading): show everything.
 * - The personal workspace also owns the ownerless / open-mode rows whose
 *   `wsId` is null/undefined, so those count as "in" it.
 * - Every other workspace matches strictly on the id.
 */
export function inWorkspace(
  wsId: string | null | undefined,
  selectedId: string | null,
  personalId: string | null,
): boolean {
  if (selectedId === null) return true;
  if (selectedId === personalId) return !wsId || wsId === selectedId;
  return wsId === selectedId;
}

/** Stable name/date comparator factory used by list/grid/tree (folders + docs). */
export function compareBy<T>(
  key: "name" | "modified",
  asc: boolean,
  nameOf: (x: T) => string,
  dateOf: (x: T) => string,
): (a: T, b: T) => number {
  const dir = asc ? 1 : -1;
  return (a, b) =>
    key === "name"
      ? dir * nameOf(a).localeCompare(nameOf(b))
      : dir * dateOf(a).localeCompare(dateOf(b));
}
