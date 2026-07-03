<script lang="ts">
  import ChevronsRight from "@lucide/svelte/icons/chevrons-right";
  import MessageCircle from "@lucide/svelte/icons/message-circle";
  import PencilLine from "@lucide/svelte/icons/pencil-line";
  import History from "@lucide/svelte/icons/history";
  import { type SidebarTab } from "./collabStore.svelte";
  import { t, type MessageKey } from "./i18n/index.svelte";
  import { useDocSession } from "./session.svelte";
  import CommentsPanel from "./CommentsPanel.svelte";
  import SuggestionsPanel from "./SuggestionsPanel.svelte";
  import HistoryPanel from "./HistoryPanel.svelte";

  const collab = useDocSession().store;

  // Label keys, not labels: t() runs in the template so language switches apply.
  const tabs: { id: SidebarTab; labelKey: MessageKey; icon: typeof MessageCircle }[] = [
    { id: "comments", labelKey: "sidebar.comments", icon: MessageCircle },
    { id: "suggestions", labelKey: "sidebar.suggestions", icon: PencilLine },
    { id: "history", labelKey: "sidebar.history", icon: History },
  ];

  function openTab(tab: SidebarTab) {
    collab.tab = tab;
    collab.sidebarOpen = true;
  }

  const badge = (tab: SidebarTab): number =>
    tab === "comments"
      ? collab.openThreads.length + collab.orphanedThreads.length
      : tab === "suggestions"
        ? collab.pendingGroups.length
        : 0;

  // History loads lazily when its tab is first opened (and refreshes on accepts
  // via the store).
  $effect(() => {
    if (collab.sidebarOpen && collab.tab === "history" && collab.history.length === 0) {
      void collab.loadHistory(true);
    }
  });
</script>

{#if collab.availability === "volatile"}
  <aside class="flex w-12 flex-col items-center border-l border-base-300 bg-base-100 py-3">
    <div
      class="tooltip tooltip-left"
      data-tip={t("sidebar.collabUnavailable")}
    >
      <span class="opacity-40" aria-label={t("sidebar.collabUnavailableLabel")}>
        <MessageCircle class="h-5 w-5" aria-hidden="true" />
      </span>
    </div>
  </aside>
{:else if !collab.sidebarOpen}
  <aside class="flex w-12 flex-col items-center gap-1 border-l border-base-300 bg-base-100 py-2">
    {#each tabs as tb (tb.id)}
      <button
        class="btn btn-ghost btn-sm indicator px-2"
        title={t(tb.labelKey)}
        onclick={() => openTab(tb.id)}
      >
        {#if badge(tb.id) > 0}
          <span class="badge indicator-item badge-primary badge-xs">{badge(tb.id)}</span>
        {/if}
        <tb.icon class="h-4 w-4" aria-hidden="true" />
      </button>
    {/each}
  </aside>
{:else}
  <aside class="flex w-80 shrink-0 flex-col border-l border-base-300 bg-base-100">
    <div class="flex items-center gap-1 border-b border-base-300 px-2 py-1.5">
      <div role="tablist" class="tabs tabs-border tabs-sm flex-1">
        {#each tabs as tb (tb.id)}
          <button
            role="tab"
            class="tab gap-1 {collab.tab === tb.id ? 'tab-active' : ''}"
            onclick={() => (collab.tab = tb.id)}
          >
            {t(tb.labelKey)}
            {#if badge(tb.id) > 0}
              <span class="badge badge-ghost badge-xs">{badge(tb.id)}</span>
            {/if}
          </button>
        {/each}
      </div>
      <button
        class="btn btn-ghost btn-xs"
        title={t("sidebar.collapse")}
        onclick={() => (collab.sidebarOpen = false)}
      >
        <ChevronsRight class="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
    <div class="min-h-0 flex-1 overflow-y-auto">
      {#if collab.tab === "comments"}
        <CommentsPanel />
      {:else if collab.tab === "suggestions"}
        <SuggestionsPanel />
      {:else}
        <HistoryPanel />
      {/if}
    </div>
  </aside>
{/if}
