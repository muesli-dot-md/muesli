<script lang="ts">
  // Multica/Linear-style workspace + account switcher for the desktop sidebar —
  // the visual twin of the webapp's WorkspaceMenu.svelte. A selector face (square
  // letter avatar + active workspace name + chevron) opens a tight dropdown with:
  // the signed-in sync identity (avatar/initials + name + email) when logged in
  // (or a local-only line + a Sign in affordance when not), the registered
  // workspace list (a check marks the OPEN one), Open local folder… / Create
  // remote workspace…, a Settings entry, and a red Sign out. Selection/hover use
  // a NEUTRAL gray rounded background (hover:bg-base-200), never the accent.
  // Mirrors the webapp's tight metrics exactly: p-1 panel, h-8 rows, px-1.5 py-1
  // gap-2, size-4 icons.
  //
  // Adapted to the desktop's local-first model: "account" is the optional sync
  // identity (workspaces.identity, may be null); workspaces are local/cloud/cloned
  // folders (workspaces.list); the active one is whichever folder is open in the
  // tree. The add/clone/move/promote/create-remote flows live HERE (one dropdown,
  // no second picker): a cloud-only row clones on click, a cloned row grows a
  // "Move folder…" trailing action, a local-only row grows "Promote".
  import {
    Check,
    ChevronDown,
    Cloud,
    FolderOpen,
    FolderSymlink,
    LogOut,
    Settings,
  } from "lucide-svelte";
  import { colorFromId, initials as initialsFrom } from "$lib/presence";
  import { workspaces } from "$lib/workspaces.svelte";
  import { workspace } from "$lib/workspace.svelte";
  import { pickFolder, prepareCloneDir } from "$lib/tauri";
  import type { WorkspaceView } from "$lib/tauri";
  import CreateWorkspaceModal from "$lib/CreateWorkspaceModal.svelte";

  let {
    /** Bindable so AppShell can open the menu programmatically (command
     *  palette "Open / switch workspace", no-last-workspace fallback,
     *  onboarding's "local" fork). */
    open = $bindable(false),
    /** Opens the desktop settings view in the main panel. */
    onsettings,
    /** Opens AppShell's sign-in dialog (server shown + Change…) — the dialog
     *  is upstream of workspaces.login(); this menu never calls login directly. */
    onsignin,
  }: {
    open?: boolean;
    onsettings: () => void;
    onsignin: () => void;
  } = $props();

  // Refresh the list on every open, however the menu was opened (face click,
  // palette command, startup fallback).
  $effect(() => {
    if (open) void workspaces.refresh();
  });

  /** The active workspace is the one whose folder matches the open tree root. */
  const isActive = (view: WorkspaceView): boolean =>
    !!view.local_path && view.local_path === workspace.root;
  const activeName = $derived(workspaces.list.find(isActive)?.name ?? "Select workspace");
  const activeLetter = $derived(
    (activeName.trim().match(/[\p{L}\p{N}]/u)?.[0] ?? "?").toUpperCase(),
  );

  // Identity header: derived from the optional sync identity. Initials + a stable
  // color come from the shared presence helper (same derivation as the webapp /
  // presence stack), keyed on the user id so a person is one color everywhere.
  const identity = $derived.by(() => {
    const id = workspaces.identity;
    if (!id || (!id.email && !id.display_name)) return null;
    const name = id.display_name?.trim() || id.email?.trim() || "—";
    return {
      name,
      email: id.email,
      avatarUrl: id.avatar_url ?? null,
      initials: initialsFrom(name),
      color: colorFromId(id.id ?? name).color,
    };
  });
  // Whether sign-in even applies (open servers need no login).
  const openMode = $derived(workspaces.identity?.mode === "open");
  const loggedIn = $derived(workspaces.identity != null && !!workspaces.activeServer);

  // ── Create-remote entry (runs the shared setup wizard) ────────────────────
  let showCreateWizard = $state(false);

  function close() {
    open = false;
  }
  /** Run an action, then dismiss the menu. */
  function act(fn: () => void) {
    fn();
    close();
  }

  function onWindowPointerDown(e: PointerEvent) {
    if (!open) return;
    if (!(e.target as HTMLElement)?.closest?.("[data-workspace-menu]")) close();
  }
  function onWindowKeydown(e: KeyboardEvent) {
    if (open && e.key === "Escape") {
      e.preventDefault();
      close();
    }
  }

  async function selectWorkspace(view: WorkspaceView) {
    // Cloud-only clones on click: pick where the workspace's folder goes; the
    // folder itself is created for it, named after the workspace.
    if (view.state === "cloud-only") {
      if (workspaces.cloning) return;
      const parent = await pickFolder();
      if (!parent) return;
      close();
      const path = await prepareCloneDir(parent, view.name);
      // openWorkspaceView flips workspaces.cloning while the pull runs.
      await workspaces.openWorkspaceView(view, path);
      return;
    }
    close();
    await workspaces.openWorkspaceView(view);
  }

  async function move(view: WorkspaceView) {
    if (workspaces.busy || !view.local_path) return;
    const parent = await pickFolder();
    if (!parent) return;
    close();
    await workspaces.relocateWorkspace(view, parent);
  }

  async function promote(view: WorkspaceView) {
    if (workspaces.busy) return;
    const ok = confirm(
      `Promote "${view.name}" to a shared workspace on the server? ` +
        `Your local files stay where they are and start syncing.`,
    );
    if (!ok) return;
    close();
    await workspaces.promoteLocalToRemote(view);
  }

  async function openLocal() {
    close();
    const path = await pickFolder();
    if (!path) return;
    const name = path.split("/").filter(Boolean).pop() ?? path;
    await workspaces.openLocalFolder(path, name);
  }
