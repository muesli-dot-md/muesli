<script lang="ts">
  import { onDestroy } from "svelte";
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
    resumeError = false,
    stepIndex,
    totalSteps,
  }: {
    host: WizardHost;
    t: (k: WizardKey, p?: Record<string, string | number>) => string;
    workspaceId: string | null;
    ensureWorkspace: () => Promise<string>;
    onconnected: (workspaceId: string) => void;
    onback: () => void;
    resumeError?: boolean;
    stepIndex: number;
    totalSteps: number;
  } = $props();

  let waiting = $state(false);
  let elapsed = $state(0);
  // svelte-ignore state_referenced_locally -- seeds the banner once from the OAuth-return flag
  let error: string | null = $state(resumeError ? t("wizard.error", { detail: "Google" }) : null);
  let timer: ReturnType<typeof setInterval> | undefined;
  let busy = $state(false);

  const hint = $derived(
    elapsed >= 90
      ? t("wizard.driveHint90")
      : elapsed >= 45
        ? t("wizard.driveHint45")
        : elapsed >= 15
          ? t("wizard.driveHint15")
          : "",
  );

  async function go() {
    if (busy) return;
    busy = true;
    error = null;
    try {
      const ws = await ensureWorkspace();
      host.startDriveOAuth(ws);
      if (host.driveFlow === "redirect") return; // web: full-page nav; never returns
      // desktop: poll the storage status until the callback binds the workspace.
      waiting = true;
      elapsed = 0;
      timer = setInterval(async () => {
        elapsed += 2;
        try {
          const status = await host.getStorageStatus(ws);
          if (status.bound) {
            clearInterval(timer);
            waiting = false;
            onconnected(ws);
          }
        } catch {
          // transient poll errors are expected mid-dance; keep waiting
        }
      }, 2000);
    } catch (e2) {
      error = t("wizard.error", { detail: e2 instanceof Error ? e2.message : String(e2) });
    } finally {
      busy = false;
    }
  }

  onDestroy(() => clearInterval(timer));
</script>

<StepHeader
  {stepIndex}
  {totalSteps}
  title={t("wizard.driveConnectTitle")}
  body={t("wizard.driveLead")}
  {t}
/>

{#if waiting}
  <p class="flex items-center gap-2 text-sm">
    <span class="mws-dot mws-pulse inline-block bg-[var(--mws-brand)]"></span>
    {t("wizard.driveWaiting")} <span class="font-mono text-xs opacity-60">{elapsed}s</span>
  </p>
  {#if hint}
    <p class="mt-2 text-xs text-base-content/60" style="text-wrap: pretty;">{hint}</p>
  {/if}
{:else}
  {#if error}
    <p class="mb-2 text-sm text-error">{error}</p>
  {/if}
  <div class="flex justify-between">
    <button class="btn btn-ghost" type="button" onclick={onback}>{t("wizard.back")}</button>
    <button class="btn btn-primary" type="button" onclick={go} disabled={busy}>
      {#if busy}<span class="loading loading-spinner loading-xs"></span>{/if}
      {t("wizard.driveGo")}
    </button>
  </div>
{/if}
