<script lang="ts">
  // Mint-an-API-key modal (settings.md §2.2). Two phases: the form (label,
  // scope preset, expiry) and the show-once success state — the `mua_` secret
  // with a copy button, an amber "you won't see this again" callout, and a
  // ready-to-paste MCP config snippet pointing at {httpBase}/mcp.
  import Copy from "@lucide/svelte/icons/copy";
  import TriangleAlert from "@lucide/svelte/icons/triangle-alert";
  import {
    AccountApiError,
    type AccountApi,
    type MintedToken,
    type TokenScopes,
  } from "../accountApi";
  import { t } from "../i18n/index.svelte";
  import { httpBase } from "../identity";

  let {
    api,
    onclose,
  }: {
    api: AccountApi;
    /** minted=true → the parent reloads its key list. */
    onclose: (minted: boolean) => void;
  } = $props();

  let label = $state("");
  let scopes: "read" | "readwrite" = $state("read");
  let expiry: "30" | "90" | "365" | "never" = $state("90");
  let minting = $state(false);
  let error: string | null = $state(null);
  let minted: MintedToken | null = $state(null);
  let copied = $state(false);

  function snippetFor(m: MintedToken | null): string {
    if (!m) return "";
    return JSON.stringify(
      {
        mcpServers: {
          muesli: {
            type: "http",
            url: `${httpBase}/mcp`,
            headers: { Authorization: `Bearer ${m.token}` },
          },
        },
      },
      null,
      2,
    );
  }
  const mcpSnippet = $derived(snippetFor(minted));

  async function mint(e: SubmitEvent) {
    e.preventDefault();
    if (minting) return;
    minting = true;
    error = null;
    try {
      const scopeList: TokenScopes = scopes === "readwrite" ? ["read", "write"] : ["read"];
      minted = await api.mintToken({
        label,
        scopes: scopeList,
        expires_in_days: expiry === "never" ? null : Number(expiry),
      });
    } catch (e2) {
      error =
        e2 instanceof AccountApiError && e2.status === 400
          ? e2.message
          : t("common.errorWithDetail", { detail: e2 instanceof Error ? e2.message : String(e2) });
    } finally {
      minting = false;
    }
  }

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      copied = true;
      setTimeout(() => (copied = false), 2000);
    } catch {
      // selection fallback: the inputs select-on-focus below
    }
  }

  function close() {
    onclose(minted !== null);
  }
</script>

<div class="modal modal-open" role="dialog">
  <div class="modal-box w-[30rem] max-w-[92vw]">
    {#if !minted}
      <h3 class="mb-4 text-lg font-semibold">{t("settings.keys.create")}</h3>
      <form class="flex flex-col gap-4" onsubmit={mint}>
        <label class="flex flex-col gap-1">
          <span class="text-sm font-medium">{t("settings.keys.labelLabel")}</span>
          <input
            class="input input-sm w-full"
            bind:value={label}
            placeholder={t("settings.keys.labelPlaceholder")}
            maxlength={120}
            required
          />
        </label>

        <fieldset class="flex flex-col gap-2">
          <legend class="mb-1 text-sm font-medium">{t("settings.keys.accessLabel")}</legend>
          <label class="flex cursor-pointer items-start gap-3">
            <input
              type="radio"
              class="radio radio-sm mt-0.5"
              name="scopes"
              value="read"
              bind:group={scopes}
            />
            <span class="text-sm">
              {t("settings.keys.scopeRead")}
              <span class="block text-xs opacity-60">{t("settings.keys.scopeReadHint")}</span>
            </span>
          </label>
          <label class="flex cursor-pointer items-start gap-3">
            <input
              type="radio"
              class="radio radio-sm mt-0.5"
              name="scopes"
              value="readwrite"
              bind:group={scopes}
            />
            <span class="text-sm">
              {t("settings.keys.scopeReadWrite")}
              <span class="block text-xs opacity-60">{t("settings.keys.scopeReadWriteHint")}</span>
            </span>
          </label>
        </fieldset>

        <label class="flex items-center justify-between gap-3">
          <span class="text-sm font-medium">{t("settings.keys.expiryLabel")}</span>
          <select class="select select-sm w-40" bind:value={expiry}>
            <option value="30">{t("settings.keys.expiry30")}</option>
            <option value="90">{t("settings.keys.expiry90")}</option>
            <option value="365">{t("settings.keys.expiry1y")}</option>
            <option value="never">{t("settings.keys.expiryNever")}</option>
          </select>
        </label>

        {#if error}
          <p class="text-sm text-error">{error}</p>
        {/if}

        <div class="modal-action mt-2">
          <button class="btn btn-ghost" type="button" onclick={close}>
            {t("common.cancel")}
          </button>
          <button class="btn btn-primary" type="submit" disabled={minting}>
            {t("common.create")}
          </button>
        </div>
      </form>
    {:else}
      <h3 class="mb-2 text-lg font-semibold">{t("settings.keys.minted")}</h3>
      <div class="alert alert-warning py-2 text-sm">
        <TriangleAlert class="h-4 w-4 shrink-0" aria-hidden="true" />
        <span>{t("settings.keys.showOnce")}</span>
      </div>
      <div class="mt-3 flex items-center gap-2">
        <input
          class="input input-sm w-full font-mono text-xs"
          readonly
          value={minted.token}
          onfocus={(e) => e.currentTarget.select()}
        />
        <button class="btn btn-sm shrink-0 gap-1" onclick={() => minted && void copy(minted.token)}>
          <Copy class="h-3.5 w-3.5" aria-hidden="true" />
          {copied ? t("common.copiedToClipboard") : t("settings.keys.copyKey")}
        </button>
      </div>

      <p class="mt-4 text-sm font-medium">{t("settings.keys.mcpSnippet")}</p>
      <p class="text-xs opacity-60">{t("settings.keys.mcpSnippetHint")}</p>
      <div class="relative mt-2">
        <pre
          class="max-h-48 overflow-auto rounded-box border border-base-300 bg-base-200 p-3 font-mono text-xs">{mcpSnippet}</pre>
        <button
          class="btn btn-ghost btn-xs absolute top-2 right-2"
          title={t("settings.keys.copySnippet")}
          aria-label={t("settings.keys.copySnippet")}
          onclick={() => void copy(mcpSnippet)}
        >
          <Copy class="h-3.5 w-3.5 opacity-70" aria-hidden="true" />
        </button>
      </div>

      <div class="modal-action">
        <button class="btn btn-primary" onclick={close}>{t("common.done")}</button>
      </div>
    {/if}
  </div>
  <button class="modal-backdrop" aria-label={t("common.close")} onclick={close}></button>
</div>
