<script lang="ts">
  import { fuzzyFilter } from "$lib/commands/fuzzy";
  import { workspace } from "$lib/workspace.svelte";
  import { tabs } from "$lib/tabs.svelte";
  import type { WorkspaceNode } from "$lib/tauri";

  interface FileItem {
    path: string;
    display: string; // workspace-relative path
  }

  interface Props {
    open: boolean;
    onclose: () => void;
  }

  let { open, onclose }: Props = $props();

  let query = $state("");
  let highlightIdx = $state(0);
  let inputEl: HTMLInputElement | undefined = $state();

  function flattenTree(node: WorkspaceNode, root: string): FileItem[] {
    if (!node.isDir) {
      const display = node.path.startsWith(root + "/")
        ? node.path.slice(root.length + 1)
        : node.path;
      return [{ path: node.path, display }];
    }
    if (!node.children) return [];
    return node.children.flatMap((child) => flattenTree(child, root));
  }

  let allFiles = $derived(
    workspace.tree && workspace.root ? flattenTree(workspace.tree, workspace.root) : [],
  );

  let filtered = $derived(fuzzyFilter(allFiles, query, (f) => f.display));

  $effect(() => {
    if (open) {
      query = "";
      highlightIdx = 0;
      requestAnimationFrame(() => inputEl?.focus());
    }
  });

  $effect(() => {
    if (highlightIdx >= filtered.length) {
      highlightIdx = Math.max(0, filtered.length - 1);
    }
  });

  function openFile(file: FileItem) {
    const name = file.path.split("/").at(-1) ?? file.path;
    tabs.open(file.path, name);
    onclose();
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      onclose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      highlightIdx = Math.min(highlightIdx + 1, filtered.length - 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      highlightIdx = Math.max(highlightIdx - 1, 0);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const file = filtered[highlightIdx];
      if (file) openFile(file);
    }
  }

  function handleBackdropClick(e: MouseEvent) {
    if (e.target === e.currentTarget) onclose();
  }
</script>

{#if open}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="fixed inset-0 z-50 flex items-start justify-center pt-24 bg-black/40"
    onclick={handleBackdropClick}
    onkeydown={handleKeydown}
  >
    <div
      class="w-full max-w-xl flex flex-col overflow-hidden"
      style="background: var(--overlay); box-shadow: var(--shadow-overlay); border-radius: var(--radius-overlay, 0.875rem);"
    >
      <!-- Search input -->
      <div class="px-3 pt-3 pb-2 border-b border-base-300">
        <input
          bind:this={inputEl}
          bind:value={query}
          type="text"
          placeholder="Open note..."
          class="input input-sm w-full bg-base-100 border-base-300 focus:outline-none"
          onkeydown={handleKeydown}
        />
      </div>

      <!-- Results list -->
      <ul class="overflow-y-auto max-h-72 py-1">
        {#if allFiles.length === 0}
          <li class="px-4 py-2 text-sm text-base-content/50 italic">
            No workspace open or no notes found
          </li>
        {:else if filtered.length === 0}
          <li class="px-4 py-2 text-sm text-base-content/50 italic">No notes match "{query}"</li>
        {:else}
          {#each filtered as file, i (file.path)}
            <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
            <li
              class="flex items-center px-4 py-2 text-sm cursor-pointer transition-colors {i ===
              highlightIdx
                ? 'bg-base-200 text-base-content'
                : 'hover:bg-base-200/60 text-base-content/80'}"
              onclick={() => openFile(file)}
              onkeydown={(e) => {
                if (e.key === "Enter") openFile(file);
              }}
              onmouseenter={() => (highlightIdx = i)}
            >
              <span class="truncate">{file.display}</span>
            </li>
          {/each}
        {/if}
      </ul>
    </div>
  </div>
{/if}
