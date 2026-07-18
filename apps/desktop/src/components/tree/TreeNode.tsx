// One file/folder row of the recursive file tree — ported from TreeNode.svelte.
// Expand/collapse rides workspace.expandedPaths (replace-on-change Set), inline
// rename replaces window.prompt (wry's WKWebView has no JS text-input panel),
// delete confirms inline, and HTML5 drag-and-drop moves entries between
// folders using the shared dnd store (DataTransfer is unreadable during
// dragover, so the store carries the source path).

import { useEffect, useRef, useState } from "react";
import { ChevronRight, Folder, FileText } from "lucide-react";
import { FolderOpenGlyph } from "@/components/tree/FolderOpenGlyph";
import type { WorkspaceNode } from "@/services/tauri";
import { renamePath, deletePath, movePath } from "@/services/tauri";
import { sortNodes } from "@/services/sortNodes";
import { workspaceStore, useWorkspace } from "@/state/workspace";
import { tabsStore } from "@/state/tabs";
import { dndStore } from "@/state/dnd";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

export interface TreeNodeProps {
  node: WorkspaceNode;
  depth: number;
  activePath: string | null;
  onOpen: (path: string, name: string) => void;
  onContextMenu: (e: React.MouseEvent, node: WorkspaceNode) => void;
  /** When this equals node.path, enter rename mode */
  pendingRename: string | null;
  /** When this equals node.path, open delete confirm */
  pendingDelete: string | null;
  onRenameDone: () => void;
  onDeleteDone: () => void;
}

