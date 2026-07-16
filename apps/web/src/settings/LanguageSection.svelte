<script lang="ts">
  // Settings → Language: the interface-language selector. Lives on its own
  // page because the Appearance page is exactly that — appearance — and the
  // UI language is not. localStorage-backed (per browser), never synced.
  import {
    availableLocales,
    currentLocale,
    setLocale,
    t,
    type LocaleCode,
  } from "../i18n/index.svelte";
  import SettingRow from "./SettingRow.svelte";
  import SettingsCard from "./SettingsCard.svelte";
</script>

<header class="mb-5">
  <h2 class="text-lg font-semibold tracking-tight">{t("settings.language")}</h2>
  <p class="mt-1 text-sm text-[var(--text-muted)]" style="text-wrap: pretty;">
    {t("settings.language.hint")}
  </p>
</header>

<SettingsCard>
  <SettingRow title={t("settings.language")}>
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
