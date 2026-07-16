<script lang="ts">
  // Two-pane settings view rendered INSIDE the main content panel (where the
  // editor normally lives), mirroring the webapp's embedded SettingsPage. The
  // left file-tree sidebar stays put; only the main card swaps to this view.
  // A left grouped category sub-sidebar (small-caps GROUP headers + icon items)
  // and a right scrollable, card-based content column. Each section is its own
  // component under lib/settings/. Literal strings (desktop has no i18n).
  import { User, SlidersHorizontal, Bell, Info, Cable, X } from "lucide-svelte";
  import { syncStatus } from "$lib/sync/status.svelte";
  import { workspaces } from "$lib/workspaces.svelte";
  import ProfileSection from "$lib/settings/ProfileSection.svelte";
  import PreferencesSection from "$lib/settings/PreferencesSection.svelte";
  import NotificationsSection from "$lib/settings/NotificationsSection.svelte";
  import SyncSection from "$lib/settings/SyncSection.svelte";
  import AboutSection from "$lib/settings/AboutSection.svelte";

  type Section = "profile" | "preferences" | "notifications" | "about" | "sync";

  interface Props {
    /** Close the settings view and return to the editor/last document. */
    onclose: () => void;
    /** Section to land on when the panel mounts (defaults to Profile). Lets
     *  callers deep-link, e.g. a failed sign-in opens straight at Profile,
     *  the one Settings surface with the sign-in control and error text. */
    initialSection?: Section;
  }

  let { onclose, initialSection }: Props = $props();

  // App version. Mirrors package.json's "version"; bump together.
  const APP_VERSION = "0.1.0";

  // svelte-ignore state_referenced_locally -- initial value by design: the
  // panel mounts fresh on every open, and the user then navigates freely.
  let section = $state<Section>(initialSection ?? "profile");

  type NavItem = { id: Section; label: string; Icon: typeof User };
  // Mirrors the webapp's Multica two-level layout: a "My Account" group over a
  // workspace/connection group. Mapped to what the desktop actually has — no API
  // keys / Members / workspace-General (the desktop lacks that backend), so those
  // are omitted rather than stubbed.
  const groups: { title: string; items: NavItem[] }[] = [
    {
      title: "My Account",
      items: [
        { id: "profile", label: "Profile", Icon: User },
        { id: "preferences", label: "Appearance", Icon: SlidersHorizontal },
        { id: "notifications", label: "Notifications", Icon: Bell },
        { id: "about", label: "About", Icon: Info },
      ],
    },
    { title: "Connections", items: [{ id: "sync", label: "Sync", Icon: Cable }] },
  ];

  // The runtime sync status published by EditorPane's active session. `null`
  // means there is no live session (sync off, or no note open), which we render
  // as "disconnected" so the indicator always shows one of the three states.
  const statusLabel = $derived<"disconnected" | "connecting" | "connected">(
    syncStatus.status === "connected"
      ? "connected"
      : syncStatus.status === "connecting"
        ? "connecting"
        : "disconnected",
  );

  // Refresh the workspace list once when the panel mounts (the webapp refreshes
  // on open; here the panel only mounts when settings is shown).
  $effect(() => {
    workspaces.refresh();
  });
</script>

<!-- Embedded panel: fills the main content card. No modal backdrop / centered
     dialog chrome — Escape-to-close is handled by AppShell's keymap, and a
     close button in the header returns to the editor.

     `@container`: the narrow-layout switch below must key off the PANEL's own
     width, not the viewport — the file-tree sidebar shares the window, so a
     viewport breakpoint would keep the category rail open while the content
     column is already crushed. `@3xl` (48rem) is the webapp's `md:` threshold
     (SettingsPage.svelte) applied to the settings surface itself: the web page
     IS the viewport there, so both apps collapse the rail at the same surface
     width. -->
<div class="@container flex h-full min-h-0 flex-col">
  <!-- Header inside the card: title + close (back to the editor). -->
  <header class="flex h-14 shrink-0 items-center gap-3 px-5">
    <h1 class="text-xl font-semibold tracking-tight">Settings</h1>
    <button
      class="btn btn-circle btn-ghost ml-auto h-10 w-10 p-0"
      title="Close"
      aria-label="Close"
      onclick={onclose}
    >
      <X size={18} aria-hidden="true" />
    </button>
  </header>

  <div class="flex min-h-0 flex-1">
    <!-- left category sub-sidebar: small-caps group headers + icon items -->
    <aside
      class="hidden w-64 shrink-0 overflow-y-auto overscroll-contain px-3 pb-6 pt-1 @3xl:block"
    >
      <nav class="flex flex-col gap-5" aria-label="Settings">
        {#each groups as group (group.title)}
          <div class="flex flex-col gap-0.5">
            <p
              class="mb-1 px-3 text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]"
            >
              {group.title}
            </p>
            {#each group.items as item (item.id)}
              <button
                class="arc-tap flex min-h-10 w-full items-center gap-2.5 rounded-field px-3 py-2 text-left text-sm {section ===
                item.id
                  ? 'font-medium text-base-content'
                  : 'text-[var(--text-muted)] hover:bg-[var(--row-hover)] hover:text-base-content'}"
                style={section === item.id
                  ? "background: var(--lift); box-shadow: var(--shadow-lift);"
                  : ""}
                aria-current={section === item.id ? "page" : undefined}
                onclick={() => (section = item.id)}
              >
                <item.Icon
                  size={16}
                  class={section === item.id ? "" : "opacity-70"}
                  aria-hidden="true"
                />
                {item.label}
              </button>
            {/each}
          </div>
        {/each}
      </nav>
    </aside>

    <!-- narrow panel: groups collapse to a single top tab strip -->
    <main class="flex min-w-0 flex-1 flex-col overflow-hidden">
      <nav class="flex gap-1 overflow-x-auto px-4 pb-2 @3xl:hidden" aria-label="Settings">
        {#each groups.flatMap((g) => g.items) as item (item.id)}
          <button
            class="arc-tap flex min-h-10 shrink-0 items-center gap-2 whitespace-nowrap rounded-field px-3 py-2 text-sm {section ===
            item.id
              ? 'font-medium text-base-content'
              : 'text-[var(--text-muted)] hover:bg-[var(--row-hover)]'}"
            style={section === item.id
              ? "background: var(--lift); box-shadow: var(--shadow-lift);"
              : ""}
            onclick={() => (section = item.id)}
          >
            <item.Icon size={16} aria-hidden="true" />
            {item.label}
          </button>
        {/each}
      </nav>

      <div class="min-w-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-12 @3xl:px-8">
        <div class="mx-auto w-full max-w-2xl">
          {#if section === "profile"}
            <ProfileSection />
          {:else if section === "preferences"}
            <PreferencesSection />
          {:else if section === "notifications"}
            <NotificationsSection />
          {:else if section === "sync"}
            <SyncSection {statusLabel} onNavigateToProfile={() => (section = "profile")} />
          {:else}
            <AboutSection appVersion={APP_VERSION} {statusLabel} />
          {/if}
        </div>
      </div>
    </main>
  </div>
</div>
