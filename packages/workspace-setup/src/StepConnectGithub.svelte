<script lang="ts">
  import StepHeader from "./StepHeader.svelte";
  import type { WizardHost } from "./host";
  import type { WizardKey } from "./copy";

  let {
    host, t, workspaceId, ensureWorkspace, onconnected, onback, stepIndex, totalSteps,
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

  let apiBase = $state("https://api.github.com");
  let owner = $state("");
  let repo = $state("");
  let branch = $state("main");
  let prefix = $state("");
  let token = $state("");
  let busy = $state(false);
  let error: string | null = $state(null);

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    if (busy) return;
    busy = true;
    error = null;
    try {
      const ws = await ensureWorkspace();
      await host.createStorageConnection(ws, {
        kind: "github",
        api_base: apiBase.trim(),
        owner: owner.trim(),
        repo: repo.trim(),
        branch: branch.trim(),
        ...(prefix.trim() ? { prefix: prefix.trim() } : {}),
        ...(token.trim() ? { token: token.trim() } : {}),
      });
      onconnected(ws);
    } catch (e2) {
      error = t("wizard.error", { detail: e2 instanceof Error ? e2.message : String(e2) });
    } finally {
      busy = false;
    }
  }
</script>

<StepHeader {stepIndex} {totalSteps} title={t("wizard.githubConnectTitle")} {t} />
<form class="flex flex-col gap-3" onsubmit={submit}>
  <label class="flex flex-col gap-1">
    <span class="text-sm">{t("wizard.apiBase")}</span>
    <input class="input input-sm w-full" type="url" bind:value={apiBase} required />
  </label>
  <div class="flex flex-wrap gap-3">
    <label class="flex min-w-32 flex-1 flex-col gap-1">
      <span class="text-sm">{t("wizard.owner")}</span>
      <input class="input input-sm w-full" bind:value={owner} required />
    </label>
    <label class="flex min-w-32 flex-1 flex-col gap-1">
      <span class="text-sm">{t("wizard.repo")}</span>
      <input class="input input-sm w-full" bind:value={repo} required />
    </label>
    <label class="flex min-w-32 flex-1 flex-col gap-1">
      <span class="text-sm">{t("wizard.branch")}</span>
      <input class="input input-sm w-full" bind:value={branch} required />
    </label>
  </div>
  <div class="flex flex-wrap gap-3">
    <label class="flex min-w-40 flex-1 flex-col gap-1">
      <span class="text-sm">{t("wizard.prefix")}</span>
      <input class="input input-sm w-full" bind:value={prefix} placeholder="notes/" />
    </label>
    <label class="flex min-w-40 flex-1 flex-col gap-1">
      <span class="text-sm">{t("wizard.tokenLabel")}</span>
      <input class="input input-sm w-full" type="password" bind:value={token} autocomplete="off" />
    </label>
  </div>
  {#if error}
    <p class="text-sm text-error" style="text-wrap: pretty;">{error}</p>
  {/if}
  <div class="mt-2 flex justify-between">
    <button class="btn btn-ghost" type="button" onclick={onback}>{t("wizard.back")}</button>
    <button class="btn btn-primary" type="submit" disabled={busy}>
      {#if busy}<span class="loading loading-spinner loading-xs"></span>{/if}
      {t("wizard.testConnect")}
    </button>
  </div>
</form>
