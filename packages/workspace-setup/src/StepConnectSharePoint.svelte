<script lang="ts">
  // SharePoint connect: app identity → admin grant → tenant + site → library picker +
  // probe (spec 2026-07-02). Logic lives in sharepoint.ts (rune-free, node-tested);
  // this component holds an SpState in $state and renders the four stages.
  // `standalone` (Settings → Connections mounts) hides the StepHeader + wizard Back.
  import StepHeader from "./StepHeader.svelte";
  import {
    applyLibraries,
    backStage,
    connectBody,
    identityComplete,
    initialSpState,
    librariesBody,
    nextStage,
    siteComplete,
    substitute,
    type SpState,
  } from "./sharepoint";
  import type { SharePointHost, SharePointSetup } from "./host";
  import type { WizardKey } from "./copy";
  import "./wizard.css";

  let {
    host,
    t,
    workspaceId: _workspaceId,
    ensureWorkspace,
    onconnected,
    onback,
    stepIndex,
    totalSteps,
    standalone = false,
  }: {
    host: SharePointHost;
    t: (k: WizardKey, p?: Record<string, string | number>) => string;
    workspaceId: string | null;
    ensureWorkspace: () => Promise<string>;
    onconnected: (workspaceId: string) => void;
    onback: () => void;
    stepIndex: number;
    totalSteps: number;
    standalone?: boolean;
  } = $props();

  const STAGES = [
    { id: "identity", label: "wizard.spStageIdentity" },
    { id: "grant", label: "wizard.spStageGrant" },
    { id: "site", label: "wizard.spStageSite" },
    { id: "connect", label: "wizard.spStageConnect" },
  ] as const;

  let setup: SharePointSetup | null = $state(null);
  let sp: SpState = $state(initialSpState(false));
  let busy = $state(false);
  let error: string | null = $state(null);
  let copied: string | null = $state(null);
  // Private key file: read client-side and kept only in sp.privateKeyPem; never
  // rendered back into the DOM. This tracks just enough to show a confirmation line.
  let privateKeyFileName: string | null = $state(null);
  let privateKeyFileSize: number | null = $state(null);

  $effect(() => {
    void host
      .getSharePointSetup()
      .then((s) => {
        setup = s;
        sp = initialSpState(s.configured);
      })
      .catch((e) => {
        error = t("wizard.error", { detail: e instanceof Error ? e.message : String(e) });
      });
  });

  function errMsg(e: unknown): string {
    return t("wizard.error", { detail: e instanceof Error ? e.message : String(e) });
  }

  async function copyText(key: string, text: string) {
    await navigator.clipboard.writeText(text);
    copied = key;
    setTimeout(() => (copied = null), 1500);
  }

  /** Back inside the stages; at the first stage the wizard's own Back takes over. */
  function back() {
    error = null;
    if (!backStage(sp)) onback();
  }

  async function findLibraries() {
    if (busy || !setup || !siteComplete(sp)) return;
    busy = true;
    error = null;
    try {
      const ws = await ensureWorkspace();
      const res = await host.listSharePointLibraries(ws, librariesBody(sp));
      applyLibraries(sp, res);
    } catch (e) {
      error = errMsg(e);
    } finally {
      busy = false;
    }
  }

  async function pickPrivateKeyFile(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = ""; // re-picking the same file must fire change again
    if (!file) return;
    error = null;
    let text: string;
    try {
      text = await file.text();
    } catch (e2) {
      error = errMsg(e2);
      return;
    }
    if (!text.trim()) {
      error = t("wizard.spKeyPemEmpty");
      return;
    }
    sp.privateKeyPem = text;
    privateKeyFileName = file.name;
    privateKeyFileSize = file.size;
  }

  function clearPrivateKeyFile() {
    sp.privateKeyPem = "";
    privateKeyFileName = null;
    privateKeyFileSize = null;
  }

  async function connect(e: SubmitEvent) {
    e.preventDefault();
    const body = connectBody(sp);
    if (!body || busy) return;
    busy = true;
    error = null;
    try {
      const ws = await ensureWorkspace();
      await host.createStorageConnection(ws, body);
      onconnected(ws);
    } catch (e2) {
      error = errMsg(e2);
    } finally {
      busy = false;
    }
  }
</script>

