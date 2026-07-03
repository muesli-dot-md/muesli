<script lang="ts">
  import { authorName, relativeTime } from "./collabStore.svelte";
  import { t } from "./i18n/index.svelte";
  import { useDocSession } from "./session.svelte";
  import type { HistoryEntry } from "./collabApi";

  const collab = useDocSession().store;

  const updates = (e: HistoryEntry) => e.last_seq - e.first_seq + 1;
</script>

<div class="flex flex-col gap-1.5 p-3">
  {#if collab.history.length === 0 && !collab.historyLoading}
    <p class="px-1 py-4 text-center text-sm opacity-50">{t("history.none")}</p>
  {/if}

  {#each collab.history as entry (entry.first_seq)}
    <button
      class="rounded-box border border-base-300 bg-base-100 px-3 py-2 text-left text-xs hover:bg-base-200"
      title={t("history.viewAtPoint")}
      onclick={() => collab.openSnapshot(entry)}
    >
      <span class="font-semibold">
        {entry.author?.kind === "agent" ? "✦ " : ""}{authorName(entry.author)}
      </span>
      <span class="opacity-50"> · {entry.origin} · {relativeTime(entry.created_at)}</span>
      <span class="opacity-50">
        · {t(updates(entry) === 1 ? "history.updates.one" : "history.updates.other", {
          count: updates(entry),
        })}</span
      >
      {#if entry.change_set_id}
        <span class="badge badge-ghost badge-xs ml-1" title={t("history.suggestionTitle")}>
          {t("history.suggestionBadge")}
        </span>
      {/if}
    </button>
  {/each}

  {#if !collab.historyDone && collab.history.length > 0}
    <button
      class="btn btn-ghost btn-xs mt-1"
      disabled={collab.historyLoading}
      onclick={() => collab.loadHistory()}
    >
      {collab.historyLoading ? t("common.loading") : t("common.loadMore")}
    </button>
  {/if}
</div>
