<script lang="ts">
  // Settings → Appearance (né Preferences): a Multica-style
  // Theme card (Light/Dark/System preview cards), the accent picker, the
  // background tint and folder-color controls (ported from the desktop app —
  // same palettes/ColorBubbleRow, minus its window translucency), and the default
  // home view (how the home renders — appearance in the broad sense). Everything is localStorage-backed;
  // theme/accent/tint/folder-color additionally sync per-user through the
  // server when signed in (prefsSync.svelte.ts). Cards mirror the new card
  // chrome: small-caps section title above a bordered, shadow-card surface.
  import Check from "@lucide/svelte/icons/check";
  import Grid2x2 from "@lucide/svelte/icons/grid-2x2";
  import List from "@lucide/svelte/icons/list";
  import ListTree from "@lucide/svelte/icons/list-tree";
  import { ACCENT_PRESETS, accentStore } from "../accent.svelte";
  import { background } from "../background.svelte";
  import {
    TINT_HUE_PRESETS,
    FOLDER_HUE_PRESETS,
    TINT_SWATCH_L,
    TINT_SWATCH_C,
  } from "../colorBubbles";
  import { folderColor } from "../folderColor.svelte";
  import { t } from "../i18n/index.svelte";
  import { prefs } from "../prefs.svelte";
  import { resetBackground, resetFolderColor } from "../prefsSync.svelte";
  import ColorBubbleRow from "./ColorBubbleRow.svelte";
  import SettingRow from "./SettingRow.svelte";
  import SettingsCard from "./SettingsCard.svelte";
  import ThemePreviewCards from "./ThemePreviewCards.svelte";
</script>

<header class="mb-5">
  <h2 class="text-lg font-semibold tracking-tight">{t("settings.nav.preferences")}</h2>
  <p class="mt-1 text-sm text-[var(--text-muted)]" style="text-wrap: pretty;">
    {t("settings.appearance.perBrowser")}
  </p>
</header>

<!-- Theme card: Multica-style preview cards -->
<SettingsCard heading={t("settings.theme")}>
  <div class="px-5 py-4">
    <ThemePreviewCards />
    <p class="mt-3 text-xs text-[var(--text-muted)]" style="text-wrap: pretty;">
      {t("settings.appearance.motionNote")}
    </p>
  </div>
</SettingsCard>

<!-- Accent + default view -->
<SettingsCard>
  <SettingRow title={t("settings.accent")} description={t("settings.accent.hint")}>
    {#snippet control()}
      {#each ACCENT_PRESETS as p (p.id)}
        {@const selected = accentStore.id === p.id}
        <button
          class="arc-tap flex h-9 w-9 items-center justify-center rounded-full {selected
            ? 'ring-2 ring-base-content/40 ring-offset-2 ring-offset-base-100'
            : 'hover:scale-105'}"
          style="background-color: {p.light};"
          title={t(p.labelKey)}
          aria-label={t(p.labelKey)}
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

  <SettingRow title={t("settings.defaultView")} description={t("settings.defaultView.hint")}>
    {#snippet control()}
      <div class="join">
        <button
          class="btn join-item btn-sm gap-1 {prefs.homeView === 'list'
            ? 'btn-active'
            : 'btn-ghost'}"
          onclick={() => (prefs.homeView = "list")}
        >
          <List class="h-3.5 w-3.5" aria-hidden="true" />
          {t("settings.list")}
        </button>
        <button
          class="btn join-item btn-sm gap-1 {prefs.homeView === 'grid'
            ? 'btn-active'
            : 'btn-ghost'}"
          onclick={() => (prefs.homeView = "grid")}
        >
          <Grid2x2 class="h-3.5 w-3.5" aria-hidden="true" />
          {t("settings.grid")}
        </button>
        <button
          class="btn join-item btn-sm gap-1 {prefs.homeView === 'tree'
            ? 'btn-active'
            : 'btn-ghost'}"
          onclick={() => (prefs.homeView = "tree")}
        >
          <ListTree class="h-3.5 w-3.5" aria-hidden="true" />
          {t("settings.tree")}
        </button>
      </div>
    {/snippet}
  </SettingRow>
</SettingsCard>

<!-- Background tint: the desktop's floor controls, minus its window
     translucency (no web counterpart) — the wash lands flat on the page floor. -->
<SettingsCard heading={t("settings.background")} description={t("settings.background.hint")}>
  <SettingRow title={t("settings.background.tintStrength")} stacked>
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
          aria-label={t("settings.background.tintStrength")}
        />
      </div>
    {/snippet}
  </SettingRow>

  <SettingRow title={t("settings.background.tintHue")} stacked>
    {#snippet control()}
      <ColorBubbleRow
        presets={TINT_HUE_PRESETS}
        hue={background.hue}
        onSelect={(hue) => (background.hue = hue)}
        groupLabel={t("settings.background.tintHue")}
        customLabel={t("settings.customColor")}
        disabled={background.tint === 0}
        swatchL={TINT_SWATCH_L}
        swatchC={TINT_SWATCH_C}
      />
    {/snippet}
  </SettingRow>

  <SettingRow
    title={t("settings.background.reset")}
    description={t("settings.background.reset.hint")}
  >
    {#snippet control()}
      <!-- Routed through prefsSync so the synced keys are deleted server-side
           (null), not written out as this app's defaults. -->
      <button class="btn btn-ghost btn-sm" onclick={() => resetBackground()}
        >{t("settings.resetToDefault")}</button
      >
    {/snippet}
  </SettingRow>
</SettingsCard>

<!-- File tree folder icon color -->
<SettingsCard heading={t("settings.folderColor")} description={t("settings.folderColor.hint")}>
  <SettingRow title={t("settings.folderColor.iconHue")} stacked>
    {#snippet control()}
      <ColorBubbleRow
        presets={FOLDER_HUE_PRESETS}
        hue={folderColor.hue}
        onSelect={(hue) => (folderColor.hue = hue)}
        groupLabel={t("settings.folderColor.iconHue")}
        customLabel={t("settings.customColor")}
      />
    {/snippet}
  </SettingRow>

  <SettingRow
    title={t("settings.folderColor.reset")}
    description={t("settings.folderColor.reset.hint")}
  >
    {#snippet control()}
      <button class="btn btn-ghost btn-sm" onclick={() => resetFolderColor()}
        >{t("settings.resetToDefault")}</button
      >
    {/snippet}
  </SettingRow>
</SettingsCard>
