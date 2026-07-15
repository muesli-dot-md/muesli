<script lang="ts">
  import type { WorkspaceNode } from "$lib/tauri";
  import { createNote, createFolder, readNote } from "$lib/tauri";
  import { workspace } from "$lib/workspace.svelte";
  import { tabs } from "$lib/tabs.svelte";
  import { sortNodes } from "$lib/sortNodes";
  import TreeNode from "$lib/TreeNode.svelte";
  import ContextMenu, { type MenuItem } from "$lib/ContextMenu.svelte";
  import MoveToModal from "$lib/MoveToModal.svelte";
  import FileInfoPopover from "$lib/FileInfoPopover.svelte";
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
  } from "lucide-svelte";

  interface Props {
    tree: WorkspaceNode;
    activePath: string | null;
    onOpen: (path: string) => void;
  }

  let { tree, activePath, onOpen }: Props = $props();

  // Pending signals for rename/delete — cleared by TreeNode callbacks
  let pendingRename = $state<string | null>(null);
  let pendingDelete = $state<string | null>(null);

  // DOM context menu + the modals it launches.
  let menu = $state<{ x: number; y: number; items: MenuItem[] } | null>(null);
  let moveTarget = $state<{ path: string; name: string } | null>(null);
  let infoTarget = $state<{ path: string; name: string } | null>(null);

  // Finder-style creation: make the entry with a default name, then drop straight into
  // the existing inline-rename flow. window.prompt() is NOT an option here — wry's
  // WKWebView implements no JS text-input panel, so prompt() returns null and the old
  // prompt-based flow silently did nothing on macOS.
  async function newNoteIn(dir: string) {
    try {
      const newPath = await createNote(dir, "Untitled.md");
      workspace.expandedPaths.add(dir);
      await workspace.refresh();
      pendingRename = newPath;
    } catch (err) {
      console.error("[create] new note failed", err);
    }
  }

  async function newFolderIn(dir: string) {
    try {
      const newPath = await createFolder(dir, "New folder");
      workspace.expandedPaths.add(dir);
      await workspace.refresh();
      pendingRename = newPath;
    } catch (err) {
      console.error("[create] new folder failed", err);
    }
  }

  /** Enter inline-rename mode for `path` (also used by AppShell's toolbar "new folder",
   *  which creates at the workspace root and then hands the naming off to the tree). */
  export function startRename(path: string) {
    pendingRename = path;
  }

  /** Open in the current tab (activates the existing tab if already open). */
  function openNode(node: WorkspaceNode) {
    onOpen(node.path);
  }

  /** Open in a tab without disturbing the rest — desktop keys tabs by path, so
   *  this opens (or focuses) a dedicated tab for the file. */
  function openInNewTab(node: WorkspaceNode) {
    tabs.open(node.path, node.name);
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
        {
          label: "Rename",
          icon: Pencil,
          action: () => {
            pendingRename = node.path;
          },
        },
        {
          label: "Move to…",
          icon: FolderInput,
          action: () => {
            moveTarget = { path: node.path, name: node.name };
          },
        },
        "separator",
        {
          label: "Folder information",
          icon: Info,
          action: () => {
            infoTarget = { path: node.path, name: node.name };
          },
        },
        "separator",
        {
          label: "Move to trash",
          icon: Trash2,
          danger: true,
          action: () => {
            pendingDelete = node.path;
          },
        },
      ];
    }
    // File menu mirrors the webapp's: open / open-in-new-tab, rename / move,
    // export, file-info, move-to-trash. (Starred + Share skipped — see report.)
    return [
      { label: "Open", icon: FilePlus, action: () => openNode(node) },
      { label: "Open in new tab", icon: SquareArrowOutUpRight, action: () => openInNewTab(node) },
      "separator",
      {
        label: "Rename",
        icon: Pencil,
        action: () => {
          pendingRename = node.path;
        },
      },
      {
        label: "Move to…",
        icon: FolderInput,
        action: () => {
          moveTarget = { path: node.path, name: node.name };
        },
      },
      "separator",
      { label: "Export…", icon: Download, action: () => void exportNode(node) },
      {
        label: "File information",
        icon: Info,
        action: () => {
          infoTarget = { path: node.path, name: node.name };
        },
      },
      "separator",
      {
        label: "Move to trash",
        icon: Trash2,
        danger: true,
        action: () => {
          pendingDelete = node.path;
        },
      },
    ];
  }

  // Show the in-app DOM context menu on right-click (replaces the OS-native menu
  // for visual parity with the webapp's grouped/sectioned look).
  function handleContextMenu(e: MouseEvent, node: WorkspaceNode) {
    e.preventDefault();
    menu = { x: e.clientX, y: e.clientY, items: menuItems(node) };
  }

  const topLevelChildren = $derived(
    tree.children ? sortNodes(tree.children, workspace.sortMode) : [],
  );
</script>

<!-- No horizontal padding here — indentation and the sidebar's side gutter
     are each row's own padding, so the hover/active highlight spans the full
     width of the sidebar (see .tree-row-wrap in app.css). -->
<div class="flex flex-col py-1">
  {#each topLevelChildren as child (child.path)}
    <TreeNode
      node={child}
      depth={0}
      {activePath}
      {onOpen}
      onContextMenu={handleContextMenu}
      {pendingRename}
      {pendingDelete}
      onRenameDone={() => (pendingRename = null)}
      onDeleteDone={() => (pendingDelete = null)}
    />
  {/each}
</div>

{#if menu}
  <ContextMenu x={menu.x} y={menu.y} items={menu.items} onclose={() => (menu = null)} />
{/if}

{#if moveTarget}
  <MoveToModal
    srcPath={moveTarget.path}
    srcName={moveTarget.name}
    onclose={() => (moveTarget = null)}
  />
{/if}

{#if infoTarget}
  <FileInfoPopover
    path={infoTarget.path}
    name={infoTarget.name}
    onclose={() => (infoTarget = null)}
  />
{/if}
