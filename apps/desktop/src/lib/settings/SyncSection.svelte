<script lang="ts">
  // Settings → Sync (Connections group): the muesli-server connection — enable
  // toggle, server URL, device-code sign-in/out, and a live status indicator.
  // Ported from the SettingsModal "Sync" block into the two-pane card layout.
  import { settings } from '$lib/settings.svelte';
  import { displayUrl, normalizeServerInput } from '$lib/signInServer';
  import { workspaces } from '$lib/workspaces.svelte';
  import SettingsCard from './SettingsCard.svelte';
  import SettingRow from './SettingRow.svelte';

  let {
    statusLabel,
  }: {
    statusLabel: 'disconnected' | 'connecting' | 'connected';
  } = $props();
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

<!-- Connection: account + live status, the connected-storage card treatment -->
<SettingsCard heading="Connection">
  <SettingRow title="Account">
    {#snippet control()}
      {#if workspaces.identity?.email || workspaces.identity?.display_name}
        <span class="max-w-[16rem] truncate text-sm text-[var(--text-muted)]">
          {workspaces.identity.email ?? workspaces.identity.display_name}
        </span>
        <button class="btn btn-ghost btn-sm" onclick={() => workspaces.logout()}>Sign out</button>
      {:else if workspaces.identity?.mode === 'open'}
        <span class="text-sm text-[var(--text-muted)]">Open server — no sign-in needed</span>
      {:else}
        <button class="btn btn-primary btn-sm" onclick={() => workspaces.login()}>Sign in…</button>
      {/if}
    {/snippet}
  </SettingRow>

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
