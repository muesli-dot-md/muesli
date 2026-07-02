<script lang="ts">
  import { commands } from "$lib/commands/registry.svelte";
  import { fuzzyFilter } from "$lib/commands/fuzzy";
  import type { Command } from "$lib/commands/registry.svelte";

  interface Props {
    open: boolean;
    onclose: () => void;
  }

  let { open, onclose }: Props = $props();

  let query = $state("");
  let highlightIdx = $state(0);
  let inputEl: HTMLInputElement | undefined = $state();

  let filtered = $derived(fuzzyFilter(commands.all(), query, (c) => c.title));

  // Reset state when opened
  $effect(() => {
    if (open) {
      query = "";
      highlightIdx = 0;
      // Focus input after render
      requestAnimationFrame(() => inputEl?.focus());
    }
  });

  // Clamp highlight when list changes
  $effect(() => {
    if (highlightIdx >= filtered.length) {
      highlightIdx = Math.max(0, filtered.length - 1);
    }
  });

  function runCommand(cmd: Command) {
    onclose();
    cmd.run();
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
      const cmd = filtered[highlightIdx];
      if (cmd) runCommand(cmd);
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
          placeholder="Type a command..."
          class="input input-sm w-full bg-base-100 border-base-300 focus:outline-none"
          onkeydown={handleKeydown}
        />
      </div>

      <!-- Results list -->
      <ul class="overflow-y-auto max-h-72 py-1">
        {#if filtered.length === 0}
          <li class="px-4 py-2 text-sm text-base-content/50 italic">No commands found</li>
        {:else}
          {#each filtered as cmd, i (cmd.id)}
            <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
            <li
              class="flex items-center justify-between px-4 py-2 text-sm cursor-pointer transition-colors {i ===
              highlightIdx
                ? 'bg-base-200 text-base-content'
                : 'hover:bg-base-200/60 text-base-content/80'}"
              onclick={() => runCommand(cmd)}
              onkeydown={(e) => {
                if (e.key === "Enter") runCommand(cmd);
              }}
              onmouseenter={() => (highlightIdx = i)}
            >
              <span>{cmd.title}</span>
              {#if cmd.hotkey}
                <kbd class="kbd kbd-xs text-base-content/50 ml-4 shrink-0">{cmd.hotkey}</kbd>
              {/if}
            </li>
          {/each}
        {/if}
      </ul>
    </div>
  </div>
{/if}
