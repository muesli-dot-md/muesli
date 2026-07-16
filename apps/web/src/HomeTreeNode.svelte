<script lang="ts">
  // Recursive node for the Home "tree" view (spec §3) — mirrors the desktop
  // FileTree/TreeNode "Arc depth" pattern: the row itself (.tree-row-wrap)
  // carries the active/hover highlight across the pane width, with a
  // disclosure chevron and an indent-guide line (.tree-children) marking
  // nesting depth. Folders expand/collapse; docs open. Reuses Home's
  // drag-drop + context-menu callbacks so behavior matches the list/grid views.
  import ChevronRight from "@lucide/svelte/icons/chevron-right";
  import FileText from "@lucide/svelte/icons/file-text";
  import Folder from "@lucide/svelte/icons/folder";
  import FolderOpenGlyph from "./FolderOpenGlyph.svelte";
  import Star from "@lucide/svelte/icons/star";
  import { t } from "./i18n/index.svelte";
  import type { InfoTarget } from "./InfoPanel.svelte";
  import type { DocumentSummary, FolderSummary } from "./workspaceApi";
  import HomeTreeNode from "./HomeTreeNode.svelte";

  interface Props {
    folder: FolderSummary;
    depth: number;
    /** child folders of a given folder id, pre-sorted */
    childFolders: (id: string) => FolderSummary[];
    /** docs whose folder_id === id, pre-sorted */
    folderDocs: (id: string) => DocumentSummary[];
    expanded: Record<string, boolean>;
    toggle: (id: string) => void;
    selectedRef: { kind: "doc" | "folder"; id: string } | null;
    activeSlug: string | null;
    dndEnabled: boolean;
    dropKey: string | null;
    docName: (d: DocumentSummary) => string;
    onSelect: (tgt: InfoTarget) => void;
    onOpen: (tgt: InfoTarget) => void;
    onContextMenu: (e: MouseEvent, tgt: InfoTarget) => void;
    onDragStart: (e: DragEvent, tgt: InfoTarget) => void;
    onDragEnd: () => void;
    onDragOver: (e: DragEvent, destId: string | null, key: string) => void;
    onDragLeave: (key: string) => void;
    onDrop: (e: DragEvent, destId: string | null) => void;
  }

  let {
    folder,
    depth,
    childFolders,
    folderDocs,
    expanded,
    toggle,
    selectedRef,
    activeSlug,
    dndEnabled,
    dropKey,
    docName,
    onSelect,
    onOpen,
    onContextMenu,
    onDragStart,
    onDragEnd,
    onDragOver,
    onDragLeave,
    onDrop,
  }: Props = $props();

  const isOpen = $derived(expanded[folder.id] === true);
  const kids = $derived(childFolders(folder.id));
  const docs = $derived(folderDocs(folder.id));
  const folderTgt = $derived({ kind: "folder", folder } as InfoTarget);
  const isFolderSelected = $derived(selectedRef?.kind === "folder" && selectedRef.id === folder.id);
  const dropping = $derived(dropKey === "folder:" + folder.id);
</script>

<!-- Folder row -->
<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div
  class="tree-row-wrap flex cursor-pointer items-center select-none"
  class:active={isFolderSelected}
  class:drop-target={dropping}
  style:padding-left="{depth * 14 + 12}px"
  style="padding-top: 2px; padding-bottom: 2px; padding-right: 12px;"
  draggable={dndEnabled}
  ondragstart={(e) => onDragStart(e, folderTgt)}
  ondragend={onDragEnd}
  ondragover={(e) => onDragOver(e, folder.id, "folder:" + folder.id)}
  ondragleave={() => onDragLeave("folder:" + folder.id)}
  ondrop={(e) => onDrop(e, folder.id)}
  onclick={(e) => {
    e.stopPropagation();
    onSelect(folderTgt);
    toggle(folder.id);
  }}
  ondblclick={() => onOpen(folderTgt)}
  oncontextmenu={(e) => onContextMenu(e, folderTgt)}
  role="treeitem"
  aria-expanded={isOpen}
  aria-selected={isFolderSelected}
  tabindex="0"
  onkeydown={(e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      toggle(folder.id);
    }
  }}
>
  <span
    class="shrink-0 text-base-content/45 transition-transform duration-150"
    style={isOpen ? "transform: rotate(90deg)" : ""}
  >
    <ChevronRight size={15} aria-hidden="true" />
  </span>
  <div class="tree-row-label items-center gap-1.5 min-w-0" style="padding: 1px 7px;">
    <!-- --folder-accent (app.css) composes to exactly --arc-accent until the
         user picks a folder hue in Settings → Appearance; both glyphs carry
         the soft same-hue interior wash: .folder-glyph fills the CLOSED
         lucide Folder, and FolderOpenGlyph's closed flap subpath takes the
         same fill (lucide's own FolderOpen path cannot be filled — see
         app.css). Mirrors the desktop's TreeNode. -->
    {#if isOpen}
      <FolderOpenGlyph size={17} class="shrink-0 text-[var(--folder-accent)]" />
    {:else}
      <Folder
        size={17}
        class="folder-glyph shrink-0 text-[var(--folder-accent)]"
        aria-hidden="true"
      />
    {/if}
    <span class="truncate text-sm">{folder.name}</span>
  </div>
</div>

{#if isOpen}
  <div class="tree-children" style="--guide-x: {depth * 14 + 23}px;">
    {#each kids as k (k.id)}
      <HomeTreeNode
        folder={k}
        depth={depth + 1}
        {childFolders}
        {folderDocs}
        {expanded}
        {toggle}
        {selectedRef}
        {activeSlug}
        {dndEnabled}
        {dropKey}
        {docName}
        {onSelect}
        {onOpen}
        {onContextMenu}
        {onDragStart}
        {onDragEnd}
        {onDragOver}
        {onDragLeave}
        {onDrop}
      />
    {/each}
    {#each docs as d (d.document_id)}
      {@const docTgt = { kind: "doc", doc: d } as InfoTarget}
      {@const isDocSelected = selectedRef?.kind === "doc" && selectedRef.id === d.document_id}
      <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
      <div
        class="tree-row-wrap flex cursor-pointer items-center select-none"
        class:active={isDocSelected || activeSlug === d.slug}
        style:padding-left="{(depth + 1) * 14 + 12}px"
        style="padding-top: 2px; padding-bottom: 2px; padding-right: 12px;"
        draggable={dndEnabled}
        ondragstart={(e) => onDragStart(e, docTgt)}
        ondragend={onDragEnd}
        onclick={(e) => {
          e.stopPropagation();
          onSelect(docTgt);
        }}
        ondblclick={() => onOpen(docTgt)}
        oncontextmenu={(e) => onContextMenu(e, docTgt)}
        role="treeitem"
        aria-selected={isDocSelected}
        tabindex="0"
        onkeydown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onOpen(docTgt);
          }
        }}
      >
        <span class="shrink-0" style="width: 15px;"></span>
        <div class="tree-row-label items-center gap-1.5 min-w-0" style="padding: 1px 7px;">
          <FileText size={15} class="shrink-0 text-primary" aria-hidden="true" />
          <span class="truncate text-sm">{docName(d)}</span>
          {#if d.starred}
            <Star
              class="h-3 w-3 shrink-0 text-warning"
              fill="currentColor"
              aria-label={t("home.starred")}
            />
          {/if}
        </div>
      </div>
    {/each}
  </div>
{/if}
