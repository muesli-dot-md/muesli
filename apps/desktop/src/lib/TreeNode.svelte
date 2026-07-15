<script lang="ts">
  import { ChevronRight, Folder, FolderOpen, FileText } from "lucide-svelte";
  import type { WorkspaceNode } from "$lib/tauri";
  import { workspace } from "$lib/workspace.svelte";
  import { tabs } from "$lib/tabs.svelte";
  import { renamePath, deletePath, movePath } from "$lib/tauri";
  import { sortNodes } from "$lib/sortNodes";
  import { dnd } from "$lib/dnd.svelte";
  import TreeNode from "$lib/TreeNode.svelte";

  interface Props {
    node: WorkspaceNode;
    depth: number;
    activePath: string | null;
    onOpen: (path: string) => void;
    onContextMenu: (e: MouseEvent, node: WorkspaceNode) => void;
    /** When this equals node.path, enter rename mode */
    pendingRename: string | null;
    /** When this equals node.path, open delete confirm */
    pendingDelete: string | null;
    onRenameDone: () => void;
    onDeleteDone: () => void;
  }

  let {
    node,
    depth,
    activePath,
    onOpen,
    onContextMenu,
    pendingRename,
    pendingDelete,
    onRenameDone,
    onDeleteDone,
  }: Props = $props();

  // Drive expanded from workspace.expandedPaths so collapseAll() (which replaces the Set)
  // is reflected immediately without relying on onMount.
  let expanded = $derived(workspace.expandedPaths.has(node.path));
  let renaming = $state(false);
  let renameValue = $state("");
  let renameError = $state("");
  let renameInput: HTMLInputElement | undefined = $state(undefined);

  let deleteConfirmOpen = $state(false);
  let deleteError = $state("");

  // ── Drag-and-drop move ─────────────────────────────────────────────────────
  let dragOver = $state(false);

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

  function onDragStart(e: DragEvent) {
    if (renaming) {
      e.preventDefault();
      return;
    }
    dnd.draggingPath = node.path;
    if (e.dataTransfer) {
      e.dataTransfer.setData("text/plain", node.path);
      e.dataTransfer.effectAllowed = "move";
    }
    e.stopPropagation();
  }

  function onDragEnd() {
    dnd.draggingPath = null;
    dragOver = false;
  }

  // Folders always accept the drop (so the `drop` event reliably fires); the
  // actual legality is validated in onDrop. Highlight any folder being hovered.
  function onDragOver(e: DragEvent) {
    if (!node.isDir) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    dragOver = true;
  }

  function onDragLeave() {
    dragOver = false;
  }

  async function onDrop(e: DragEvent) {
    if (!node.isDir) return;
    e.preventDefault();
    e.stopPropagation();
    dragOver = false;
    // Only the shared drag state is authoritative: with native drag-drop interception
    // off, ANY text/plain drag (a dragged editor selection, content from another app)
    // reaches this handler, and its payload must not be mistaken for a tree path.
    const src = dnd.draggingPath ?? "";
    dnd.draggingPath = null;
    if (!src || !isValidDrop(src)) return;
    try {
      await tabs.flush(src);
      const newPath = await movePath(src, node.path);
      tabs.retarget(src, newPath);
      workspace.expandedPaths.add(node.path);
      await workspace.refresh();
    } catch (err) {
      console.error("[move] failed", err);
      window.alert(`Could not move: ${err}`);
    }
  }

  // React to pendingRename signal
  $effect(() => {
    if (pendingRename === node.path && !renaming) {
      renaming = true;
      renameValue = node.name;
      renameError = "";
    }
  });

  // React to pendingDelete signal
  $effect(() => {
    if (pendingDelete === node.path && !deleteConfirmOpen) {
      deleteConfirmOpen = true;
    }
  });

  // Auto-focus rename input when it appears
  $effect(() => {
    if (renaming && renameInput) {
      renameInput.focus();
      renameInput.select();
    }
  });

  function toggleExpand() {
    if (workspace.expandedPaths.has(node.path)) {
      workspace.expandedPaths.delete(node.path);
    } else {
      workspace.expandedPaths.add(node.path);
    }
  }

  // Guards commitRename against re-entry: Enter and the input's blur both commit, and
  // a successful commit unmounts the input (which fires blur) — without the guard the
  // second call renames again ("target already exists") on a node about to be re-keyed.
  let renameCommitting = false;

  async function commitRename() {
    if (!renaming || renameCommitting) return;
    const newName = renameValue.trim();
    if (!newName || newName === node.name) {
      renaming = false;
      onRenameDone();
      return;
    }
    renameCommitting = true;
    try {
      // Persist any pending autosave to the OLD path first: after the rename, a late
      // debounced write would recreate the old filename on disk (the "rename doesn't
      // stick" bug). flush() is a no-op when nothing is pending.
      await tabs.flush(node.path);
      const newPath = await renamePath(node.path, newName);
      // Follow open tabs (and, for a folder, everything under it) to the new path so
      // the editor remounts against the renamed file instead of resurrecting the old one.
      tabs.retarget(node.path, newPath);
      await workspace.refresh();
      renaming = false;
      onRenameDone();
    } catch (err) {
      renameError = String(err);
    } finally {
      renameCommitting = false;
    }
  }

  function cancelRename() {
    renaming = false;
    renameError = "";
    onRenameDone();
  }

  async function confirmDelete() {
    try {
      await deletePath(node.path);
      await workspace.refresh();
    } catch (e) {
      deleteError = String(e);
      return; // keep the modal open so the error is visible
    }
    deleteConfirmOpen = false;
    deleteError = "";
    onDeleteDone();
  }

  function cancelDelete() {
    deleteConfirmOpen = false;
    deleteError = "";
    onDeleteDone();
  }

  function handleRowContextMenu(e: MouseEvent) {
    e.preventDefault();
    onContextMenu(e, node);
  }

  const sortedChildren = $derived(
    node.isDir && node.children ? sortNodes(node.children, workspace.sortMode) : [],
  );

  const isActive = $derived(!node.isDir && node.path === activePath);
