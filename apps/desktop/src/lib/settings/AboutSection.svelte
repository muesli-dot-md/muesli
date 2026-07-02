<script lang="ts">
  // Settings → About: read-only app metadata. Ported from the SettingsModal
  // "About" block into the two-pane card layout.
  import { settings } from "$lib/settings.svelte";
  import SettingsCard from "./SettingsCard.svelte";
  import SettingRow from "./SettingRow.svelte";

  let {
    appVersion,
    statusLabel,
  }: {
    appVersion: string;
    statusLabel: "disconnected" | "connecting" | "connected";
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
  <SettingRow title="Sync server">
    {#snippet control()}
      <span class="max-w-[18rem] truncate font-mono text-xs">{settings.wsBase}</span>
    {/snippet}
  </SettingRow>
  <SettingRow title="Status">
    {#snippet control()}
      <span class="text-sm capitalize">{statusLabel}</span>
    {/snippet}
  </SettingRow>
</SettingsCard>
