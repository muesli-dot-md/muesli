<script lang="ts">
  // Settings → API keys (settings.md §2.2): GitHub-PAT-style list / mint /
  // revoke over /api/me/tokens. Keys are delegated agent identities; the raw
  // `mua_` secret appears exactly once, inside TokenMintModal's success state.
  import KeyRound from "@lucide/svelte/icons/key-round";
  import Plus from "@lucide/svelte/icons/plus";
  import Trash2 from "@lucide/svelte/icons/trash-2";
  import { onMount } from "svelte";
  import { createAccountApi, AccountApiError, type ApiTokenSummary } from "../accountApi";
  import { t } from "../i18n/index.svelte";
  import { httpBase, loginUrl, type AuthInfo } from "../identity";
  import { driveDate, fullDateTime } from "../time";
  import SettingsCard from "./SettingsCard.svelte";
  import TokenMintModal from "./TokenMintModal.svelte";

  let {
    auth,
    toast,
  }: {
    auth: AuthInfo;
    toast: (msg: string, kind?: "info" | "warning") => void;
  } = $props();

  const api = createAccountApi({ httpBase });

  let tokens: ApiTokenSummary[] = $state([]);
  let loading = $state(true);
  /** 401 → sign in; 503 → open mode; anything else → generic error line. */
  let degraded: "signin" | "open" | "error" | null = $state(null);
  let mintOpen = $state(false);
  let revoking: string | null = $state(null);

  const errMsg = (e: unknown) =>
    t("common.errorWithDetail", { detail: e instanceof Error ? e.message : String(e) });

  async function load() {
    loading = true;
    try {
      tokens = (await api.listTokens()).tokens;
      degraded = null;
    } catch (e) {
      if (e instanceof AccountApiError && e.status === 401) degraded = "signin";
      else if (e instanceof AccountApiError && e.status === 503) degraded = "open";
      else degraded = "error";
    } finally {
      loading = false;
    }
  }

  async function revoke(token: ApiTokenSummary) {
    const label = token.label ?? token.id.slice(0, 8);
    if (!confirm(t("settings.keys.revokeConfirm", { label }))) return;
    revoking = token.id;
    try {
      await api.revokeToken(token.id);
      tokens = tokens.filter((k) => k.id !== token.id);
      toast(t("settings.keys.revoked"));
    } catch (e) {
      toast(errMsg(e), "warning");
    } finally {
      revoking = null;
    }
  }

  function scopesLabel(scopes: string[]): string {
    return scopes.includes("write")
      ? t("settings.keys.scopeReadWrite")
      : t("settings.keys.scopeRead");
  }

  onMount(() => {
    void load();
  });
</script>

<header class="mb-5 flex flex-wrap items-start justify-between gap-3">
  <div class="min-w-0">
    <h2 class="text-lg font-semibold tracking-tight">{t("settings.nav.apiKeys")}</h2>
    <p class="mt-1 max-w-prose text-sm text-[var(--text-muted)]" style="text-wrap: pretty;">
      {t("settings.keys.purpose")}
    </p>
  </div>
  {#if !(auth.mode === "open" || degraded === "open" || degraded === "signin")}
    <button class="btn btn-primary btn-sm shrink-0 gap-2" onclick={() => (mintOpen = true)}>
      <Plus class="h-4 w-4" aria-hidden="true" />
      {t("settings.keys.create")}
    </button>
  {/if}
</header>

{#if auth.mode === "open" || degraded === "open"}
  <p class="text-sm text-[var(--text-muted)]" style="text-wrap: pretty;">
    {t("settings.openMode")}
  </p>
{:else if degraded === "signin"}
  <p class="text-sm text-[var(--text-muted)]" style="text-wrap: pretty;">
    {t("settings.signInToManage")}
    <a class="link link-primary" href={loginUrl()}>{t("common.signIn")}</a>
  </p>
{:else}
  {#if loading}
    <p class="text-sm text-[var(--text-muted)]">{t("common.loading")}</p>
  {:else if degraded === "error"}
    <p class="text-sm text-error">{t("settings.keys.loadFailed")}</p>
  {:else if tokens.length === 0}
    <SettingsCard>
      <div class="flex flex-col items-center gap-2 px-5 py-10 text-center">
        <KeyRound class="h-6 w-6 opacity-40" aria-hidden="true" />
        <p class="text-sm text-[var(--text-muted)]">{t("settings.keys.empty")}</p>
      </div>
    </SettingsCard>
  {:else}
    <!-- Multica-style token list: name + scope badge over created/expiry meta,
         a trailing trash icon to revoke. -->
    <SettingsCard>
      {#each tokens as token (token.id)}
        {@const expired =
          token.expires_at != null && new Date(token.expires_at).getTime() < Date.now()}
        <div
          class="flex items-center gap-3 border-t border-base-300/60 px-5 py-3.5 first:border-t-0"
        >
          <span
            class="flex h-9 w-9 shrink-0 items-center justify-center rounded-field bg-base-200"
            aria-hidden="true"
          >
            <KeyRound class="h-4 w-4 opacity-70" />
          </span>
          <div class="min-w-0 flex-1">
            <div class="flex flex-wrap items-center gap-2">
              <span class="truncate text-sm font-medium">{token.label ?? "—"}</span>
              <span class="badge badge-ghost badge-xs">{scopesLabel(token.scopes)}</span>
              {#if expired}
                <span class="badge badge-error badge-xs">{t("settings.keys.expiredBadge")}</span>
              {/if}
            </div>
            <p class="mt-0.5 text-xs tabular-nums text-[var(--text-muted)]">
              <span title={fullDateTime(token.created_at)}>
                {t("settings.keys.createdOn", { date: driveDate(token.created_at) })}
              </span>
              ·
              {#if token.expires_at}
                <span title={fullDateTime(token.expires_at)}>
                  {t("settings.keys.expiresOn", { date: driveDate(token.expires_at) })}
                </span>
              {:else}
                {t("settings.keys.noExpiry")}
              {/if}
            </p>
          </div>
          <button
            class="btn btn-ghost btn-sm btn-square shrink-0 text-error"
            disabled={revoking === token.id}
            title={t("settings.keys.revoke")}
            aria-label={t("settings.keys.revoke")}
            onclick={() => void revoke(token)}
          >
            {#if revoking === token.id}
              <span class="loading loading-spinner loading-xs"></span>
            {:else}
              <Trash2 class="h-4 w-4" aria-hidden="true" />
            {/if}
          </button>
        </div>
      {/each}
    </SettingsCard>
  {/if}
{/if}

{#if mintOpen}
  <TokenMintModal
    {api}
    onclose={(minted) => {
      mintOpen = false;
      if (minted) void load();
    }}
  />
{/if}
