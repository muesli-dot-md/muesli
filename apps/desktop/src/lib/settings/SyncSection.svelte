<script lang="ts">
  // Settings → Sync (Connections group): the muesli-server connection — enable
  // toggle, server URL, device-code sign-in/out, and a live status indicator.
  // Ported from the SettingsModal "Sync" block into the two-pane card layout.
  import { settings } from "$lib/settings.svelte";
  import { displayUrl, normalizeServerInput } from "$lib/signInServer";
  import { isSignedIn } from "$lib/tauri";
  import { workspaces } from "$lib/workspaces.svelte";
  import SettingsCard from "./SettingsCard.svelte";
  import SettingRow from "./SettingRow.svelte";

  let {
    statusLabel,
    onNavigateToProfile,
  }: {
    statusLabel: "disconnected" | "connecting" | "connected";
    /** Switches SettingsPanel to the Profile section, so the "Go to Profile"
     *  hints below are an actual affordance rather than plain text. Optional
     *  so this section still renders standalone (e.g. in tests). */
    onNavigateToProfile?: () => void;
  } = $props();

  // Same predicate as ProfileSection (the primary account UI) — an OIDC
  // identity may expose only a "sub" claim (no email/display_name), and that
  // still counts as signed in. Kept in sync via the shared `isSignedIn` helper
  // so this informational row can't drift into claiming "Not signed in" while
  // sync is actually active.
  const signedIn = $derived(isSignedIn(workspaces.identity));
  const accountLabel = $derived(workspaces.identity?.email ?? workspaces.identity?.display_name);
</script>

<header class="mb-5">
  <h2 class="text-lg font-semibold tracking-tight">Sync</h2>
  <p class="mt-1 text-sm text-[var(--text-muted)]" style="text-wrap: pretty;">
    Connect to a muesli-server to sync this workspace's files in real time. Leave it off for
    local-only editing.
  </p>
</header>

<!-- Server: the muesli-server endpoint + enable toggle -->
<SettingsCard heading="Server">
  <SettingRow title="Enable sync" description="Mirror this workspace to the server as you edit.">
    {#snippet control()}
      <input
        type="checkbox"
        class="toggle toggle-sm toggle-primary"
        checked={settings.syncEnabled}
        onchange={(e) => settings.setSyncEnabled(e.currentTarget.checked)}
        aria-label="Enable sync"
      />
    {/snippet}
  </SettingRow>

  <SettingRow title="Server URL" stacked>
    {#snippet control()}
      <!-- Shows/accepts the plain-URL form (displayUrl); saves go through the
           same normalizer as the sign-in dialog, so the ws parts never
           surface here and un-normalized values never reach settings.
           Invalid input reverts the field to the stored value. -->
      <input
        type="text"
        class="input input-sm w-full border-base-300 bg-base-100"
        placeholder="https://muesli.example.com"
        value={displayUrl(settings.wsBase)}
        onchange={(e) => {
          const normalized = normalizeServerInput(e.currentTarget.value);
          if (normalized !== null) settings.setWsBase(normalized);
          else e.currentTarget.value = displayUrl(settings.wsBase);
        }}
        aria-label="Server URL"
      />
    {/snippet}
  </SettingRow>
</SettingsCard>

<!-- Connection: account summary + live status. Sign-in/out lives in Profile
     (the primary account flow) — this card only reports state and, when
     onNavigateToProfile is wired up, offers a one-click hop to Profile; it
     never duplicates the auth button itself. -->
<SettingsCard heading="Connection">
  {#if signedIn}
    <SettingRow
      title="Account"
      description={accountLabel
        ? `Signed in as ${accountLabel}. Manage sign-in from Profile.`
        : "Signed in. Manage sign-in from Profile."}
    >
      {#snippet control()}
        {#if onNavigateToProfile}
          <button class="btn btn-ghost btn-sm" onclick={onNavigateToProfile}>Go to Profile</button>
        {/if}
      {/snippet}
    </SettingRow>
  {:else if workspaces.identity?.mode === "open"}
    <SettingRow title="Account" description="Open server — no sign-in needed." />
  {:else}
    <SettingRow title="Not signed in" description="Sign in from Profile to sync this workspace.">
      {#snippet control()}
        {#if onNavigateToProfile}
          <button class="btn btn-ghost btn-sm" onclick={onNavigateToProfile}>Go to Profile</button>
        {/if}
      {/snippet}
    </SettingRow>
  {/if}

  <SettingRow title="Status">
    {#snippet control()}
      <span class="flex items-center gap-2 text-sm">
        <span
          class="inline-block h-2 w-2 rounded-full {statusLabel === 'connected'
            ? 'bg-success'
            : statusLabel === 'connecting'
              ? 'bg-warning'
              : 'bg-base-content/30'}"
        ></span>
        <span class="capitalize text-[var(--text-muted)]">{statusLabel}</span>
      </span>
    {/snippet}
  </SettingRow>
</SettingsCard>

{#if workspaces.error}
  <p class="mt-3 px-1 text-xs text-error">{workspaces.error}</p>
{/if}