</script>

<!-- Node row: the row itself is the click target AND the full-width
     hover/active highlight (rounded, spanning the sidebar width). Draggable to
     move; folders are drop targets. -->
<div
  class="tree-row-wrap flex items-center text-sm cursor-pointer select-none"
  class:active={isActive}
  class:drop-target={dragOver}
  style:padding-left="{depth * 12 + 4}px"
  style="padding-top: 4px; padding-bottom: 4px; padding-right: 8px;"
  draggable={!renaming}
  ondragstart={onDragStart}
  ondragend={onDragEnd}
  ondragover={onDragOver}
  ondragleave={onDragLeave}
  ondrop={onDrop}
  onclick={() => {
    if (node.isDir) toggleExpand();
    else onOpen(node.path);
  }}
  oncontextmenu={handleRowContextMenu}
  role="button"
  tabindex="0"
  onkeydown={(e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (node.isDir) toggleExpand();
      else onOpen(node.path);
    }
  }}
>
  <!-- Disclosure chevron (folders) / alignment spacer (files). -->
  {#if node.isDir}
    <span
      class="shrink-0 transition-transform duration-150 text-base-content/45"
      style={expanded ? "transform: rotate(90deg)" : ""}
    >
      <ChevronRight size={15} />
    </span>
  {:else}
    <span class="shrink-0" style="width: 15px;"></span>
  {/if}

  <div class="tree-row-label items-center gap-1.5 min-w-0" style="padding: 1px 7px;">
    {#if node.isDir}
      {#if expanded}
        <FolderOpen size={17} class="shrink-0 text-[var(--folder-accent)]" />
      {:else}
        <Folder size={17} class="shrink-0 text-[var(--folder-accent)]" />
      {/if}
    {:else}
      <FileText size={15} class="shrink-0 text-base-content/50" />
    {/if}

    {#if renaming}
      <!-- Inline rename input - stop propagation so click doesn't toggle expand -->
      <div
        class="flex flex-col gap-0.5 min-w-[12rem]"
        onclick={(e) => e.stopPropagation()}
        role="none"
      >
        <input
          bind:this={renameInput}
          class="input input-xs w-full min-w-0"
          bind:value={renameValue}
          onkeydown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commitRename();
            }
            if (e.key === "Escape") cancelRename();
          }}
          onblur={() => void commitRename()}
        />
        {#if renameError}
          <p class="text-error text-xs">{renameError}</p>
        {/if}
      </div>
    {:else}
      <span class="truncate">{node.name}</span>
    {/if}
  </div>
</div>

<!-- Children (when folder expanded): wrapped so an indent-guide line
     (.tree-children, positioned under this folder's own chevron) can run
     down through them, Obsidian-style. -->
{#if node.isDir && expanded}
  <div class="tree-children" style="--guide-x: {depth * 12 + 15}px;">
    {#each sortedChildren as child (child.path)}
      <TreeNode
        node={child}
        depth={depth + 1}
        {activePath}
        {onOpen}
        {onContextMenu}
        {pendingRename}
        {pendingDelete}
        {onRenameDone}
        {onDeleteDone}
      />
    {/each}
  </div>
{/if}

<!-- Delete confirm modal -->
{#if deleteConfirmOpen}
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
    onclick={cancelDelete}
    onkeydown={(e) => {
      if (e.key === "Escape") cancelDelete();
    }}
    role="presentation"
  >
    <div
      class="bg-base-100 rounded-box p-6 shadow-xl max-w-sm w-full mx-4"
      onclick={(e) => e.stopPropagation()}
      onkeydown={(e) => e.stopPropagation()}
      role="dialog"
      aria-modal="true"
      tabindex="-1"
    >
      <h3 class="font-bold text-base mb-2">Delete {node.name}?</h3>
      <p class="text-sm text-base-content/70 mb-4">This cannot be undone.</p>
      {#if deleteError}
        <p class="text-sm text-error mb-3">{deleteError}</p>
      {/if}
      <div class="flex justify-end gap-2">
        <button class="btn btn-sm btn-ghost" onclick={cancelDelete}> Cancel </button>
        <button class="btn btn-sm btn-error" onclick={confirmDelete}> Delete </button>
      </div>
    </div>
  </div>
{/if}
