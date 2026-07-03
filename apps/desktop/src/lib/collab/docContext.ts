// Maps the open doc's absolute path + workspace root to its server doc-slug and
// whether collaboration is available for it.
//
//   - `slug`: the workspace-relative path run through the EXISTING slug rules
//     (sync/slug.ts `deriveSlug`, the `slug_from_rel_path` replica). Reused, not
//     reimplemented. Null when there is no open path.
//   - `isRemote`: true only when the doc is inside a synced workspace
//     (`syncing` — the same condition that drives `useTauriSync || useWsSync` in
//     EditorPane). Local-only vault files are not remote and get the empty
//     state in the collab panels, never an error.

import { deriveSlug } from "$lib/sync/slug";

/** Workspace-relative path for `path`, mirroring EditorPane.relativeToWorkspace. */
function relativeToWorkspace(path: string, root: string | null): string {
  if (root && path.startsWith(root + "/")) return path.slice(root.length + 1);
  // No known workspace root: fall back to the basename.
  return path.split("/").at(-1) ?? path;
}

export type DocContext = { slug: string | null; isRemote: boolean };

export function docContext(
  path: string | null,
  workspaceRoot: string | null,
  syncing: boolean,
): DocContext {
  if (!path) return { slug: null, isRemote: false };
  const rel = relativeToWorkspace(path, workspaceRoot);
  return { slug: deriveSlug(rel), isRemote: syncing };
}
