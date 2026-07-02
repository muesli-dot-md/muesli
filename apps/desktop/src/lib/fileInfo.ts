// Formatting + folder-collection helpers for the file-tree context menu's
// "File information" and "Move to…" actions. Pure functions, unit-tested.

import type { WorkspaceNode } from "$lib/tauri";

/** Human-readable byte size (1024-based): "0 B", "512 B", "1.5 KB", "2.0 MB". */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

/** Format a Unix-millis timestamp as a locale date-time, or "—" if null. */
export function formatTimestamp(ms: number | null | undefined): string {
  if (ms == null) return "—";
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** A folder destination for the "Move to…" picker. */
export interface FolderTarget {
  /** Absolute path of the folder. */
  path: string;
  /** Display label (workspace-relative; the root shows as its workspace name). */
  label: string;
  /** Nesting depth for indentation (root = 0). */
  depth: number;
}

/**
 * Collect every folder in the tree as a flat, indent-aware list of move targets,
 * EXCLUDING `srcPath` itself, its current parent (moving there is a no-op), and
 * any descendant of `srcPath` (can't move a folder into itself). The workspace
 * root is always offered first.
 */
export function collectFolderTargets(
  tree: WorkspaceNode,
  root: string,
  srcPath: string,
): FolderTarget[] {
  const out: FolderTarget[] = [];
  const srcParent = srcPath.slice(0, srcPath.lastIndexOf("/"));

  function allowed(folderPath: string): boolean {
    if (folderPath === srcPath) return false; // can't move into self
    if (folderPath === srcParent) return false; // already there (no-op)
    if (folderPath === srcPath || folderPath.startsWith(srcPath + "/")) return false; // descendant
    return true;
  }

  function walk(node: WorkspaceNode, depth: number) {
    if (!node.isDir) return;
    const isRoot = node.path === root;
    if (allowed(node.path)) {
      const rel = node.path.startsWith(root + "/") ? node.path.slice(root.length + 1) : node.path;
      out.push({
        path: node.path,
        label: isRoot ? node.name : rel,
        depth,
      });
    }
    for (const child of node.children ?? []) {
      if (child.isDir) walk(child, depth + 1);
    }
  }

  // The top-level tree node IS the workspace root; offer it explicitly first.
  if (allowed(root)) {
    out.push({ path: root, label: tree.name, depth: 0 });
  }
  for (const child of tree.children ?? []) {
    if (child.isDir) walk(child, 1);
  }
  return out;
}
