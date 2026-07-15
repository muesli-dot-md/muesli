<script lang="ts">
  // Settings → Preferences (My Account): the desktop's look & feel — a
  // Multica-style Theme card (Light/Dark/System preview cards), the accent
  // picker (ported from the webapp), the window background floor controls
  // (translucency / tint / hue), and the file tree's folder icon color. All
  // localStorage-backed; theme/accent/tint/folder-color additionally sync
  // per-user through the server when signed in (prefsSync.svelte.ts) —
  // translucency stays machine-local. Mirrors the webapp's Preferences page
  // chrome; the desktop has no default-view / language, so those are omitted.
  // Literal strings (no i18n). Folds in the former AppearanceSection's
  // background block.
  import { Check } from "lucide-svelte";
  import { ACCENT_PRESETS, ACCENT_LABELS, accentStore } from "$lib/accent.svelte";
  import { background } from "$lib/background.svelte";
  import { folderColor } from "$lib/folderColor.svelte";
  import { prefsSync } from "$lib/prefsSync.svelte";
  import {
    TINT_HUE_PRESETS,
    FOLDER_HUE_PRESETS,
    TINT_SWATCH_L,
    TINT_SWATCH_C,
  } from "$lib/colorBubbles";
  import SettingsCard from "./SettingsCard.svelte";
  import SettingRow from "./SettingRow.svelte";
  import ThemePreviewCards from "./ThemePreviewCards.svelte";
  import ColorBubbleRow from "./ColorBubbleRow.svelte";
</script>

<header class="mb-5">
  <h2 class="text-lg font-semibold tracking-tight">Preferences</h2>
  <p class="mt-1 text-sm text-[var(--text-muted)]" style="text-wrap: pretty;">
    Theme, accent, window background, and file tree colors. Signed in, everything but translucency
    follows your account across apps; otherwise it stays on this machine.
  </p>
</header>

<!-- Theme card: Multica-style preview cards -->
<SettingsCard heading="Theme">
  <div class="px-5 py-4">
    <ThemePreviewCards />
  </div>
</SettingsCard>

<!-- Accent picker: the webapp's row (same presets/swatches/selected state),
     English strings from its en locale. The default periwinkle preset equals
     the stock --arc-primary, so nothing changes until the user picks. -->
<SettingsCard>
  <SettingRow title="Accent color" description="Used for buttons, links and selection.">
    {#snippet control()}
      {#each ACCENT_PRESETS as p (p.id)}
        {@const selected = accentStore.id === p.id}
        <button
          class="arc-tap flex h-9 w-9 items-center justify-center rounded-full {selected
            ? 'ring-2 ring-base-content/40 ring-offset-2 ring-offset-base-100'
            : 'hover:scale-105'}"
          style="background-color: {p.light};"
          title={ACCENT_LABELS[p.id]}
          aria-label={ACCENT_LABELS[p.id]}
          aria-pressed={selected}
          onclick={() => (accentStore.id = p.id)}
        >
          {#if selected}
            <Check class="h-4 w-4" style="color: {p.lightContent};" aria-hidden="true" />
          {/if}
        </button>
      {/each}
    {/snippet}
  </SettingRow>
</SettingsCard>

<!-- Background floor controls -->
<SettingsCard
  heading="Background"
  description="Translucency lets the desktop show through the window floor; tint adds a subtle color wash."
>
  <SettingRow title="Translucency" stacked>
    {#snippet control()}
      <div class="w-full">
        <div class="mb-1.5 flex items-center justify-end">
          <span class="text-xs text-[var(--text-muted)] tabular-nums"
            >{background.translucency}%</span
          >
        </div>
        <input
          type="range"
          min="0"
          max="100"
          class="range range-xs range-primary w-full"
          value={background.translucency}
          oninput={(e) => (background.translucency = +e.currentTarget.value)}
          aria-label="Background translucency"
        />
      </div>
    {/snippet}
  </SettingRow>

  <SettingRow title="Tint strength" stacked>
    {#snippet control()}
      <div class="w-full">
        <div class="mb-1.5 flex items-center justify-end">
          <span class="text-xs text-[var(--text-muted)] tabular-nums">{background.tint}%</span>
        </div>
        <input
          type="range"
          min="0"
          max="100"
          class="range range-xs range-primary w-full"
          value={background.tint}
          oninput={(e) => (background.tint = +e.currentTarget.value)}
          aria-label="Tint strength"
        />
      </div>
    {/snippet}
  </SettingRow>

  <SettingRow title="Tint hue" stacked>
    {#snippet control()}
      <ColorBubbleRow
        presets={TINT_HUE_PRESETS}
        hue={background.hue}
        onSelect={(hue) => (background.hue = hue)}
        groupLabel="Tint hue"
        disabled={background.tint === 0}
        swatchL={TINT_SWATCH_L}
        swatchC={TINT_SWATCH_C}
      />
    {/snippet}
  </SettingRow>

  <SettingRow
    title="Reset background"
    description="Restore translucency, tint, and hue to defaults."
  >
    {#snippet control()}
      <!-- Routed through prefsSync so the synced keys are deleted server-side
           (null), not written out as this app's defaults. -->
      <button class="btn btn-ghost btn-sm" onclick={() => prefsSync.resetBackground()}
        >Reset to default</button
      >
    {/snippet}
  </SettingRow>
</SettingsCard>

<!-- File tree folder icon color -->
<SettingsCard heading="Folder color" description="Color of folder icons in the file tree.">
  <SettingRow title="Icon hue" stacked>
    {#snippet control()}
      <ColorBubbleRow
        presets={FOLDER_HUE_PRESETS}
        hue={folderColor.hue}
        onSelect={(hue) => (folderColor.hue = hue)}
        groupLabel="Icon hue"
      />
    {/snippet}
  </SettingRow>

  <SettingRow title="Reset folder color" description="Restore the default folder color.">
    {#snippet control()}
      <button class="btn btn-ghost btn-sm" onclick={() => prefsSync.resetFolderColor()}
        >Reset to default</button
      >
    {/snippet}
  </SettingRow>
</SettingsCard>
