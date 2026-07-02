<script lang="ts">
  // Multica-style progress: a row of dots (filled done / filled+ring current /
  // hollow pending) + "Step N of M", then the serif headline and a plain lede.
  import type { WizardKey } from "./copy";

  let {
    stepIndex,
    totalSteps,
    title,
    body,
    t,
  }: {
    stepIndex: number;
    totalSteps: number;
    title: string;
    body?: string;
    t: (k: WizardKey, p?: Record<string, string | number>) => string;
  } = $props();
</script>

<div class="mb-5 flex flex-col gap-3">
  <div
    class="flex items-center gap-2"
    role="progressbar"
    aria-valuemin="1"
    aria-valuemax={totalSteps}
    aria-valuenow={stepIndex + 1}
    aria-label={t("wizard.stepOf", { n: stepIndex + 1, total: totalSteps })}
  >
    {#each Array(totalSteps) as _, i (i)}
      <span
        class="mws-dot {i < stepIndex
          ? 'bg-base-content'
          : i === stepIndex
            ? 'bg-base-content ring-2 ring-base-content/25 ring-offset-1'
            : 'border border-base-content/30'}"
      ></span>
    {/each}
    <span class="ml-1 text-xs text-base-content/60">
      {t("wizard.stepOf", { n: stepIndex + 1, total: totalSteps })}
    </span>
  </div>
  <h3 class="mws-headline">{title}</h3>
  {#if body}
    <p class="text-sm text-base-content/70" style="text-wrap: pretty;">{body}</p>
  {/if}
</div>
