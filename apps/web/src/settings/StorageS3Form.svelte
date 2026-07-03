<script lang="ts">
  // S3 / R2 / MinIO attach form (settings.md §2.3). Credentials are per-workspace
  // (plan 1a task 4): the access key + secret entered here are encrypted and stored
  // against this connection, mirroring @muesli/workspace-setup's StepConnectS3 (the
  // wizard's own S3 step). The server still accepts a connection with no credentials
  // for self-hosts running MUESLI_S3_ACCESS_KEY/_SECRET_KEY from its environment, but
  // this form always collects them so a fresh connection is never silently dependent
  // on server env vars the admin may not control. The server probes the bucket before
  // creating the row, so 502 = "couldn't reach it" inline.
  import { t } from "../i18n/index.svelte";
  import { WorkspaceApiError, type WorkspaceApi } from "../workspaceApi";

  let {
    api,
    workspaceId,
    oncreated,
  }: {
    api: WorkspaceApi;
    workspaceId: string;
    oncreated: () => void;
  } = $props();

  let endpoint = $state("");
  let bucket = $state("");
  let region = $state("");
  let prefix = $state("");
  let accessKeyId = $state("");
  let secretKey = $state("");
  let policyText = $state("");
  let copied = $state(false);
  let busy = $state(false);
  let error: string | null = $state(null);

  // The policy preview refreshes when bucket/prefix change (debounced by blur),
  // identical in shape to the wizard's StepConnectS3.
  async function refreshPolicy() {
    if (!bucket.trim()) return;
    try {
      const res = await api.getS3Policy(bucket.trim(), prefix.trim());
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
      await api.createStorageConnection(workspaceId, {
        kind: "s3",
        endpoint: endpoint.trim(),
        bucket: bucket.trim(),
        ...(region.trim() ? { region: region.trim() } : {}),
        ...(prefix.trim() ? { prefix: prefix.trim() } : {}),
        access_key_id: accessKeyId.trim(),
        secret_key: secretKey,
      });
      oncreated();
    } catch (e2) {
      if (e2 instanceof WorkspaceApiError && e2.status === 502) {
        error = t("settings.conn.unreachable", { detail: e2.message });
      } else if (e2 instanceof WorkspaceApiError && e2.status === 503) {
        error = t("settings.conn.serverMissingEnv", { detail: e2.message });
      } else {
        error = e2 instanceof Error ? e2.message : String(e2);
      }
    } finally {
      busy = false;
    }
  }
</script>

<form class="mt-4 flex flex-col gap-3 border-t border-base-300 pt-4" onsubmit={submit}>
  <label class="flex flex-col gap-1">
    <span class="text-sm">{t("settings.conn.endpoint")}</span>
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
      <span class="text-sm">{t("settings.conn.bucket")}</span>
      <input class="input input-sm w-full" bind:value={bucket} onblur={refreshPolicy} required />
    </label>
    <label class="flex min-w-40 flex-1 flex-col gap-1">
      <span class="text-sm">{t("settings.conn.region")}</span>
      <input class="input input-sm w-full" bind:value={region} placeholder="us-east-1" />
    </label>
    <label class="flex min-w-40 flex-1 flex-col gap-1">
      <span class="text-sm">{t("settings.conn.prefix")}</span>
      <input class="input input-sm w-full" bind:value={prefix} onblur={refreshPolicy} placeholder="notes/" />
    </label>
  </div>
  {#if policyText}
    <div class="relative">
      <pre class="max-h-40 overflow-auto rounded-lg bg-base-200 p-3 font-mono text-xs">{policyText}</pre>
      <button class="btn btn-xs absolute top-2 right-2" type="button" onclick={copyPolicy}>
        {copied ? t("wizard.copied") : t("wizard.copyPolicy")}
      </button>
    </div>
  {/if}
  <div class="flex flex-wrap gap-3">
    <label class="flex min-w-40 flex-1 flex-col gap-1">
      <span class="text-sm">{t("settings.conn.accessKeyId")}</span>
      <input class="input input-sm w-full" bind:value={accessKeyId} autocomplete="off" required />
    </label>
    <label class="flex min-w-40 flex-1 flex-col gap-1">
      <span class="text-sm">{t("settings.conn.secretKey")}</span>
      <input
        class="input input-sm w-full"
        type="password"
        bind:value={secretKey}
        autocomplete="off"
        required
      />
    </label>
  </div>
  {#if error}
    <p class="text-sm text-error">{error}</p>
  {/if}
  <div>
    <button class="btn btn-primary btn-sm" type="submit" disabled={busy}>
      {t("settings.conn.attach")}
    </button>
  </div>
</form>
