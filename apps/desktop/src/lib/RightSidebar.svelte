<script lang="ts">
  import { ListTree, MessageCircle, PencilLine, History } from "lucide-svelte";
  import OutlineRail from "$lib/OutlineRail.svelte";
  import { sidebars } from "$lib/sidebars.svelte";
  import { docCollab } from "$lib/collab/docCollab.svelte";
  import CommentsPanel from "$lib/collab/CommentsPanel.svelte";
  import SuggestionsPanel from "$lib/collab/SuggestionsPanel.svelte";
  import HistoryPanel from "$lib/collab/HistoryPanel.svelte";

  // Shared empty-state copy for local-only docs (Global Constraints).
  const COLLAB_EMPTY =
    "Comments, suggestions and history become available once this workspace is shared.";

  type TabId = "outline" | "comments" | "suggestions" | "history";

  const tabs: { id: TabId; label: string; icon: typeof ListTree }[] = [
    { id: "outline", label: "Outline", icon: ListTree },
    { id: "comments", label: "Comments", icon: MessageCircle },
    { id: "suggestions", label: "Suggestions", icon: PencilLine },
    { id: "history", label: "History", icon: History },
  ];

  let active = $state<TabId>("outline");

  // Follow the collab store's `tab` when the editor flow switches it (e.g. after
  // creating a comment → "comments", or a suggestion → "suggestions"). Tracked
  // off store identity so opening a synced doc doesn't yank the tab on mount;
  // only a CHANGE after the baseline switches the visible tab.
  let tabStore: unknown = null;
  let lastStoreTab: string | null = null;
  $effect(() => {
    const store = docCollab.store;
    const storeTab = store ? store.tab : null;
    if (store !== tabStore) {
      tabStore = store;
      lastStoreTab = storeTab;
      return;
    }
    if (storeTab && storeTab !== lastStoreTab) {
      lastStoreTab = storeTab;
      active = storeTab;
    }
  });

  const activeTab = $derived(tabs.find((t) => t.id === active)!);
</script>

<!-- Floating card mirroring the editor card: base-100 surface, rounded, inset on
     top/right/bottom (the left gap comes from the editor card's right margin). -->
<aside
  class="shrink-0 flex flex-col overflow-hidden"
  style="width: {sidebars.right}px; background: var(--color-base-100); border-radius: var(--radius-box); box-shadow: var(--shadow-card); margin: 0 var(--inset-card) var(--inset-card) 0;"
>
  <!-- Tab header: compact icon tabs, label shown only on the active tab -->
  <div role="tablist" class="flex items-center gap-1 px-2 py-2 shrink-0">
    {#each tabs as t (t.id)}
      {@const Icon = t.icon}
      <button
        role="tab"
        aria-selected={active === t.id}
        class="flex items-center gap-1 px-2 py-1 rounded-field text-xs font-medium whitespace-nowrap transition-colors"
        style={active === t.id
          ? "background: var(--lift); color: var(--color-base-content); box-shadow: var(--shadow-lift);"
          : "color: var(--text-muted);"}
        onclick={() => (active = t.id)}
        title={t.label}
      >
        <Icon size={15} class="shrink-0" />
        {#if active === t.id}<span>{t.label}</span>{/if}
      </button>
    {/each}
  </div>

  <!-- Body -->
  <div class="flex-1 overflow-y-auto">
    {#if active === "outline"}
      <OutlineRail />
    {:else if docCollab.isRemote && docCollab.store}
      {#if active === "comments"}
        <CommentsPanel store={docCollab.store} />
      {:else if active === "suggestions"}
        <SuggestionsPanel store={docCollab.store} />
      {:else if active === "history"}
        <HistoryPanel store={docCollab.store} />
      {/if}
    {:else}
      {@const Icon = activeTab.icon}
      <div class="flex flex-col items-center justify-center text-center h-full px-6 py-12 gap-2">
        <Icon size={24} class="text-base-content/40" />
        <p class="text-sm font-medium text-base-content/70">{activeTab.label}</p>
        <p class="text-xs text-base-content/45 leading-relaxed">
          {COLLAB_EMPTY}
        </p>
      </div>
    {/if}
  </div>
</aside>
