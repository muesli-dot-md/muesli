<script lang="ts">
  // Outline rail (editor redesign §Layout): document headings parsed from the
  // live ytext (debounced), indented by level. Click scrolls the editor to the
  // heading (centered); the current section highlights from the editor's
  // scroll position. Collapsible to a thin strip; renders nothing while the
  // document has no headings (Docs behavior).
  import ChevronsLeft from "@lucide/svelte/icons/chevrons-left";
  import ListTree from "@lucide/svelte/icons/list-tree";
  import { EditorSelection } from "@codemirror/state";
  import { EditorView } from "@codemirror/view";
  import { onMount } from "svelte";
  import { t } from "./i18n/index.svelte";
  import { parseOutline, type OutlineItem } from "@muesli/editor-core/mdCommands";
  import { useDocSession } from "./session.svelte";

  const session = useDocSession();
  const { ytext } = session;

  let items: OutlineItem[] = $state.raw([]);
  let collapsed = $state(false);
  let activeIndex = $state(-1);

  let debounce: ReturnType<typeof setTimeout> | undefined;

  onMount(() => {
    items = parseOutline(ytext.toString());
    const observer = () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => {
        items = parseOutline(ytext.toString());
        updateActive();
      }, 300);
    };
    ytext.observe(observer);
    return () => {
      ytext.unobserve(observer);
      clearTimeout(debounce);
    };
  });

  function updateActive() {
    const view = session.editorView;
    if (!view || items.length === 0) {
      activeIndex = items.length > 0 ? 0 : -1;
      return;
    }
    // the heading at/above the first visible line is the current section
    // (heights are relative to the document top, so strip the scroller padding)
    const topPos = view.lineBlockAtHeight(view.scrollDOM.scrollTop - view.documentPadding.top).from;
    let idx = 0;
    for (let i = 0; i < items.length; i++) {
      if (items[i].from <= topPos + 1) idx = i;
      else break;
    }
    activeIndex = idx;
  }

  // (Re)attach the scroll listener whenever the editor view mounts.
  $effect(() => {
    const view = session.editorView;
    if (!view) return;
    updateActive();
    const onScroll = () => updateActive();
    view.scrollDOM.addEventListener("scroll", onScroll, { passive: true });
    return () => view.scrollDOM.removeEventListener("scroll", onScroll);
  });

  function jumpTo(item: OutlineItem) {
    const view = session.editorView;
    if (!view) return;
    const pos = Math.min(item.from, view.state.doc.length);
    view.dispatch({
      selection: EditorSelection.cursor(pos),
      effects: EditorView.scrollIntoView(pos, { y: "center" }),
    });
    view.focus();
  }
</script>

{#if items.length > 0}
  {#if collapsed}
    <aside class="flex w-10 shrink-0 flex-col items-center pt-3">
      <button
        class="btn btn-ghost btn-sm btn-square"
        title={t("outline.expand")}
        onclick={() => (collapsed = false)}
      >
        <ListTree class="h-4 w-4" aria-hidden="true" />
      </button>
    </aside>
  {:else}
    <aside class="flex w-56 shrink-0 flex-col overflow-hidden pt-3 pl-2">
      <div class="flex items-center justify-between pr-1 pl-3">
        <span class="text-xs font-semibold tracking-wide uppercase opacity-50">
          {t("outline.title")}
        </span>
        <button
          class="btn btn-ghost btn-xs btn-square"
          title={t("outline.collapse")}
          onclick={() => (collapsed = true)}
        >
          <ChevronsLeft class="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </div>
      <nav class="mt-1 min-h-0 flex-1 overflow-y-auto pb-4" aria-label={t("outline.title")}>
        <ul class="flex flex-col">
          {#each items as item, i (item.from + item.text)}
            <li>
              <button
                class="block w-full truncate rounded-r-md border-l-2 px-3 py-1 text-left text-sm transition-colors
                  {i === activeIndex
                  ? 'border-primary font-medium text-primary'
                  : 'border-transparent opacity-70 hover:bg-base-300/50 hover:opacity-100'}"
                style:padding-left="{0.75 + (item.level - 1) * 0.65}rem"
                title={item.text}
                onclick={() => jumpTo(item)}
              >
                {item.text}
              </button>
            </li>
          {/each}
        </ul>
      </nav>
    </aside>
  {/if}
{/if}
