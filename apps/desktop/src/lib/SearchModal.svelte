<script lang="ts">
  // ⌘K search palette — centered Spotlight/Drive-style overlay over the local
  // workspace. Mirrors the webapp's SearchPalette UX (grouped results with folder
  // breadcrumbs, live debounced search, keyboard nav, empty/loading states) but
  // keeps the desktop's LOCAL search backend (`search_workspace`) — local-first,
  // no server round-trip.
  import { Search, FileText, Folder, CornerDownLeft } from "lucide-svelte";
  import { workspace } from "$lib/workspace.svelte";
  import { tabs } from "$lib/tabs.svelte";
  import { searchWorkspace, type SearchHit } from "$lib/tauri";
  import { groupHits, flattenGroups, highlightSplit } from "$lib/searchGrouping";

  interface Props {
    open: boolean;
    onclose: () => void;
  }

  let { open, onclose }: Props = $props();

  let query = $state("");
  let results = $state<SearchHit[]>([]);
  /** The query the current `results` answer — "" until the first response lands. */
  let answered = $state("");
  let loading = $state(false);
  let searched = $state(false);
  let highlightIdx = $state(0);
  let inputEl: HTMLInputElement | undefined = $state();
  let listEl: HTMLDivElement | undefined = $state();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reqId = 0;

  // Grouped + flattened views derived from the ranked backend hits.
  const groups = $derived(groupHits(results));
  const flat = $derived(flattenGroups(groups));

  $effect(() => {
    if (open) {
      query = "";
      results = [];
      answered = "";
      searched = false;
      loading = false;
      highlightIdx = 0;
      requestAnimationFrame(() => inputEl?.focus());
    } else {
      if (timer) clearTimeout(timer);
      reqId++; // cancel any in-flight request on close
    }
  });

  $effect(() => {
    if (highlightIdx >= flat.length) highlightIdx = Math.max(0, flat.length - 1);
  });

  function runSearch() {
    if (timer) clearTimeout(timer);
    const q = query.trim();
    if (!q) {
      reqId++; // supersede any pending request
      results = [];
      answered = "";
      searched = false;
      loading = false;
      return;
    }
    loading = true;
    const myId = ++reqId;
    timer = setTimeout(async () => {
      if (!workspace.root) return;
      try {
        const r = await searchWorkspace(workspace.root, q);
        if (myId !== reqId) return; // a newer query superseded this one
        results = r;
        answered = q;
        highlightIdx = 0;
      } catch (e) {
        console.error("[search] failed", e);
        if (myId === reqId) {
          results = [];
          answered = q;
        }
      } finally {
        if (myId === reqId) {
          loading = false;
          searched = true;
        }
      }
    }, 160);
  }

  function openHit(hit: SearchHit) {
    tabs.open(hit.path, hit.name);
    onclose();
  }

  function moveSelection(delta: number) {
    if (flat.length === 0) return;
    highlightIdx = (highlightIdx + delta + flat.length) % flat.length;
    listEl
      ?.querySelector(`[data-result-index="${highlightIdx}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      onclose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      moveSelection(1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      moveSelection(-1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const h = flat[highlightIdx];
      if (h) openHit(h);
    }
  }

  function handleBackdropClick(e: MouseEvent) {
    if (e.target === e.currentTarget) onclose();
  }
</script>

{#snippet highlighted(text: string)}
  {@const h = highlightSplit(text, answered)}
  {#if h}
    {h.pre}<mark class="rounded-sm bg-primary/20 font-semibold text-inherit">{h.hit}</mark>{h.post}
  {:else}
    {text}
  {/if}
{/snippet}

{#if open}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="palette-backdrop fixed inset-0 z-50 flex justify-center bg-black/40 pt-[12vh]"
    onclick={handleBackdropClick}
    onkeydown={handleKeydown}
  >
    <div
      class="palette-card flex h-fit max-h-[70vh] w-full max-w-2xl flex-col overflow-hidden mx-4"
      style="background: var(--overlay); box-shadow: var(--shadow-overlay); border-radius: var(--radius-overlay, 0.875rem);"
      role="dialog"
      aria-label="Search files & content"
    >
      <!-- Search input row -->
      <label class="flex items-center gap-3 border-b border-base-300 px-4 py-3">
        <Search size={18} class="shrink-0 opacity-50" />
        <input
          bind:this={inputEl}
          bind:value={query}
          oninput={runSearch}
          type="text"
          placeholder="Search files & content…"
          class="grow bg-transparent text-base outline-none placeholder:opacity-50"
          onkeydown={handleKeydown}
        />
        {#if loading && answered}
          <span class="loading loading-spinner loading-xs opacity-40"></span>
        {/if}
        <kbd class="kbd kbd-sm opacity-60">Esc</kbd>
      </label>

      <!-- Results -->
      <div bind:this={listEl} class="min-h-0 overflow-y-auto overscroll-contain py-1">
        {#if loading && results.length === 0}
          <!-- Shimmer only while there is nothing to show; stale results stay on
               screen during a refresh so typing never flickers. -->
          <div class="flex flex-col gap-2 px-5 py-4">
            {#each Array(4) as _, i (i)}
              <div class="skeleton h-8 w-full"></div>
            {/each}
          </div>
        {:else if searched && results.length === 0}
          <p class="px-5 py-6 text-sm text-base-content/60">No matches for "{answered}"</p>
        {:else if results.length === 0}
          <p class="px-5 py-6 text-sm text-base-content/50">
            Type to search filenames and contents.
          </p>
        {:else}
          {#each groups as g (g.key)}
            <div
              class="flex items-center gap-1.5 px-5 pt-3 pb-1 text-xs font-medium uppercase tracking-wide opacity-50"
            >
              <Folder size={13} class="shrink-0" />
              {#if g.crumb.length === 0}
                My documents
              {:else}
                My documents{#each g.crumb as part, i (i)}
                  › {part}{/each}
              {/if}
            </div>
            {#each g.items as hit (hit.path)}
              {@const i = flat.indexOf(hit)}
              <button
                class="search-row flex w-full items-start gap-3 px-5 py-2 text-left {i ===
                highlightIdx
                  ? 'bg-primary/10'
                  : 'hover:bg-base-200/60'}"
                data-result-index={i}
                onmouseenter={() => (highlightIdx = i)}
                onclick={() => openHit(hit)}
              >
                <FileText size={16} class="mt-0.5 shrink-0 text-primary" />
                <span class="min-w-0 flex-1">
                  <span class="flex items-baseline gap-2">
                    <span class="truncate text-sm font-medium text-base-content">
                      {@render highlighted(hit.name)}
                    </span>
                    {#if hit.matches > 0}
                      <span class="badge badge-ghost badge-xs ml-auto shrink-0">{hit.matches}</span>
                    {/if}
                  </span>
                  {#if hit.snippet}
                    <span class="block truncate text-xs opacity-60">
                      {@render highlighted(hit.snippet)}
                    </span>
                  {/if}
                  <span class="block truncate text-xs opacity-40">{hit.display}</span>
                </span>
                {#if i === highlightIdx}
                  <CornerDownLeft size={13} class="mt-1 shrink-0 opacity-40" />
                {/if}
              </button>
            {/each}
          {/each}
          <div class="h-2"></div>
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  /* Soft enter — fade the scrim, lift + fade the card (no `transition: all`). */
  .palette-backdrop {
    animation: palette-fade 120ms ease-out;
  }
  .palette-card {
    animation: palette-rise 140ms cubic-bezier(0.16, 1, 0.3, 1);
  }
  @keyframes palette-fade {
    from {
      opacity: 0;
    }
  }
  @keyframes palette-rise {
    from {
      opacity: 0;
      transform: translateY(-6px) scale(0.985);
    }
  }
  /* ≥40px hit area + subtle scale-on-press for each result row. */
  .search-row {
    min-height: 40px;
    transition:
      background-color 120ms ease,
      transform 80ms ease;
  }
  .search-row:active {
    transform: scale(0.992);
  }
  @media (prefers-reduced-motion: reduce) {
    .palette-backdrop,
    .palette-card {
      animation: none;
    }
    .search-row {
      transition: none;
    }
    .search-row:active {
      transform: none;
    }
  }
</style>
