<script lang="ts">
  import { Wifi, WifiOff, RefreshCw } from "lucide-svelte";
  import { syncStatus } from "$lib/sync/status.svelte";
  import { editorState } from "$lib/editorState.svelte";
  import { daemon } from "$lib/sync/daemon.svelte";
  import { presence } from "$lib/sync/presence.svelte";

  const text = $derived(editorState.currentText);
  const wordCount = $derived(text.trim() ? text.trim().split(/\s+/).filter(Boolean).length : 0);
  const charCount = $derived(text.length);

  const label = $derived(
    syncStatus.status === "connected"
      ? "Synced"
      : syncStatus.status === "connecting"
        ? "Connecting…"
        : syncStatus.status === "disconnected"
          ? "Offline"
          : null,
  );
</script>

<div class="flex gap-3 text-xs text-base-content/60 justify-end items-center">
  {#if text.length > 0}
    <span class="tabular-nums">{wordCount} words · {charCount} chars</span>
  {/if}
  {#if syncStatus.status !== null}
    <span class="flex items-center gap-1" title={label ?? ""}>
      {#if syncStatus.status === "connected"}
        <Wifi size={12} class="text-success" />
      {:else if syncStatus.status === "connecting"}
        <RefreshCw size={12} class="text-warning animate-spin" />
      {:else}
        <WifiOff size={12} class="text-base-content/40" />
      {/if}
      {label}
    </span>
  {/if}
  {#if daemon.status?.running}
    <span class="text-xs text-base-content/60">
      Syncing {daemon.status.files} file{daemon.status.files === 1 ? "" : "s"}
      {#if daemon.status.last_activity}
        · {daemon.status.last_activity}{/if}
    </span>
    {#if presence.count > 0}
      <!-- The PresenceStack (header) is the primary affordance now; this stays as
           a terse secondary count of *other* people (self already excluded). -->
      <span class="text-xs text-base-content/60">{presence.count} editing</span>
    {/if}
  {:else if daemon.status?.error}
    <span class="text-xs text-error">Sync error: {daemon.status.error}</span>
  {/if}
</div>
