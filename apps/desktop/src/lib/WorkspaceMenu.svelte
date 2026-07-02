<script lang="ts">
  // Multica/Linear-style workspace + account switcher for the desktop sidebar —
  // the visual twin of the webapp's WorkspaceMenu.svelte. A selector face (square
  // letter avatar + active workspace name + chevron) opens a tight dropdown with:
  // the signed-in sync identity (avatar/initials + name + email) when logged in
  // (or a local-only line + a Sign in affordance when not), the registered
  // workspace list (a check marks the OPEN one), "Open workspace…", a Settings
  // entry, and a red Sign out. Selection/hover use a NEUTRAL gray rounded
  // background (hover:bg-base-200), never the accent. Mirrors the webapp's tight
  // metrics exactly: p-1 panel, h-8 rows, px-1.5 py-1 gap-2, size-4 icons.
  //
  // Adapted to the desktop's local-first model: "account" is the optional sync
  // identity (workspaces.identity, may be null); workspaces are local/cloud/cloned
  // folders (workspaces.list); the active one is whichever folder is open in the
  // tree. The heavy add/clone/promote/create-remote flows stay in WorkspacePicker,
  // surfaced here as "Open workspace…" which opens that picker.
  import { Check, ChevronDown, FolderOpen, LogOut, Settings } from "lucide-svelte";
  import { colorFromId, initials as initialsFrom } from "$lib/presence";
  import { workspaces } from "$lib/workspaces.svelte";
  import { workspace } from "$lib/workspace.svelte";
  import type { WorkspaceView } from "$lib/tauri";

  let {
    /** Opens the rich WorkspacePicker (open-local / clone / promote / create-remote). */
    onopenpicker,
    /** Opens the desktop settings view in the main panel. */
    onsettings,
    /** Opens AppShell's sign-in dialog (server shown + Change…) — the dialog
     *  is upstream of workspaces.login(); this menu never calls login directly. */
    onsignin,
  }: {
    onopenpicker: () => void;
    onsettings: () => void;
    onsignin: () => void;
  } = $props();

  let open = $state(false);

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
    close();
    // Cloud-only needs a folder to clone into — defer to the picker's flow.
    if (view.state === "cloud-only") {
      onopenpicker();
      return;
    }
    await workspaces.openWorkspaceView(view);
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
    onclick={() => {
      open = !open;
      if (open) workspaces.refresh();
    }}
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

      <!-- workspaces: sentence-case muted eyebrow. -->
      <p class="px-1.5 pt-0.5 pb-1 text-xs font-medium opacity-50">Workspaces</p>
      {#each workspaces.list as view (view.id)}
        <button
          class="arc-tap flex h-8 w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-sm hover:bg-base-200"
          role="menuitem"
          onclick={() => selectWorkspace(view)}
        >
          {@render squareAvatar((view.name.trim()[0] ?? "?").toUpperCase(), "size-5 shrink-0")}
          <span class="min-w-0 flex-1 truncate">{view.name}</span>
          {#if view.state === "cloud-only"}
            <span class="shrink-0 text-[10px] opacity-40">not downloaded</span>
          {:else if isActive(view)}
            <Check size={16} class="shrink-0 text-primary" aria-hidden="true" />
          {/if}
        </button>
      {/each}
      <button
        class="arc-tap flex h-8 w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-sm opacity-80 hover:bg-base-200 hover:opacity-100"
        role="menuitem"
        onclick={() => act(onopenpicker)}
      >
        <span class="flex size-5 shrink-0 items-center justify-center" aria-hidden="true">
          <FolderOpen size={16} />
        </span>
        <span class="min-w-0 flex-1 truncate">Open workspace…</span>
      </button>

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