</script>

<svelte:window onpointerdown={onWindowPointerDown} onkeydown={onWindowKeydown} />

{#snippet squareAvatar(letter: string, cls: string)}
  <span
    class="{cls} flex items-center justify-center rounded-md bg-base-300 text-xs font-medium text-base-content/80"
    aria-hidden="true"
  >
    {letter}
  </span>
{/snippet}

<div class="relative min-w-0 flex-1" data-workspace-menu>
  <!-- selector face: square letter avatar + workspace name + chevron, subtle
       neutral hover (no accent). -->
  <button
    class="arc-tap flex h-8 w-full items-center gap-2 rounded-lg px-1.5 text-left hover:bg-base-200"
    class:bg-base-200={open}
    aria-haspopup="menu"
    aria-expanded={open}
    onclick={() => (open = !open)}
  >
    {@render squareAvatar(activeLetter, "size-5 shrink-0")}
    <span class="min-w-0 flex-1 truncate text-sm font-medium">{activeName}</span>
    <ChevronDown
      size={14}
      class="shrink-0 opacity-50 transition-[rotate] duration-150 {open ? 'rotate-180' : ''}"
      aria-hidden="true"
    />
  </button>

  {#if open}
    <!-- dropdown: base-100 surface, soft overlay shadow over a hairline ring (not
         a hard border), concentric radius. Content-hugging (w-max) floored at
         min-w-56 and capped at max-w-72 so a long email truncates. Tight p-1 /
         h-8 rows / size-4 icons — identical metrics to the webapp. -->
    <!-- svelte-ignore a11y_no_noninteractive_element_to_interactive_role -->
    <div
      class="absolute top-9 left-0 z-50 w-max min-w-56 max-w-72 rounded-xl bg-base-100 p-1 shadow-[var(--shadow-overlay)] ring-1 ring-base-content/10"
      role="menu"
    >
      {#if identity}
        <!-- identity header: 32px avatar (photo or id-colored initials) + name +
             muted email, tight leading. -->
        <div class="flex items-center gap-2 px-1.5 py-1.5">
          {#if identity.avatarUrl}
            <img
              src={identity.avatarUrl}
              alt=""
              class="size-8 shrink-0 rounded-full object-cover"
            />
          {:else}
            <span
              class="flex size-8 shrink-0 items-center justify-center rounded-full text-sm font-medium text-white"
              style="background-color: {identity.color};"
              aria-hidden="true"
            >
              {identity.initials}
            </span>
          {/if}
          <div class="min-w-0 flex-1">
            <p class="truncate text-sm leading-tight font-medium">{identity.name}</p>
            {#if identity.email}
              <p class="truncate text-xs leading-tight opacity-60">{identity.email}</p>
            {/if}
          </div>
        </div>
        <div class="my-1 h-px bg-base-300/70" aria-hidden="true"></div>
      {/if}

      <!-- workspaces: sentence-case muted eyebrow. Each row is the switch
           target; cloned rows grow a trailing "Move folder…" action, local-only
           rows (when signed in) a "Promote" action. -->
      <p class="px-1.5 pt-0.5 pb-1 text-xs font-medium opacity-50">Workspaces</p>
      {#each workspaces.list as view (view.id)}
        <div class="flex items-center gap-0.5">
          <button
            class="arc-tap flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 py-1 text-left text-sm hover:bg-base-200"
            role="menuitem"
            onclick={() => selectWorkspace(view)}
          >
            {@render squareAvatar((view.name.trim()[0] ?? "?").toUpperCase(), "size-5 shrink-0")}
            <span class="min-w-0 flex-1 truncate">{view.name}</span>
            {#if view.state === "cloud-only"}
              {#if workspaces.cloning}
                <span class="loading loading-spinner loading-xs shrink-0"></span>
              {:else}
                <span class="shrink-0 text-[10px] opacity-40">not downloaded</span>
              {/if}
            {:else if isActive(view)}
              <Check size={16} class="shrink-0 text-primary" aria-hidden="true" />
            {/if}
          </button>

          {#if view.state === "cloned"}
            <button
              class="arc-tap flex size-8 shrink-0 items-center justify-center rounded-md opacity-60 hover:bg-base-200 hover:opacity-100 disabled:pointer-events-none disabled:opacity-30"
              title="Move folder…"
              disabled={workspaces.busy}
              onclick={() => move(view)}
            >
              <FolderSymlink size={15} aria-hidden="true" />
            </button>
          {/if}

          {#if view.state === "local-only" && loggedIn}
            <button
              class="arc-tap flex size-8 shrink-0 items-center justify-center rounded-md opacity-60 hover:bg-base-200 hover:opacity-100 disabled:pointer-events-none disabled:opacity-30"
              title="Promote to a shared workspace"
              disabled={workspaces.busy}
              onclick={() => promote(view)}
            >
              {#if workspaces.busy}
                <span class="loading loading-spinner loading-xs"></span>
              {:else}
                <Cloud size={15} aria-hidden="true" />
              {/if}
            </button>
          {/if}
        </div>
      {/each}

      <button
        class="arc-tap flex h-8 w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-sm opacity-80 hover:bg-base-200 hover:opacity-100"
        role="menuitem"
        onclick={openLocal}
      >
        <span class="flex size-5 shrink-0 items-center justify-center" aria-hidden="true">
          <FolderOpen size={16} />
        </span>
        <span class="min-w-0 flex-1 truncate">Open local folder…</span>
      </button>

      {#if loggedIn}
        <button
          class="arc-tap flex h-8 w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-sm opacity-80 hover:bg-base-200 hover:opacity-100 disabled:pointer-events-none disabled:opacity-40"
          role="menuitem"
          disabled={workspaces.busy}
          onclick={() =>
            act(() => {
              showCreateWizard = true;
            })}
        >
          <span class="flex size-5 shrink-0 items-center justify-center" aria-hidden="true">
            <Cloud size={16} />
          </span>
          <span class="min-w-0 flex-1 truncate">Create remote workspace…</span>
        </button>
      {/if}

      <div class="my-1 h-px bg-base-300/70" aria-hidden="true"></div>

      <!-- settings (opens the desktop settings view in the main panel; theme
           selection lives there — Preferences → Theme cards — by user choice,
           no quick toggle here) -->
      <button
        class="arc-tap flex h-8 w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-sm hover:bg-base-200"
        role="menuitem"
        onclick={() => act(onsettings)}
      >
        <span class="flex size-5 shrink-0 items-center justify-center" aria-hidden="true">
          <Settings size={16} class="opacity-70" />
        </span>
        <span class="min-w-0 flex-1 truncate">Settings</span>
      </button>

      <!-- auth: Sign out when signed in; Sign in when an auth-gated server has no
           identity. Open servers need no sign-in, so neither row shows. -->
      {#if identity}
        <div class="my-1 h-px bg-base-300/70" aria-hidden="true"></div>
        <button
          class="arc-tap flex h-8 w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-sm text-error hover:bg-error/10"
          role="menuitem"
          onclick={() => act(() => void workspaces.logout())}
        >
          <span class="flex size-5 shrink-0 items-center justify-center" aria-hidden="true">
            <LogOut size={16} />
          </span>
          <span class="min-w-0 flex-1 truncate">Sign out</span>
        </button>
      {:else if !openMode}
        <div class="my-1 h-px bg-base-300/70" aria-hidden="true"></div>
        <button
          class="arc-tap flex h-8 w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-sm hover:bg-base-200"
          role="menuitem"
          onclick={() => act(() => onsignin())}
        >
          <span class="flex size-5 shrink-0 items-center justify-center" aria-hidden="true">
            <LogOut size={16} class="opacity-70" />
          </span>
          <span class="min-w-0 flex-1 truncate">Sign in…</span>
        </button>
      {/if}
    </div>
  {/if}
</div>

{#if showCreateWizard}
  <CreateWorkspaceModal onclose={() => (showCreateWizard = false)} />
{/if}
