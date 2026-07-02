<script lang="ts">
  // Settings → Preferences (Multica's "Preferences" page). Per-browser, no API:
  // a Multica-style Theme card (Light/Dark/System preview cards), the accent
  // picker, the default home view, and a Language selector (i18n locale
  // switching IS wired — theme.svelte.ts / accent.svelte.ts / prefs.svelte.ts /
  // i18n). Cards mirror the new card chrome: small-caps section title above a
  // bordered, shadow-card surface.
  import Check from "@lucide/svelte/icons/check";
  import Grid2x2 from "@lucide/svelte/icons/grid-2x2";
  import List from "@lucide/svelte/icons/list";
  import ListTree from "@lucide/svelte/icons/list-tree";
  import { ACCENT_PRESETS, accentStore } from "../accent.svelte";
  import {
    availableLocales,
    currentLocale,
    setLocale,
    t,
    type LocaleCode,
  } from "../i18n/index.svelte";
  import { prefs } from "../prefs.svelte";
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

<!-- Language -->
<SettingsCard heading={t("settings.language")}>
  <SettingRow title={t("settings.language")} description={t("settings.language.hint")}>
    {#snippet control()}
      <select
        class="select select-sm w-52 max-w-full"
        value={currentLocale()}
        onchange={(e) => setLocale(e.currentTarget.value as LocaleCode)}
      >
        {#each availableLocales as l (l.code)}
          <option value={l.code}>{l.label}</option>
        {/each}
      </select>
    {/snippet}
  </SettingRow>
</SettingsCard>
