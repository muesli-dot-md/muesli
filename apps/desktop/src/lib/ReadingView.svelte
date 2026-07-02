<script lang="ts">
  import { editorState } from "$lib/editorState.svelte";
  import { renderMarkdown } from "@muesli/editor-core/render";
  import { renderMermaidDiagrams } from "@muesli/editor-core/mermaid";

  let containerEl: HTMLDivElement | undefined = $state();

  const html = $derived(renderMarkdown(editorState.currentText));

  $effect(() => {
    // Touch currentText to re-run when the document changes.
    void editorState.currentText;
    if (containerEl) {
      renderMermaidDiagrams(containerEl);
    }
  });
</script>

<div class="reading-view-wrapper flex-1 overflow-auto flex justify-center">
  <div bind:this={containerEl} class="prose-muesli reading-view">
    {@html html}
  </div>
</div>
