<script lang="ts">
  // Account-focused dropdown that anchors the top of the sidebar. The button
  // face is the app brand ("Muesli") — workspace SWITCHING lives in the
  // sidebar's workspaces list and the active workspace is named there, so
  // repeating it here would suggest this menu selects workspaces. It is
  // profile/settings/logout only: the signed-in user's identity header, a
  // Settings entry, and a red "Log out". Selection/hover use a NEUTRAL gray
  // rounded background (hover:bg-base-200), never the accent. Yjs-free
  // (identity.ts only); pure identity logic lives in workspaceMenu.ts.
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import LogOut from "@lucide/svelte/icons/log-out";
  import Settings from "@lucide/svelte/icons/settings";
  import { t } from "./i18n/index.svelte";
  import type { AuthInfo } from "./identity";
  import { gotoSettings } from "./route.svelte";
  import { menuIdentity } from "./workspaceMenu";

  let {
    auth,
    onsignout,
  }: {
    auth: AuthInfo;
    onsignout: () => void | Promise<void>;
  } = $props();

  let open = $state(false);

  const identity = $derived(auth.user ? menuIdentity(auth.user) : null);

  function close() {
    open = false;
  }
  /** Run an action, then dismiss the menu. */
  function act(fn: () => void) {
    fn();
    close();
  }

  // Dismiss on outside-click / Escape (the dropdown is a controlled popover, not
  // daisyUI's :focus-within variant, so menu actions can keep their own focus).
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

<div class="relative" data-workspace-menu>
  <!-- brand face: square "M" avatar + "Muesli" + chevron, subtle neutral hover
       (no accent). 40px tall hit area. Opens the account menu (workspace
       switching lives in the sidebar list below). -->
  <button
    class="arc-tap flex h-10 w-full items-center gap-2.5 rounded-lg px-2 text-left hover:bg-base-200"
    class:bg-base-200={open}
    aria-haspopup="menu"
    aria-expanded={open}
    onclick={() => (open = !open)}
  >
    {@render squareAvatar("M", "h-6 w-6 shrink-0")}
    <span class="min-w-0 flex-1 truncate text-sm font-medium" style="text-wrap: balance;">
      Muesli
    </span>
    <ChevronDown
      class="h-3.5 w-3.5 shrink-0 opacity-50 transition-[rotate] duration-150 {open
        ? 'rotate-180'
        : ''}"
      aria-hidden="true"
    />
  </button>

  {#if open}
    <!-- account dropdown: base-100 surface, soft overlay shadow over a hairline
         ring (not a hard border), concentric radius. Content-hugging (w-max) so
         the panel is only as wide as its widest row (usually the email), floored
         at min-w-56 and capped at max-w-72. Compact p-1, hairline ring, neutral
         gray hover. -->
    <!-- svelte-ignore a11y_no_noninteractive_element_to_interactive_role -->
    <div
      class="absolute top-11 left-0 z-30 w-max min-w-56 max-w-72 rounded-xl bg-base-100 p-1 shadow-[var(--shadow-overlay)] ring-1 ring-base-content/10"
      role="menu"
    >
      {#if identity}
        <!-- identity header: 32px avatar (photo or id-colored initials) + name +
             muted email, tight leading. Compact py-1.5 / px-1.5, aligned with the
             rows below. -->
        <div class="flex items-center gap-2 px-1.5 py-1.5">
          {#if identity.avatarUrl}
            <img
              src={identity.avatarUrl}
              alt=""
              class="h-8 w-8 shrink-0 rounded-full object-cover"
            />
          {:else}
            <span
              class="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-medium text-white"
              style="background-color: {identity.color};"
              aria-hidden="true"
            >
              {identity.initials}
            </span>
          {/if}
          <div class="min-w-0 flex-1">
            <p class="truncate text-sm leading-tight font-medium" style="text-wrap: balance;">
              {identity.name}
            </p>
            {#if identity.email}
              <p class="truncate text-xs leading-tight opacity-60">{identity.email}</p>
            {/if}
          </div>
        </div>
        <div class="my-1 h-px bg-base-300/70" aria-hidden="true"></div>
      {/if}

      <!-- settings (workspace switching lives in the sidebar list now) -->
      <button
        class="arc-tap flex h-8 w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-sm hover:bg-base-200"
        role="menuitem"
        onclick={() => act(() => gotoSettings())}
      >
        <span class="flex size-5 shrink-0 items-center justify-center" aria-hidden="true">
          <Settings class="size-4 opacity-70" />
        </span>
        <span class="min-w-0 flex-1 truncate">{t("common.settings")}</span>
      </button>

      {#if identity}
        <div class="my-1 h-px bg-base-300/70" aria-hidden="true"></div>
        <button
          class="arc-tap flex h-8 w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-sm text-error hover:bg-error/10"
          role="menuitem"
          onclick={() => act(() => void onsignout())}
        >
          <span class="flex size-5 shrink-0 items-center justify-center" aria-hidden="true">
            <LogOut class="size-4" />
          </span>
          <span class="min-w-0 flex-1 truncate">{t("account.signOut")}</span>
        </button>
      {/if}
    </div>
  {/if}
</div>
