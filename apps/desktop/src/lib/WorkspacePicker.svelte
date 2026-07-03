<script lang="ts">
  import { Check, Cloud, FolderOpen, HardDrive } from "lucide-svelte";
  import { workspaces } from "$lib/workspaces.svelte";
  import { workspace } from "$lib/workspace.svelte";
  import { pickFolder } from "$lib/tauri";
  import type { WorkspaceView } from "$lib/tauri";
  import CreateWorkspaceModal from "$lib/CreateWorkspaceModal.svelte";

  // `triggerless`: render only the dropdown (no button face). Used when the new
  // WorkspaceMenu provides the selector face and opens this picker programmatically
  // for the rich add/clone/promote/create-remote flows.
  let { open = $bindable(false), triggerless = false } = $props();

  /** The workspace currently open is the one whose folder matches the tree root. */
  const isActive = (view: WorkspaceView): boolean =>
    !!view.local_path && view.local_path === workspace.root;

  const activeName = $derived(
    workspaces.list.find(isActive)?.name ?? "Select workspace",
  );

  async function choose(view: WorkspaceView) {
    if (view.state === "cloud-only") {
      const path = await pickFolder();
      if (!path) return;
      open = false;
      // openWorkspaceView flips workspaces.cloning while the pull runs.
      await workspaces.openWorkspaceView(view, path);
    } else {
      open = false;
      await workspaces.openWorkspaceView(view);
    }
  }

  async function openLocal() {
    open = false;
    const path = await pickFolder();
    if (!path) return;
    const name = path.split("/").filter(Boolean).pop() ?? path;
    await workspaces.openLocalFolder(path, name);
  }

  // ── Create-remote entry (runs the shared setup wizard) ────────────────────
  let showCreateWizard = $state(false);

  const loggedIn = $derived(workspaces.identity != null && !!workspaces.activeServer);

  async function promote(view: WorkspaceView) {
    if (workspaces.busy) return;
    const ok = confirm(
      `Promote "${view.name}" to a shared workspace on the server? ` +
        `Your local files stay where they are and start syncing.`,
    );
    if (!ok) return;
    open = false;
    await workspaces.promoteLocalToRemote(view);
  }
</script>

<div class="relative">
  {#if !triggerless}
    <button
      class="btn btn-ghost btn-sm gap-1.5 max-w-full"
      onclick={() => { open = !open; if (open) workspaces.refresh(); }}
    >
      <span class="truncate">{activeName}</span>
    </button>
  {/if}

  {#if open}
    <div
      class="absolute left-0 top-full mt-1 z-50 w-64 flex flex-col gap-0.5 p-1.5"
      style="background: var(--overlay); box-shadow: var(--shadow-overlay); border-radius: var(--radius-overlay, 0.875rem);"
    >
      {#each workspaces.list as view (view.id)}
        <div class="flex items-center gap-1">
          <button
            class="flex items-center gap-2 px-2 py-1.5 rounded-selector text-sm hover:bg-base-200 text-left flex-1 transition-transform active:scale-[0.96]"
            onclick={() => choose(view)}
          >
            <!-- Leading icon = where the workspace lives (cloud vs local disk). -->
            {#if view.state === "cloud-only"}
              <Cloud size={15} class="shrink-0 text-base-content/50" />
            {:else}
              <HardDrive size={15} class="shrink-0 text-base-content/50" />
            {/if}
            <span class="truncate flex-1">{view.name}</span>
            <!-- Trailing: "not downloaded" for cloud-only; a check marks the
                 workspace that's currently OPEN (not merely downloaded). -->
            {#if view.state === "cloud-only"}
              {#if workspaces.cloning}
                <span class="loading loading-spinner loading-xs shrink-0"></span>
              {:else}
                <span class="shrink-0 text-[10px] text-base-content/40">not downloaded</span>
              {/if}
            {:else if isActive(view)}
              <Check size={15} class="shrink-0 text-success" />
            {/if}
          </button>

          {#if view.state === "local-only" && loggedIn}
            <button
              class="shrink-0 px-1.5 py-1.5 rounded-selector text-[11px] text-base-content/60 hover:text-base-content hover:bg-base-200 transition-transform active:scale-[0.96] disabled:opacity-40 disabled:pointer-events-none"
              title="Promote to a shared workspace"
              disabled={workspaces.busy}
              onclick={() => promote(view)}
            >
              {#if workspaces.busy}
                <span class="loading loading-spinner loading-xs"></span>
              {:else}
                <Cloud size={14} class="text-base-content/50" />
              {/if}
            </button>
          {/if}
        </div>
      {/each}

      <div class="h-px bg-base-300/70 my-1"></div>

      <button
        class="flex items-center gap-2 px-2 py-1.5 rounded-selector text-sm hover:bg-base-200 text-left"
        onclick={openLocal}
      >
        <FolderOpen size={15} class="shrink-0 text-base-content/50" />
        <span>Open local folder…</span>
      </button>

      {#if loggedIn}
        <button
          class="flex items-center gap-2 px-2 py-1.5 rounded-selector text-sm hover:bg-base-200 text-left transition-transform active:scale-[0.96] disabled:opacity-40 disabled:pointer-events-none"
          disabled={workspaces.busy}
          onclick={() => { open = false; showCreateWizard = true; }}
        >
          <Cloud size={15} class="shrink-0 text-base-content/50" />
          <span>Create remote workspace…</span>
        </button>
      {/if}
    </div>
  {/if}
</div>

{#if showCreateWizard}
  <CreateWorkspaceModal onclose={() => (showCreateWizard = false)} />
{/if}
