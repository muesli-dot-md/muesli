// Grouping + breadcrumb helpers for the ⌘K search palette.
//
// The desktop search backend (`search_workspace`) returns a flat, ranked list of
// `SearchHit`s — filename matches first, then by content-match count. To match
// the webapp palette's look we group those hits by their containing folder and
// render a folder breadcrumb per group, while preserving the backend ranking
// *within* each group (insertion order) and ordering the groups themselves so
// the workspace root comes first, then nested folders alphabetically.

import type { SearchHit } from "$lib/tauri";

/** One folder group of results, with a breadcrumb chain (root-first, root-relative). */
export interface SearchGroup {
  /** Folder key — the hit's `display` minus its basename, "" for the workspace root. */
  key: string;
  /** Folder chain for the crumb, root-first (empty for root-level hits). */
  crumb: string[];
  items: SearchHit[];
}

/**
 * Derive the folder breadcrumb chain for a hit from its workspace-relative
 * `display` path (e.g. `"Notes/Sub/file.md"` → `["Notes", "Sub"]`). Root-level
 * files (`"file.md"`) yield `[]`. Handles both `/` and `\` separators.
 */
export function crumbFor(display: string): string[] {
  const parts = display.split(/[/\\]/).filter((p) => p.length > 0);
  // Last segment is the filename — drop it; the rest is the folder chain.
  return parts.slice(0, -1);
}

/**
 * Group ranked hits by containing folder, preserving backend order within each
 * group. Groups are ordered with the workspace root first, then by breadcrumb
 * path case-insensitively.
 */
export function groupHits(hits: SearchHit[]): SearchGroup[] {
  const map = new Map<string, SearchGroup>();
  for (const h of hits) {
    const crumb = crumbFor(h.display);
    const key = crumb.join("/");
    let g = map.get(key);
    if (!g) {
      g = { key, crumb, items: [] };
      map.set(key, g);
    }
    g.items.push(h); // insertion order keeps the backend ranking within the group
  }
  return [...map.values()].sort((a, b) => {
    // Root group ("") sorts first; otherwise alphabetical by path.
    if (a.key === "") return -1;
    if (b.key === "") return 1;
    return a.key.localeCompare(b.key, undefined, { sensitivity: "base" });
  });
}

/** Flatten groups back into render order — ArrowUp/Down step through this list. */
export function flattenGroups(groups: SearchGroup[]): SearchHit[] {
  return groups.flatMap((g) => g.items);
}

/**
 * Split `text` around the first case-insensitive occurrence of `needle` for
 * highlighting. Returns null when there is no match (caller renders plain text).
 */
export function highlightSplit(
  text: string,
  needle: string,
): { pre: string; hit: string; post: string } | null {
  const n = needle.trim().toLowerCase();
  if (!n) return null;
  const i = text.toLowerCase().indexOf(n);
  if (i < 0) return null;
  return { pre: text.slice(0, i), hit: text.slice(i, i + n.length), post: text.slice(i + n.length) };
}