{#snippet copyBlock(key: string, label: string, text: string)}
  <div class="flex flex-col gap-1">
    <span class="text-sm">{label}</span>
    <div class="relative">
      <pre
        class="max-h-40 overflow-auto rounded-lg bg-base-200 p-3 pr-16 font-mono text-xs"
        style="white-space: pre-wrap; word-break: break-all;">{text}</pre>
      <button
        class="btn btn-xs absolute right-2 top-2"
        type="button"
        onclick={() => void copyText(key, text)}
      >
        {copied === key ? t("wizard.copied") : t("wizard.copy")}
      </button>
    </div>
  </div>
{/snippet}

{#if !standalone}
  <StepHeader
    {stepIndex}
    {totalSteps}
    title={t("wizard.spConnectTitle")}
    body={t("wizard.spLead")}
    {t}
  />
{/if}

{#if !setup}
  <p class="text-sm text-base-content/70">
    <span class="mws-dot mws-pulse mr-1 inline-block bg-[var(--mws-brand)]"></span>
    {error ?? "…"}
  </p>
{:else}
  <div class="mb-4 flex flex-wrap items-center gap-2" aria-hidden="true">
    {#each STAGES as s, i (i)}
      <span class="badge badge-sm {sp.stage === s.id ? 'badge-neutral' : 'badge-ghost'}">
        {i + 1}. {t(s.label)}
      </span>
    {/each}
  </div>

  {#if sp.stage === "identity"}
    <div class="flex flex-col gap-3">
      {#if setup.configured}
        <label class="flex cursor-pointer items-start gap-2">
          <input
            type="radio"
            class="radio radio-sm mt-0.5"
            checked={!sp.ownApp}
            onchange={() => (sp.ownApp = false)}
          />
          <span class="text-sm">
            {t("wizard.spServerApp")}
            <span class="block font-mono text-xs text-base-content/60">
              {t("wizard.spServerAppId", { clientId: setup.client_id ?? "" })}
            </span>
          </span>
        </label>
        <label class="flex cursor-pointer items-start gap-2">
          <input
            type="radio"
            class="radio radio-sm mt-0.5"
            checked={sp.ownApp}
            onchange={() => (sp.ownApp = true)}
          />
          <span class="text-sm">{t("wizard.spOwnApp")}</span>
        </label>
      {:else}
        <p class="text-sm text-base-content/70" style="text-wrap: pretty;">
          {t("wizard.spNoServerApp")}
        </p>
      {/if}
      {#if sp.ownApp}
        <p class="text-xs text-base-content/60" style="text-wrap: pretty;">
          {t("wizard.spOwnAppHint")}
        </p>
        <label class="flex flex-col gap-1">
          <span class="text-sm">{t("wizard.spClientId")}</span>
          <input
            class="input input-sm w-full font-mono"
            bind:value={sp.clientId}
            autocomplete="off"
          />
        </label>
        <div class="flex gap-4">
          <label class="flex cursor-pointer items-center gap-2 text-sm">
            <input
              type="radio"
              class="radio radio-sm"
              checked={sp.authMethod === "secret"}
              onchange={() => (sp.authMethod = "secret")}
            />
            {t("wizard.spAuthSecret")}
          </label>
          <label class="flex cursor-pointer items-center gap-2 text-sm">
            <input
              type="radio"
              class="radio radio-sm"
              checked={sp.authMethod === "certificate"}
              onchange={() => (sp.authMethod = "certificate")}
            />
            {t("wizard.spAuthCert")}
          </label>
        </div>
        {#if sp.authMethod === "secret"}
          <label class="flex flex-col gap-1">
            <span class="text-sm">{t("wizard.spClientSecret")}</span>
            <input
              class="input input-sm w-full"
              type="password"
              bind:value={sp.clientSecret}
              autocomplete="off"
            />
          </label>
        {:else}
          <label class="flex flex-col gap-1">
            <span class="text-sm">{t("wizard.spCertPem")}</span>
            <textarea
              class="textarea textarea-sm w-full font-mono"
              rows="4"
              bind:value={sp.certificatePem}
              placeholder="-----BEGIN CERTIFICATE-----"></textarea>
          </label>
          <div class="flex flex-col gap-1">
            <label class="text-sm" for="mws-sp-key-file">{t("wizard.spKeyPem")}</label>
            {#if privateKeyFileName}
              <p class="text-xs text-base-content/60">
                {t("wizard.spKeyPemLoaded", {
                  name: privateKeyFileName,
                  bytes: privateKeyFileSize ?? 0,
                })}
                <button
                  class="btn btn-ghost btn-xs ml-1"
                  type="button"
                  onclick={clearPrivateKeyFile}
                >
                  {t("wizard.spKeyPemRemove")}
                </button>
              </p>
            {:else}
              <input
                id="mws-sp-key-file"
                class="file-input file-input-sm w-full"
                type="file"
                accept=".pem,.key"
                onchange={(e) => void pickPrivateKeyFile(e)}
              />
            {/if}
          </div>
        {/if}
      {/if}
      {#if error}
        <p class="text-sm text-error" style="text-wrap: pretty;">{error}</p>
      {/if}
    </div>
    <div class="mt-4 flex justify-between">
      {#if standalone}<span></span>{:else}
        <button class="btn btn-ghost" type="button" onclick={onback}>{t("wizard.back")}</button>
      {/if}
      <button
        class="btn btn-primary"
        type="button"
        disabled={!identityComplete(sp, setup)}
        onclick={() => nextStage(sp, setup!)}
      >
        {t("wizard.next")}
      </button>
    </div>
  {:else if sp.stage === "grant"}
    <div class="flex flex-col gap-3">
      <p class="text-sm text-base-content/70" style="text-wrap: pretty;">
        {t("wizard.spGrantLead")}
      </p>
      {@render copyBlock(
        "consent",
        t("wizard.spConsentUrl"),
        substitute(setup.consent_url_template, sp, setup),
      )}
      {@render copyBlock(
        "graph",
        t("wizard.spGrantGraph"),
        substitute(setup.grant_snippet_graph, sp, setup),
      )}
      {@render copyBlock(
        "pnp",
        t("wizard.spGrantPowershell"),
        substitute(setup.grant_snippet_powershell, sp, setup),
      )}
      <p class="text-xs text-base-content/60" style="text-wrap: pretty;">
        {t("wizard.spPlaceholderHint")}
      </p>
    </div>
    <div class="mt-4 flex justify-between">
      <button class="btn btn-ghost" type="button" onclick={back}>{t("wizard.back")}</button>
      <button class="btn btn-primary" type="button" onclick={() => nextStage(sp, setup!)}>
        {t("wizard.next")}
      </button>
    </div>
  {:else if sp.stage === "site"}
    <div class="flex flex-col gap-3">
      <div class="flex flex-wrap gap-3">
        <label class="flex min-w-40 flex-1 flex-col gap-1">
          <span class="text-sm">{t("wizard.spTenant")}</span>
          <input
            class="input input-sm w-full font-mono"
            bind:value={sp.tenant}
            placeholder="contoso.onmicrosoft.com"
            autocomplete="off"
          />
        </label>
        <label class="flex min-w-40 flex-1 flex-col gap-1">
          <span class="text-sm">{t("wizard.spSiteUrl")}</span>
          <input
            class="input input-sm w-full"
            type="url"
            bind:value={sp.siteUrl}
            placeholder="https://contoso.sharepoint.com/sites/team"
          />
        </label>
      </div>
      {#if busy}
        <p class="text-sm text-base-content/70">
          <span class="mws-dot mws-pulse mr-1 inline-block bg-[var(--mws-brand)]"></span>
          {t("wizard.spFinding")}
        </p>
      {/if}
      {#if error}
        <p class="text-sm text-error" style="text-wrap: pretty;">{error}</p>
      {/if}
    </div>
    <div class="mt-4 flex justify-between">
      <button class="btn btn-ghost" type="button" onclick={back}>{t("wizard.back")}</button>
      <button
        class="btn btn-primary"
        type="button"
        disabled={busy || !siteComplete(sp)}
        onclick={() => void findLibraries()}
      >
        {t("wizard.spFindLibraries")}
      </button>
    </div>
  {:else}
    <form class="flex flex-col gap-3" onsubmit={connect}>
      <p class="text-sm text-base-content/70">{t("wizard.spSite", { name: sp.siteName })}</p>
      <label class="flex flex-col gap-1">
        <span class="text-sm">{t("wizard.spLibrary")}</span>
        <select class="select select-sm w-full" bind:value={sp.driveId}>
          {#each sp.libraries as lib (lib.drive_id)}
            <option value={lib.drive_id}>
              {lib.name}{lib.is_default ? ` — ${t("wizard.spDefault")}` : ""}
            </option>
          {/each}
        </select>
      </label>
      <label class="flex flex-col gap-1">
        <span class="text-sm">{t("wizard.prefix")}</span>
        <input class="input input-sm w-full" bind:value={sp.prefix} placeholder="notes/" />
      </label>
      {#if busy}
        <p class="text-sm text-base-content/70">
          <span class="mws-dot mws-pulse mr-1 inline-block bg-[var(--mws-brand)]"></span>
          {t("wizard.probing")}
        </p>
      {/if}
      {#if error}
        <p class="text-sm text-error" style="text-wrap: pretty;">{error}</p>
      {/if}
      <div class="mt-2 flex justify-between">
        <button class="btn btn-ghost" type="button" onclick={back}>{t("wizard.back")}</button>
        <button class="btn btn-primary" type="submit" disabled={busy}>
          {t("wizard.testConnect")}
        </button>
      </div>
    </form>
  {/if}
{/if}
