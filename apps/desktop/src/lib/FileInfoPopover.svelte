<script lang="ts">
  // "File information" — a small centered panel showing path, type, size, and
  // modified/created times via the `stat_path` Tauri command. Works for both
  // files and folders (folder size = recursive total of its `.md` files).
  import { Info, FileText, Folder } from "lucide-svelte";
  import { statPath, type PathInfo } from "$lib/tauri";
  import { formatBytes, formatTimestamp } from "$lib/fileInfo";

  interface Props {
    path: string;
    name: string;
    onclose: () => void;
  }

  let { path, name, onclose }: Props = $props();

  let info = $state<PathInfo | null>(null);
  let error = $state("");

  $effect(() => {
    let cancelled = false;
    statPath(path)
      .then((i) => {
        if (!cancelled) info = i;
      })
      .catch((e) => {
        if (!cancelled) error = String(e);
      });
    return () => {
      cancelled = true;
    };
  });

  function handleBackdropClick(e: MouseEvent) {
    if (e.target === e.currentTarget) onclose();
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="fixed inset-0 z-50 flex items-start justify-center pt-[16vh] bg-black/40"
  onclick={handleBackdropClick}
  onkeydown={(e) => {
    if (e.key === "Escape") onclose();
  }}
>
  <div
    class="info-card w-full max-w-md overflow-hidden mx-4"
    style="background: var(--overlay); box-shadow: var(--shadow-overlay); border-radius: var(--radius-overlay, 0.875rem);"
    role="dialog"
    aria-modal="true"
    aria-label="Information for {name}"
  >
    <div class="flex items-center gap-2 border-b border-base-300 px-4 py-3">
      <Info size={16} class="shrink-0 opacity-60" />
      <span class="truncate text-sm font-medium">File information</span>
    </div>

    <div class="px-4 py-3">
      {#if error}
        <p class="text-sm text-error">{error}</p>
      {:else if !info}
        <div class="flex flex-col gap-2">
          {#each Array(4) as _, i (i)}
            <div class="skeleton h-4 w-full"></div>
          {/each}
        </div>
      {:else}
        <div class="mb-3 flex items-center gap-2">
          {#if info.isDir}
            <Folder size={18} class="shrink-0 text-base-content/55" />
          {:else}
            <FileText size={18} class="shrink-0 text-primary" />
          {/if}
          <span class="truncate text-sm font-medium">{info.name}</span>
        </div>
        <dl class="grid grid-cols-[6rem_1fr] gap-x-3 gap-y-1.5 text-xs">
          <dt class="text-base-content/50">Type</dt>
          <dd class="text-base-content">{info.isDir ? "Folder" : "Markdown file"}</dd>

          {#if info.isDir && info.childCount != null}
            <dt class="text-base-content/50">Notes</dt>
            <dd class="text-base-content">{info.childCount}</dd>
          {/if}

          <dt class="text-base-content/50">Size</dt>
          <dd class="text-base-content">{formatBytes(info.size)}</dd>

          <dt class="text-base-content/50">Modified</dt>
          <dd class="text-base-content">{formatTimestamp(info.modifiedMs)}</dd>

          <dt class="text-base-content/50">Created</dt>
          <dd class="text-base-content">{formatTimestamp(info.createdMs)}</dd>

          <dt class="text-base-content/50">Path</dt>
          <dd class="break-all text-base-content/70">{info.path}</dd>
        </dl>
      {/if}
    </div>

    <div class="flex justify-end border-t border-base-300 px-4 py-2.5">
      <button class="btn btn-sm btn-ghost" onclick={onclose}>Close</button>
    </div>
  </div>
</div>

<style>
  .info-card {
    animation: info-pop 130ms cubic-bezier(0.16, 1, 0.3, 1);
  }
  @keyframes info-pop {
    from {
      opacity: 0;
      transform: translateY(-6px) scale(0.985);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .info-card {
      animation: none;
    }
  }
</style>