export function TreeNode({
  node,
  depth,
  activePath,
  onOpen,
  onContextMenu,
  pendingRename,
  pendingDelete,
  onRenameDone,
  onDeleteDone,
}: TreeNodeProps) {
  // Drive expanded from workspace.expandedPaths so collapseAll() (which
  // replaces the Set) is reflected immediately.
  const expanded: boolean = useWorkspace((s) => s.expandedPaths.has(node.path));
  const sortMode: "name-asc" | "name-desc" = useWorkspace((s) => s.sortMode);

  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [renameError, setRenameError] = useState("");
  const renameInputRef = useRef<HTMLInputElement | null>(null);

  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleteError, setDeleteError] = useState("");

  // ── Drag-and-drop move ─────────────────────────────────────────────────────
  const [dragOver, setDragOver] = useState(false);

  /** Is `src` allowed to be dropped into this node (a folder)? */
  function isValidDrop(src: string | null): boolean {
    if (!src || !node.isDir) return false;
    if (src === node.path) return false;
    // can't move a folder into itself or one of its descendants
    if (node.path === src || node.path.startsWith(src + "/")) return false;
    // already directly inside this folder → no-op
    const srcParent = src.slice(0, src.lastIndexOf("/"));
    if (srcParent === node.path) return false;
    return true;
  }

  function onDragStart(e: React.DragEvent) {
    if (renaming) {
      e.preventDefault();
      return;
    }
    dndStore.getState().setDraggingPath(node.path);
    if (e.dataTransfer) {
      e.dataTransfer.setData("text/plain", node.path);
      e.dataTransfer.effectAllowed = "move";
    }
    e.stopPropagation();
  }

  function onDragEnd() {
    dndStore.getState().setDraggingPath(null);
    setDragOver(false);
  }

  // Folders always accept the drop (so the `drop` event reliably fires); the
  // actual legality is validated in onDrop. Highlight only legal targets.
  function onDragOver(e: React.DragEvent) {
    if (!node.isDir) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    setDragOver(isValidDrop(dndStore.getState().draggingPath));
  }

  function onDragLeave() {
    setDragOver(false);
  }

  async function onDrop(e: React.DragEvent) {
    if (!node.isDir) return;
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    // Only the shared drag state is authoritative: with native drag-drop
    // interception off, ANY text/plain drag (a dragged editor selection,
    // content from another app) reaches this handler, and its payload must
    // not be mistaken for a tree path.
    const src: string = dndStore.getState().draggingPath ?? "";
    dndStore.getState().setDraggingPath(null);
    if (!src || !isValidDrop(src)) return;
    try {
      await tabsStore.getState().flush(src);
      const newPath = await movePath(src, node.path);
      tabsStore.getState().retarget(src, newPath);
      workspaceStore.getState().expand(node.path);
      await workspaceStore.getState().refresh();
    } catch (err) {
      console.error("[move] failed", err);
      window.alert(`Could not move: ${err}`);
    }
  }

  // React to pendingRename signal
  useEffect(() => {
    if (pendingRename === node.path && !renaming) {
      setRenaming(true);
      setRenameValue(node.name);
      setRenameError("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingRename, node.path]);

  // React to pendingDelete signal
  useEffect(() => {
    if (pendingDelete === node.path && !deleteConfirmOpen) {
      setDeleteConfirmOpen(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingDelete, node.path]);

  // Auto-focus rename input when it appears
  useEffect(() => {
    if (renaming) {
      const input = renameInputRef.current;
      input?.focus();
      input?.select();
    }
  }, [renaming]);

  // Guards commitRename against re-entry: Enter and the input's blur both
  // commit, and a successful commit unmounts the input (which fires blur) —
  // without the guard the second call renames again ("target already exists")
  // on a node about to be re-keyed.
  const renameCommitting = useRef(false);

  async function commitRename() {
    if (!renaming || renameCommitting.current) return;
    const newName = renameValue.trim();
    if (!newName || newName === node.name) {
      setRenaming(false);
      onRenameDone();
      return;
    }
    renameCommitting.current = true;
    try {
      // Persist any pending autosave to the OLD path first: after the rename,
      // a late debounced write would recreate the old filename on disk (the
      // "rename doesn't stick" bug). flush() is a no-op when nothing pends.
      await tabsStore.getState().flush(node.path);
      const newPath = await renamePath(node.path, newName);
      // Follow open tabs (and, for a folder, everything under it) to the new
      // path so the editor remounts against the renamed file instead of
      // resurrecting the old one.
      tabsStore.getState().retarget(node.path, newPath);
      await workspaceStore.getState().refresh();
      setRenaming(false);
      onRenameDone();
    } catch (err) {
      setRenameError(String(err));
    } finally {
      renameCommitting.current = false;
    }
  }

  function cancelRename() {
    setRenaming(false);
    setRenameError("");
    onRenameDone();
  }

  async function confirmDelete() {
    try {
      await deletePath(node.path);
      await workspaceStore.getState().refresh();
    } catch (e) {
      setDeleteError(String(e));
      return; // keep the modal open so the error is visible
    }
    setDeleteConfirmOpen(false);
    setDeleteError("");
    onDeleteDone();
  }

  function cancelDelete() {
    setDeleteConfirmOpen(false);
    setDeleteError("");
    onDeleteDone();
  }

  // Delete confirm owns its Escape (capture + preventDefault per the modal
  // contract) so the global fallback in services/keymap.ts never sees it.
  useEffect(() => {
    if (!deleteConfirmOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        cancelDelete();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deleteConfirmOpen]);

  function activate() {
    if (node.isDir) workspaceStore.getState().toggleExpanded(node.path);
    else onOpen(node.path, node.name);
  }

  const sortedChildren =
    node.isDir && node.children ? sortNodes(node.children, sortMode) : [];

  const isActive = !node.isDir && node.path === activePath;

  const rowClass = [
    "tree-row-wrap flex items-center text-sm cursor-pointer select-none",
    isActive ? "active" : "",
    dragOver ? "drop-target" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <>
      {/* Node row: the row itself is the click target AND the full-width
          hover/active highlight (rounded, spanning the sidebar width).
          Draggable to move; folders are drop targets. */}
      <div
        className={rowClass}
        style={{
          paddingLeft: `${depth * 12 + 4}px`,
          paddingTop: 4,
          paddingBottom: 4,
          paddingRight: 8,
        }}
        draggable={!renaming}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        onClick={activate}
        onContextMenu={(e) => {
          e.preventDefault();
          onContextMenu(e, node);
        }}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            activate();
          }
        }}
      >
        {/* Disclosure chevron (folders) / alignment spacer (files). */}
        {node.isDir ? (
          <span
            className="shrink-0 transition-transform duration-150 text-foreground/45"
            style={expanded ? { transform: "rotate(90deg)" } : undefined}
          >
            <ChevronRight size={15} />
          </span>
        ) : (
          <span className="shrink-0" style={{ width: 15 }} />
        )}

        <div className="tree-row-label items-center gap-1.5 min-w-0" style={{ padding: "1px 7px" }}>
          {node.isDir ? (
            // Both glyphs carry the soft same-hue interior wash the stroke's
            // --folder-accent sets: .folder-glyph (styles/app.css) fills the
            // CLOSED lucide Folder; the open state renders FolderOpenGlyph,
            // whose closed flap subpath takes the same fill (lucide's own
            // FolderOpen path cannot be filled — see app.css).
            expanded ? (
              <FolderOpenGlyph size={17} className="shrink-0 text-[var(--folder-accent)]" />
            ) : (
              <Folder size={17} className="folder-glyph shrink-0 text-[var(--folder-accent)]" />
            )
          ) : (
            <FileText size={15} className="shrink-0 text-foreground/50" />
          )}

          {renaming ? (
            // Inline rename input — stop propagation so click doesn't toggle expand
            <div
              className="flex flex-col gap-0.5 min-w-[12rem]"
              onClick={(e) => e.stopPropagation()}
              role="none"
            >
              <Input
                ref={renameInputRef}
                className="h-6 w-full min-w-0 px-1.5 text-sm"
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void commitRename();
                  }
                  if (e.key === "Escape") {
                    e.preventDefault();
                    cancelRename();
                  }
                }}
                onBlur={() => void commitRename()}
              />
              {renameError ? <p className="text-destructive text-xs">{renameError}</p> : null}
            </div>
          ) : (
            <span className="truncate">{node.name}</span>
          )}
        </div>
      </div>

      {/* Children (when folder expanded): wrapped so an indent-guide line
          (.tree-children, positioned under this folder's own chevron) can run
          down through them, Obsidian-style. */}
      {node.isDir && expanded ? (
        <div
          className="tree-children"
          style={{ "--guide-x": `${depth * 12 + 15}px` } as React.CSSProperties}
        >
          {sortedChildren.map((child) => (
            <TreeNode
              key={child.path}
              node={child}
              depth={depth + 1}
              activePath={activePath}
              onOpen={onOpen}
              onContextMenu={onContextMenu}
              pendingRename={pendingRename}
              pendingDelete={pendingDelete}
              onRenameDone={onRenameDone}
              onDeleteDone={onDeleteDone}
            />
          ))}
        </div>
      ) : null}

      {/* Delete confirm modal */}
      {deleteConfirmOpen ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/10 backdrop-blur-xs"
          onClick={cancelDelete}
          role="presentation"
        >
          <div
            className="mx-4 w-full max-w-sm rounded-xl bg-surface-raised p-6 shadow-[var(--floating-shadow)] ring-1 ring-surface-border animate-in fade-in-0 zoom-in-95 duration-100 motion-reduce:animate-none"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            tabIndex={-1}
          >
            <h3 className="mb-2 text-base font-semibold">Delete {node.name}?</h3>
            <p className="mb-4 text-sm text-muted-foreground">This cannot be undone.</p>
            {deleteError ? <p className="mb-3 text-sm text-destructive">{deleteError}</p> : null}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={cancelDelete}>
                Cancel
              </Button>
              <Button variant="destructive" size="sm" onClick={() => void confirmDelete()}>
                Delete
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
