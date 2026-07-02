<script lang="ts">
  // Settings → About (settings.md §2.6): server version/commit/mode from the
  // unauthenticated GET /api/meta, plus source/docs links and the self-host
  // note. NOTE: the repo declares no canonical public URLs anywhere (no
  // repository field, no homepage) — swap SOURCE_URL/DOCS_URL when one exists.
  import BookOpen from "@lucide/svelte/icons/book-open";
  import ExternalLink from "@lucide/svelte/icons/external-link";
  import HardDrive from "@lucide/svelte/icons/hard-drive";
  import { onMount } from "svelte";
  import { createAccountApi, type ServerMeta, type StorageUsage } from "../accountApi";
  import { t } from "../i18n/index.svelte";
  import { httpBase } from "../identity";
  import SettingRow from "./SettingRow.svelte";
  import SettingsCard from "./SettingsCard.svelte";

  const SOURCE_URL = "https://github.com/muesli-md/muesli";
  const DOCS_URL = "https://github.com/muesli-md/muesli/tree/main/docs";

  const api = createAccountApi({ httpBase });
  let meta: ServerMeta | null = $state(null);
  let failed = $state(false);

  let storage: StorageUsage | null = $state(null);
  let storageFailed = $state(false);

  /** Human-readable bytes (binary units): 0 B, 12 KB, 3.4 MB, 1.2 GB. */
  function formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    const exp = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    const value = bytes / 1024 ** exp;
    // No decimals for bytes; one decimal otherwise (trimmed when whole).
    const text = exp === 0 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, "");
    return `${text} ${units[exp]}`;
  }

  function usedPercent(s: StorageUsage): number {
    if (s.quota_bytes <= 0) return 0;
    return Math.min(100, Math.round((s.used_bytes / s.quota_bytes) * 100));
  }

  onMount(() => {
    api
      .getMeta()
      .then((m) => (meta = m))
      .catch(() => (failed = true));
    api
      .getStorageUsage()
      .then((s) => (storage = s))
      .catch(() => (storageFailed = true));
  });
</script>

<header class="mb-5">
  <h2 class="text-lg font-semibold tracking-tight">{t("settings.nav.about")}</h2>
</header>

<SettingsCard>
  <!-- identity header -->
  <SettingRow>
    <div class="min-w-0 flex-1">
      <p class="text-base font-semibold">
        Muesli{#if meta}&nbsp;v{meta.version}{/if}
      </p>
      <p class="text-sm text-[var(--text-muted)]" style="text-wrap: pretty;">
        {t("settings.about.tagline")}
      </p>
    </div>
  </SettingRow>

  {#if failed}
    <SettingRow title={t("settings.about.metaFailed")} />
  {:else if !meta}
    <SettingRow title={t("common.loading")} />
  {:else}
    <SettingRow title={t("settings.about.version")}>
      {#snippet control()}
        <span class="font-mono text-xs">{meta?.version}</span>
      {/snippet}
    </SettingRow>
    {#if meta.commit}
      <SettingRow title={t("settings.about.commit")}>
        {#snippet control()}
          <span class="font-mono text-xs">{meta?.commit?.slice(0, 12)}</span>
        {/snippet}
      </SettingRow>
    {/if}
    <SettingRow title={t("settings.about.mode")}>
      {#snippet control()}
        <span class="text-sm">
          {meta?.mode === "oidc" ? t("settings.about.modeOidc") : t("settings.about.modeOpen")}
        </span>
      {/snippet}
    </SettingRow>
  {/if}
</SettingsCard>

<!-- storage usage -->
<SettingsCard>
  <SettingRow title={t("settings.about.storage")} stacked>
    {#snippet leading()}
      <HardDrive class="h-4 w-4 opacity-70" aria-hidden="true" />
    {/snippet}
    {#snippet control()}
      {#if storageFailed}
        <p class="text-sm text-[var(--text-muted)]">{t("settings.about.storageFailed")}</p>
      {:else if !storage}
        <p class="text-sm text-[var(--text-muted)]">{t("common.loading")}</p>
      {:else}
        <div class="w-full">
          <progress
            class="progress progress-primary w-full"
            value={usedPercent(storage)}
            max="100"
            aria-label={t("settings.about.storage")}
          ></progress>
          <p class="mt-2 text-sm text-[var(--text-muted)]">
            {t("settings.about.storageUsage", {
              used: formatBytes(storage.used_bytes),
              quota: formatBytes(storage.quota_bytes),
            })}
          </p>
        </div>
      {/if}
    {/snippet}
  </SettingRow>
</SettingsCard>

<!-- source / docs links -->
<SettingsCard>
  <SettingRow title={t("settings.about.source")}>
    {#snippet leading()}
      <ExternalLink class="h-4 w-4 opacity-70" aria-hidden="true" />
    {/snippet}
    {#snippet control()}
      <span class="badge badge-ghost badge-sm">{t("settings.about.license")}</span>
      <a class="btn btn-sm" href={SOURCE_URL} target="_blank" rel="noreferrer">
        {t("settings.about.source")}
      </a>
    {/snippet}
  </SettingRow>
  <SettingRow title={t("settings.about.docs")}>
    {#snippet leading()}
      <BookOpen class="h-4 w-4 opacity-70" aria-hidden="true" />
    {/snippet}
    {#snippet control()}
      <a class="btn btn-sm" href={DOCS_URL} target="_blank" rel="noreferrer">
        {t("settings.about.docs")}
      </a>
    {/snippet}
  </SettingRow>
</SettingsCard>

<p class="mt-3 px-1 text-xs text-[var(--text-muted)]" style="text-wrap: pretty;">
  {t("settings.about.selfHost")}
</p>
