<script lang="ts">
  // Ported from apps/web/src/HistoryPanel.svelte. Deltas:
  //   - explicit `store` prop instead of useDocSession().store
  //   - literal strings instead of t(...)
  import { onMount } from "svelte";
  import { authorName, relativeTime, type CollabStore } from "./collabStore.svelte";
  import type { HistoryEntry } from "./collabApi";

  const { store: collab }: { store: CollabStore } = $props();

  const updates = (e: HistoryEntry) => e.last_seq - e.first_seq + 1;

  // The history list is loaded lazily (the store doesn't poll it); pull the
  // first page when the tab mounts.
  onMount(() => {
    if (collab.history.length === 0) void collab.loadHistory(true);
  });
</script>

<div class="flex flex-col gap-1.5 p-3">
  {#if collab.history.length === 0 && !collab.historyLoading}
    <p class="px-1 py-4 text-center text-sm opacity-50">No history yet.</p>
  {/if}

  {#each collab.history as entry (entry.first_seq)}
    <button
      class="rounded-box border border-base-300 bg-base-100 px-3 py-2 text-left text-xs hover:bg-base-200 active:scale-[0.96]"
      title="View the document at this point in time"
      onclick={() => collab.openSnapshot(entry)}
    >
      <span class="font-semibold">
        {entry.author?.kind === "agent" ? "✦ " : ""}{authorName(entry.author)}
      </span>
      <span class="opacity-50"> · {entry.origin} · {relativeTime(entry.created_at)}</span>
      <span class="opacity-50">
        · {updates(entry) === 1 ? "1 update" : `${updates(entry)} updates`}</span
      >
      {#if entry.change_set_id}
        <span class="badge badge-ghost badge-xs ml-1" title="From an accepted suggestion">
          suggestion
        </span>
      {/if}
    </button>
  {/each}

  {#if !collab.historyDone && collab.history.length > 0}
    <button
      class="btn btn-ghost btn-xs mt-1 active:scale-[0.96]"
      disabled={collab.historyLoading}
      onclick={() => collab.loadHistory()}
    >
      {collab.historyLoading ? "Loading…" : "Load more"}
    </button>
  {/if}
</div>
