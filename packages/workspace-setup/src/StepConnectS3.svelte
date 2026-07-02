<script lang="ts">
  // S3 connect: policy FIRST (so keys are born least-privilege), then the form,
  // then the probe with a live status line (spec §4/§6).
  import StepHeader from "./StepHeader.svelte";
  import type { WizardHost } from "./host";
  import type { WizardKey } from "./copy";

  let {
    host,
    t,
    workspaceId: _workspaceId,
    ensureWorkspace,
    onconnected,
    onback,
    stepIndex,
    totalSteps,
  }: {
    host: WizardHost;
    t: (k: WizardKey, p?: Record<string, string | number>) => string;
    workspaceId: string | null;
    ensureWorkspace: () => Promise<string>;
    onconnected: (workspaceId: string) => void;
    onback: () => void;
    stepIndex: number;
    totalSteps: number;
  } = $props();

  let endpoint = $state("");
  let bucket = $state("");
  let region = $state("");
  let prefix = $state("");
  let accessKeyId = $state("");
  let secretKey = $state("");
  let busy = $state(false);
  let error: string | null = $state(null);
  let policyText = $state("");
  let copied = $state(false);

  // The policy preview refreshes when bucket/prefix change (debounced by blur).
  async function refreshPolicy() {
    if (!bucket.trim()) return;
    try {
      const res = await host.getS3Policy(bucket.trim(), prefix.trim());
      policyText = JSON.stringify((res as { policy?: unknown }).policy ?? res, null, 2);
    } catch {
      policyText = "";
    }
  }
  async function copyPolicy() {
    await navigator.clipboard.writeText(policyText);
    copied = true;
    setTimeout(() => (copied = false), 1500);
  }

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    if (busy) return;
    busy = true;
    error = null;
    try {
      const ws = await ensureWorkspace();
      await host.createStorageConnection(ws, {
        kind: "s3",
        endpoint: endpoint.trim(),
        bucket: bucket.trim(),
        ...(region.trim() ? { region: region.trim() } : {}),
        ...(prefix.trim() ? { prefix: prefix.trim() } : {}),
        access_key_id: accessKeyId.trim(),
        secret_key: secretKey,
      });
      onconnected(ws);
    } catch (e2) {
      error = t("wizard.error", { detail: e2 instanceof Error ? e2.message : String(e2) });
    } finally {
      busy = false;
    }
  }
</script>

<StepHeader
  {stepIndex}
  {totalSteps}
  title={t("wizard.s3ConnectTitle")}
  body={t("wizard.s3PolicyLead")}
  {t}
/>

<form class="flex flex-col gap-3" onsubmit={submit}>
  <div class="flex flex-wrap gap-3">
    <label class="flex min-w-40 flex-1 flex-col gap-1">
      <span class="text-sm">{t("wizard.bucket")}</span>
      <input class="input input-sm w-full" bind:value={bucket} onblur={refreshPolicy} required />
    </label>
    <label class="flex min-w-40 flex-1 flex-col gap-1">
      <span class="text-sm">{t("wizard.prefix")}</span>
      <input
        class="input input-sm w-full"
        bind:value={prefix}
        onblur={refreshPolicy}
        placeholder="notes/"
      />
    </label>
  </div>
  {#if policyText}
    <div class="relative">
      <pre
        class="max-h-40 overflow-auto rounded-lg bg-base-200 p-3 font-mono text-xs">{policyText}</pre>
      <button class="btn btn-xs absolute right-2 top-2" type="button" onclick={copyPolicy}>
        {copied ? t("wizard.copied") : t("wizard.copyPolicy")}
      </button>
    </div>
  {/if}
  <label class="flex flex-col gap-1">
    <span class="text-sm">{t("wizard.endpoint")}</span>
    <input
      class="input input-sm w-full"
      type="url"
      bind:value={endpoint}
      placeholder="https://s3.example.com"
      required
    />
  </label>
  <div class="flex flex-wrap gap-3">
    <label class="flex min-w-40 flex-1 flex-col gap-1">
      <span class="text-sm">{t("wizard.region")}</span>
      <input class="input input-sm w-full" bind:value={region} placeholder="us-east-1" />
    </label>
    <label class="flex min-w-40 flex-1 flex-col gap-1">
      <span class="text-sm">{t("wizard.accessKeyId")}</span>
      <input class="input input-sm w-full" bind:value={accessKeyId} autocomplete="off" required />
    </label>
    <label class="flex min-w-40 flex-1 flex-col gap-1">
      <span class="text-sm">{t("wizard.secretKey")}</span>
      <input
        class="input input-sm w-full"
        type="password"
        bind:value={secretKey}
        autocomplete="off"
        required
      />
    </label>
  </div>
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
    <button class="btn btn-ghost" type="button" onclick={onback}>{t("wizard.back")}</button>
    <button class="btn btn-primary" type="submit" disabled={busy}>{t("wizard.testConnect")}</button>
  </div>
</form>
