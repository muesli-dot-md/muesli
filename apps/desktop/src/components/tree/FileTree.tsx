// Recursive workspace file tree — ported from FileTree.svelte. Owns the
// pending-rename/pending-delete signals, the right-click context menu (an
// in-app DOM menu, not the OS-native one, for visual parity with the webapp's
// grouped look), and the Move-to… / File-information modals it launches.
// `startRename(path)` is exposed through the imperative handle so AppShell's
// toolbar "new note"/"new folder" can create at the root and hand naming off
// to the tree.

import { forwardRef, useImperativeHandle, useState } from "react";
import type { WorkspaceNode } from "@/services/tauri";
import { createNote, createFolder, readNote } from "@/services/tauri";
import { sortNodes } from "@/services/sortNodes";
import { workspaceStore, useWorkspace } from "@/state/workspace";
import { tabsStore } from "@/state/tabs";
import { TreeNode } from "@/components/tree/TreeNode";
import { ContextMenu, type MenuItem } from "@/components/tree/ContextMenu";
import { MoveToModal } from "@/components/tree/MoveToModal";
import { FileInfoPopover } from "@/components/tree/FileInfoPopover";
import { downloadMarkdown } from "@muesli/editor-core/docExport";
import {
  SquarePen,
  FolderPlus,
  SquareArrowOutUpRight,
  Pencil,
  FolderInput,
  Info,
  Download,
  Trash2,
  FilePlus,
} from "lucide-react";

export interface FileTreeHandle {
  /** Enter inline-rename mode for `path` (also used by AppShell's toolbar
   *  "new folder", which creates at the workspace root and then hands the
   *  naming off to the tree). */
  startRename(path: string): void;
}

export interface FileTreeProps {
  tree: WorkspaceNode | null;
  activePath: string | null;
  onOpen: (path: string, name: string) => void;
}

export const FileTree = forwardRef<FileTreeHandle, FileTreeProps>(function FileTree(
  { tree, activePath, onOpen },
  ref,
) {
  // Pending signals for rename/delete — cleared by TreeNode callbacks
  const [pendingRename, setPendingRename] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  // DOM context menu + the modals it launches.
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [moveTarget, setMoveTarget] = useState<{ path: string; name: string } | null>(null);
  const [infoTarget, setInfoTarget] = useState<{ path: string; name: string } | null>(null);

  const sortMode: "name-asc" | "name-desc" = useWorkspace((s) => s.sortMode);

  useImperativeHandle(ref, () => ({ startRename: (path: string) => setPendingRename(path) }), []);

  // Finder-style creation: make the entry with a default name, then drop
  // straight into the existing inline-rename flow. window.prompt() is NOT an
  // option here — wry's WKWebView implements no JS text-input panel, so
  // prompt() returns null and a prompt-based flow silently does nothing.
  async function newNoteIn(dir: string) {
    try {
      const newPath = await createNote(dir, "Untitled.md");
      workspaceStore.getState().expand(dir);
      await workspaceStore.getState().refresh();
      setPendingRename(newPath);
    } catch (err) {
      console.error("[create] new note failed", err);
    }
  }

  async function newFolderIn(dir: string) {
    try {
      const newPath = await createFolder(dir, "New folder");
      workspaceStore.getState().expand(dir);
      await workspaceStore.getState().refresh();
      setPendingRename(newPath);
    } catch (err) {
      console.error("[create] new folder failed", err);
    }
  }

  /** Open in the current tab (activates the existing tab if already open). */
  function openNode(node: WorkspaceNode) {
    onOpen(node.path, node.name);
  }

  /** Open in a tab without disturbing the rest — desktop keys tabs by path,
   *  so this opens (or focuses) a dedicated tab for the file. */
  function openInNewTab(node: WorkspaceNode) {
    tabsStore.getState().open(node.path, node.name);
  }

  /** Export the note's markdown to disk as {basename}.md via the shared exporter. */
  async function exportNode(node: WorkspaceNode) {
    try {
      const text = await readNote(node.path);
      const base = node.name.toLowerCase().endsWith(".md") ? node.name.slice(0, -3) : node.name;
      downloadMarkdown(base, text);
    } catch (err) {
      console.error("[export] failed", err);
      window.alert(`Could not export: ${err}`);
    }
  }

  /** Build the adapted, grouped context menu for a file or folder. */
  function menuItems(node: WorkspaceNode): MenuItem[] {
    if (node.isDir) {
      // Folder menu: creation actions, then open/rename/move, then info, then trash.
      return [
        { label: "New note", icon: SquarePen, action: () => void newNoteIn(node.path) },
        { label: "New folder", icon: FolderPlus, action: () => void newFolderIn(node.path) },
        "separator",
        { label: "Rename", icon: Pencil, action: () => setPendingRename(node.path) },
        {
          label: "Move to…",
          icon: FolderInput,
          action: () => setMoveTarget({ path: node.path, name: node.name }),
        },
        "separator",
        {
          label: "Folder information",
          icon: Info,
          action: () => setInfoTarget({ path: node.path, name: node.name }),
        },
        "separator",
        {
          label: "Move to trash",
          icon: Trash2,
          danger: true,
          action: () => setPendingDelete(node.path),
        },
      ];
    }
    // File menu mirrors the webapp's: open / open-in-new-tab, rename / move,
    // export, file-info, move-to-trash. (Starred + Share skipped.)
    return [
      { label: "Open", icon: FilePlus, action: () => openNode(node) },
      { label: "Open in new tab", icon: SquareArrowOutUpRight, action: () => openInNewTab(node) },
      "separator",
      { label: "Rename", icon: Pencil, action: () => setPendingRename(node.path) },
      {
        label: "Move to…",
        icon: FolderInput,
        action: () => setMoveTarget({ path: node.path, name: node.name }),
      },
      "separator",
      { label: "Export…", icon: Download, action: () => void exportNode(node) },
      {
        label: "File information",
        icon: Info,
        action: () => setInfoTarget({ path: node.path, name: node.name }),
      },
      "separator",
      {
        label: "Move to trash",
        icon: Trash2,
        danger: true,
        action: () => setPendingDelete(node.path),
      },
    ];
  }

  // Show the in-app DOM context menu on right-click.
  function handleContextMenu(e: React.MouseEvent, node: WorkspaceNode) {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, items: menuItems(node) });
  }

  const topLevelChildren = tree?.children ? sortNodes(tree.children, sortMode) : [];

  return (
    <>
      {/* No horizontal padding here — indentation and the sidebar's side
          gutter are each row's own padding, so the hover/active highlight
          spans the full width of the sidebar (.tree-row-wrap in app.css). */}
      <div className="flex flex-col py-1">
        {topLevelChildren.map((child) => (
          <TreeNode
            key={child.path}
            node={child}
            depth={0}
            activePath={activePath}
            onOpen={onOpen}
            onContextMenu={handleContextMenu}
            pendingRename={pendingRename}
            pendingDelete={pendingDelete}
            onRenameDone={() => setPendingRename(null)}
            onDeleteDone={() => setPendingDelete(null)}
          />
        ))}
      </div>

      {menu ? (
        <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />
      ) : null}

      {moveTarget ? (
        <MoveToModal
          srcPath={moveTarget.path}
          srcName={moveTarget.name}
          onClose={() => setMoveTarget(null)}
        />
      ) : null}

      {infoTarget ? (
        <FileInfoPopover
          path={infoTarget.path}
          name={infoTarget.name}
          onClose={() => setInfoTarget(null)}
        />
      ) : null}
    </>
  );
});
