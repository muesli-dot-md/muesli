<script lang="ts">
  // Read-only point-in-time snapshot view (history time-travel). Renders the
  // fetched snapshot text through the SAME markdown pipeline as the live reading
  // view, but never touches the live document. A banner explains the mode and
  // offers a close affordance that returns to the live editor.
  import { X } from "lucide-svelte";
  import { renderMarkdown } from "@muesli/editor-core/render";
  import { renderMermaidDiagrams } from "@muesli/editor-core/mermaid";
  import { relativeTime } from "./collabStore.svelte";
  import type { HistoryEntry } from "./collabApi";

  const {
    text,
    entry,
    onClose,
  }: { text: string; entry: HistoryEntry; onClose: () => void } = $props();

  let containerEl: HTMLDivElement | undefined = $state();
  const html = $derived(renderMarkdown(text));

  $effect(() => {
    void text;
    if (containerEl) renderMermaidDiagrams(containerEl);
  });
</script>

<div class="flex-1 flex flex-col min-h-0 overflow-hidden">
  <!-- "Viewing history" banner -->
  <div
    class="flex items-center justify-between gap-2 px-4 py-2 text-xs shrink-0"
    style="background: var(--lift); color: var(--color-base-content); box-shadow: var(--shadow-lift);"
  >
    <span>
      Viewing history · {relativeTime(entry.created_at)}
      {#if entry.origin}<span class="opacity-60"> · {entry.origin}</span>{/if}
      <span class="opacity-60"> (read-only)</span>
    </span>
    <button
      class="btn btn-ghost btn-xs btn-square active:scale-[0.96]"
      title="Return to the live document"
      onclick={onClose}
    >
      <X size={14} />
    </button>
  </div>

  <div class="reading-view-wrapper flex-1 overflow-auto flex justify-center">
    <div bind:this={containerEl} class="prose-muesli reading-view">
      {@html html}
    </div>
  </div>
</div>
