<script lang="ts">
  import { X, Plus } from 'lucide-svelte';
  import { tabs } from '$lib/tabs.svelte';
  import { workspace } from '$lib/workspace.svelte';
  import { createNote } from '$lib/tauri';

  async function handleNewTab() {
    if (!workspace.root) return;
    const newPath = await createNote(workspace.root, 'Untitled.md');
    await workspace.refresh();
    const name = newPath.split('/').at(-1) ?? newPath;
    tabs.open(newPath, name);
  }
</script>

<div class="tab-scroll flex items-center h-full overflow-x-auto gap-1" data-tauri-drag-region>
  {#each tabs.tabs as tab (tab.id)}
    {@const isActive = tab.id === tabs.activeId}
    <div
      class="ttab flex items-center gap-1 pl-2.5 pr-1 py-1 max-w-[180px] text-sm select-none whitespace-nowrap"
      class:ttab-active={isActive}
      class:ttab-inactive={!isActive}
      role="tab"
      aria-selected={isActive}
      tabindex={isActive ? 0 : -1}
    >
      <button
        type="button"
        class="flex items-center gap-1 min-w-0 cursor-default bg-transparent border-0 p-0 text-inherit text-sm"
        onclick={() => tabs.activate(tab.id)}
        aria-label="Activate {tab.name}"
      >
        {#if tab.dirty}
          <span class="w-1.5 h-1.5 rounded-full bg-primary shrink-0"></span>
        {/if}
        <span class="truncate">{tab.name}</span>
      </button>
      <!-- Close: always present (in flow) so the tab width stays consistent and
           the X never overlaps the filename. -->
      <button
        type="button"
        class="rounded p-0.5 shrink-0 text-base-content/45 hover:text-base-content hover:bg-base-content/10 transition-colors"
        aria-label="Close {tab.name}"
        onclick={(e) => { e.stopPropagation(); tabs.close(tab.id); }}
      >
        <X size={12} />
      </button>
    </div>
  {/each}

  <!-- New tab button -->
  <button
    type="button"
    class="btn btn-ghost btn-xs btn-square shrink-0"
    onclick={handleNewTab}
    disabled={!workspace.root}
    title="New note"
    aria-label="New note"
  >
    <Plus size={16} />
  </button>
</div>
