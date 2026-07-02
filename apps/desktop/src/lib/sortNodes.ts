import type { WorkspaceNode } from "$lib/tauri";

/**
 * Sorts WorkspaceNode arrays: folders first, then files, alphabetically within each group.
 * @param nodes - array of WorkspaceNode to sort
 * @param mode - 'name-asc' (default) or 'name-desc'; folders are always first regardless of mode
 */
export function sortNodes(
  nodes: WorkspaceNode[],
  mode: "name-asc" | "name-desc" = "name-asc",
): WorkspaceNode[] {
  return [...nodes].sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    const cmp = a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    return mode === "name-desc" ? -cmp : cmp;
  });
}
