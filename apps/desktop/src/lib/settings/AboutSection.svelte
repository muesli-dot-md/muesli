<script lang="ts">
  // Settings → About: app metadata plus the server connection. The server-URL
  // field lives here since the Sync page was removed (sync is always on while
  // signed in to a server-linked workspace, so there is nothing else to
  // configure). A change takes effect immediately, not on next open: the
  // refresh() below re-resolves identity (the sync gate + presence identity)
  // against the new server, and a live legacy editor session remounts at once
  // because EditorPane's mount effect reads settings.wsBase.
  import { settings } from "$lib/settings.svelte";
  import { workspaces } from "$lib/workspaces.svelte";
  import { displayUrl, normalizeServerInput } from "$lib/signInServer";
  import SettingsCard from "./SettingsCard.svelte";
  import SettingRow from "./SettingRow.svelte";

  let {
    appVersion,
  }: {
    appVersion: string;
  } = $props();
</script>

<header class="mb-5">
  <h2 class="text-lg font-semibold tracking-tight">About</h2>
</header>

<SettingsCard>
  <SettingRow title="App">
    {#snippet control()}
      <span class="text-sm">Muesli</span>
    {/snippet}
  </SettingRow>
  <SettingRow title="Version">
    {#snippet control()}
      <span class="font-mono text-xs tabular-nums">{appVersion}</span>
    {/snippet}
  </SettingRow>
</SettingsCard>

<!-- Server: the muesli-server endpoint this app signs in to and syncs with. -->
<SettingsCard heading="Server">
  <SettingRow
    title="Server URL"
    description="The muesli-server this app signs in to and syncs with."
    stacked
  >
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
          if (normalized !== null) {
            settings.setWsBase(normalized);
            // Re-resolve identity + the workspace list against the new server
            // NOW — otherwise the old server's identity keeps driving the sync
            // gate and presence until the next refresh().
            void workspaces.refresh();
          } else e.currentTarget.value = displayUrl(settings.wsBase);
        }}
        aria-label="Server URL"
      />
    {/snippet}
  </SettingRow>
</SettingsCard>
