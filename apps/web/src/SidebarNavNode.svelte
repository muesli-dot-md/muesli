<script lang="ts">
  // Recursive sidebar navigation row for the active workspace's files/folders
  // (the Linear/Multica left-rail tree). Mirrors the Arc-depth pattern: a
  // full-width row whose inner pill (.tree-row) carries the neutral-gray hover /
  // active highlight, with a disclosure chevron outside the pill. Folders
  // expand/collapse AND navigate into the main pane (gotoFolder); docs open
  // (gotoDoc). The active row is whatever the current route points at — so the
  // open document / current folder shows the gray selected background.
  import ChevronRight from "@lucide/svelte/icons/chevron-right";
  import FileText from "@lucide/svelte/icons/file-text";
  import Folder from "@lucide/svelte/icons/folder";
  import FolderOpen from "@lucide/svelte/icons/folder-open";
  import Star from "@lucide/svelte/icons/star";
  import { t } from "./i18n/index.svelte";
  import type { DocumentSummary, FolderSummary } from "./workspaceApi";
  import SidebarNavNode from "./SidebarNavNode.svelte";

  interface Props {
    folder: FolderSummary;
    depth: number;
    childFolders: (id: string) => FolderSummary[];
    folderDocs: (id: string) => DocumentSummary[];
    expanded: Record<string, boolean>;
    toggle: (id: string) => void;
    /** route-derived active markers */
    activeFolderId: string | null;
    activeSlug: string | null;
    docName: (d: DocumentSummary) => string;
    onOpenFolder: (id: string) => void;
    onOpenDoc: (slug: string) => void;
  }

  let {
    folder,
    depth,
    childFolders,
    folderDocs,
    expanded,
    toggle,
    activeFolderId,
    activeSlug,
    docName,
    onOpenFolder,
    onOpenDoc,
  }: Props = $props();

  const isOpen = $derived(expanded[folder.id] === true);
  const kids = $derived(childFolders(folder.id));
  const docs = $derived(folderDocs(folder.id));
  const isFolderActive = $derived(activeFolderId === folder.id);
</script>

<!-- Folder row: chevron toggles expansion; the label navigates into the folder. -->
<div
  class="tree-row-wrap flex items-center select-none"
  style:padding-left="{depth * 14 + 4}px"
  style="padding-top: 1px; padding-bottom: 1px; padding-right: 4px;"
>
  <button
    class="arc-tap flex shrink-0 items-center justify-center rounded text-base-content/45 hover:text-base-content"
    style="width: 15px; height: 18px;"
    title={isOpen ? t("home.collapse") : t("home.expand")}
    aria-label={isOpen ? t("home.collapse") : t("home.expand")}
    onclick={() => toggle(folder.id)}
  >
    <span class="transition-transform duration-150" style={isOpen ? "transform: rotate(90deg)" : ""}>
      <ChevronRight size={15} aria-hidden="true" />
    </span>
  </button>
  <button
    class="tree-row flex min-w-0 flex-1 cursor-pointer items-center gap-1.5"
    class:active={isFolderActive}
    style="padding: 2px 7px;"
    onclick={() => onOpenFolder(folder.id)}
  >
    {#if isOpen}
      <FolderOpen size={17} class="shrink-0 text-base-content/60" aria-hidden="true" />
    {:else}
      <Folder size={17} class="shrink-0 text-base-content/60" aria-hidden="true" />
    {/if}
    <span class="truncate text-sm">{folder.name}</span>
  </button>
</div>

{#if isOpen}
  {#each kids as k (k.id)}
    <SidebarNavNode
      folder={k}
      depth={depth + 1}
      {childFolders}
      {folderDocs}
      {expanded}
      {toggle}
      {activeFolderId}
      {activeSlug}
      {docName}
      {onOpenFolder}
      {onOpenDoc}
    />
  {/each}
  {#each docs as d (d.document_id)}
    <div
      class="tree-row-wrap flex items-center select-none"
      style:padding-left="{(depth + 1) * 14 + 4}px"
      style="padding-top: 1px; padding-bottom: 1px; padding-right: 4px;"
    >
      <span class="shrink-0" style="width: 15px;"></span>
      <button
        class="tree-row flex min-w-0 flex-1 cursor-pointer items-center gap-1.5"
        class:active={activeSlug === d.slug}
        style="padding: 2px 7px;"
        onclick={() => onOpenDoc(d.slug)}
      >
        <FileText size={15} class="shrink-0 text-primary" aria-hidden="true" />
        <span class="truncate text-sm">{docName(d)}</span>
        {#if d.starred}
          <Star
            class="h-3 w-3 shrink-0 text-warning"
            fill="currentColor"
            aria-label={t("home.starred")}
          />
        {/if}
      </button>
    </div>
  {/each}
{/if}
