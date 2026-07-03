<script lang="ts">
  import { EditorView } from "@codemirror/view";
  import { parseOutline } from "@muesli/editor-core/mdCommands";
  import { editorState } from "$lib/editorState.svelte";

  const items = $derived(parseOutline(editorState.currentText));

  function goTo(from: number) {
    const view = editorState.activeView;
    if (!view) return;
    const pos = Math.min(from, view.state.doc.length);
    view.dispatch({
      selection: { anchor: pos },
      effects: EditorView.scrollIntoView(pos, { y: "start" }),
    });
    view.focus();
  }
</script>

<div class="py-1">
  {#if items.length === 0}
    <p class="px-3 py-2 text-xs text-base-content/40 italic">No headings</p>
  {:else}
    {#each items as item}
      <button
        class="w-full text-left text-xs text-base-content/60 hover:text-base-content hover:bg-base-content/5 px-3 py-0.5 rounded transition-colors truncate"
        style="padding-left: {8 + (item.level - 1) * 12}px"
        onclick={() => goTo(item.from)}
        title={item.text}
      >
        {item.text}
      </button>
    {/each}
  {/if}
</div>
