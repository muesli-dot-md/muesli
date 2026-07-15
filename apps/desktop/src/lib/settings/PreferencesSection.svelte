<script lang="ts">
  // Settings → Preferences (My Account): the desktop's per-machine look & feel —
  // a Multica-style Theme card (Light/Dark/System preview cards), the window
  // background floor controls (translucency / tint / hue), and the file tree's
  // folder icon color. All localStorage, no API. Mirrors the webapp's
  // Preferences page chrome; the desktop has no default-view / language, so
  // those are omitted. Literal strings (no i18n). Folds in the former
  // AppearanceSection's background block.
  import { background } from "$lib/background.svelte";
  import { folderColor } from "$lib/folderColor.svelte";
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
    Theme, window background, and file tree colors. Saved on this machine only.
  </p>
</header>

<!-- Theme card: Multica-style preview cards -->
<SettingsCard heading="Theme">
  <div class="px-5 py-4">
    <ThemePreviewCards />
  </div>
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
      <button class="btn btn-ghost btn-sm" onclick={() => background.reset()}
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
      <button class="btn btn-ghost btn-sm" onclick={() => folderColor.reset()}
        >Reset to default</button
      >
    {/snippet}
  </SettingRow>
</SettingsCard>
