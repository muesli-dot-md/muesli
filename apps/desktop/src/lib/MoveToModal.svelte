<script lang="ts">
  // "Move to…" picker — a centered modal listing every eligible destination
  // folder (excludes self, descendants, and the current parent). Reuses the
  // vault `move_path` Tauri command. Local-first; no server involvement.
  import { Folder, FolderInput } from 'lucide-svelte';
  import { movePath } from '$lib/tauri';
  import { workspace } from '$lib/workspace.svelte';
  import { collectFolderTargets } from '$lib/fileInfo';

  interface Props {
    /** Absolute path of the file/folder being moved. */
    srcPath: string;
    srcName: string;
    onclose: () => void;
    /** Called with the new path after a successful move. */
    onmoved?: (newPath: string) => void;
  }

  let { srcPath, srcName, onclose, onmoved }: Props = $props();

  let error = $state('');
  let busy = $state(false);

  const targets = $derived(
    workspace.tree && workspace.root
      ? collectFolderTargets(workspace.tree, workspace.root, srcPath)
      : [],
  );

  async function moveTo(destDir: string) {
    if (busy) return;
    busy = true;
    error = '';
    try {
      const newPath = await movePath(srcPath, destDir);
      workspace.expandedPaths.add(destDir);
      await workspace.refresh();
      onmoved?.(newPath);
      onclose();
    } catch (e) {
      error = String(e);
      busy = false;
    }
  }

  function handleBackdropClick(e: MouseEvent) {
    if (e.target === e.currentTarget) onclose();
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="fixed inset-0 z-50 flex items-start justify-center pt-[14vh] bg-black/40"
  onclick={handleBackdropClick}
  onkeydown={(e) => { if (e.key === 'Escape') onclose(); }}
>
  <div
    class="move-card flex max-h-[64vh] w-full max-w-md flex-col overflow-hidden mx-4"
    style="background: var(--overlay); box-shadow: var(--shadow-overlay); border-radius: var(--radius-overlay, 0.875rem);"
    role="dialog"
    aria-modal="true"
    aria-label="Move {srcName}"
  >
    <div class="flex items-center gap-2 border-b border-base-300 px-4 py-3">
      <FolderInput size={16} class="shrink-0 opacity-60" />
      <span class="truncate text-sm font-medium">Move “{srcName}” to…</span>
    </div>

    {#if error}
      <p class="px-4 py-2 text-xs text-error">{error}</p>
    {/if}

    <div class="min-h-0 overflow-y-auto py-1">
      {#if targets.length === 0}
        <p class="px-4 py-6 text-sm text-base-content/50">No other folder to move into.</p>
      {:else}
        {#each targets as t (t.path)}
          <button
            class="move-row flex w-full items-center gap-2 px-4 text-left text-sm hover:bg-base-200 focus:bg-base-200 focus:outline-none disabled:opacity-50"
            style="padding-left: {12 + t.depth * 14}px;"
            disabled={busy}
            onclick={() => moveTo(t.path)}
          >
            <Folder size={15} class="shrink-0 text-base-content/55" />
            <span class="truncate">{t.label}</span>
          </button>
        {/each}
      {/if}
    </div>
  </div>
</div>

<style>
  .move-row {
    min-height: 40px;
    padding-top: 0.35rem;
    padding-bottom: 0.35rem;
    transition: background-color 100ms ease, transform 70ms ease;
  }
  .move-row:active {
    transform: scale(0.99);
  }
  .move-card {
    animation: move-pop 130ms cubic-bezier(0.16, 1, 0.3, 1);
  }
  @keyframes move-pop {
    from {
      opacity: 0;
      transform: translateY(-6px) scale(0.985);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .move-card {
      animation: none;
    }
    .move-row {
      transition: none;
    }
    .move-row:active {
      transform: none;
    }
  }
</style>
