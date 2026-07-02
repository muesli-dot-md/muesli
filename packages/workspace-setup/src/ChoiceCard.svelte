<script lang="ts">
  // A Multica choice card: bordered resting state, border+inset-ring when
  // selected; the disabled variant is dashed, dimmed, non-interactive, with a
  // static uppercase badge ("COMING SOON").
  import type { Snippet } from "svelte";

  let {
    title,
    body,
    selected = false,
    disabled = false,
    badge,
    onclick,
    icon,
  }: {
    title: string;
    body: string;
    selected?: boolean;
    disabled?: boolean;
    badge?: string;
    onclick?: () => void;
    icon?: Snippet;
  } = $props();
</script>

{#if disabled}
  <div
    class="mws-card flex w-full items-start gap-3 border border-dashed border-base-content/25 p-3 opacity-70"
    aria-disabled="true"
  >
    {#if icon}{@render icon()}{/if}
    <div class="min-w-0 flex-1">
      <p class="text-sm font-medium">
        {title}
        {#if badge}
          <span
            class="ml-2 align-middle text-[10px] font-semibold uppercase tracking-wide text-base-content/50"
          >
            {badge}
          </span>
        {/if}
      </p>
      <p class="mt-0.5 text-xs text-base-content/60">{body}</p>
    </div>
  </div>
{:else}
  <button
    type="button"
    class="mws-card flex w-full cursor-pointer items-start gap-3 border p-3 hover:border-base-content
      {selected ? 'border-base-content' : 'border-base-300'}"
    data-selected={selected}
    {onclick}
  >
    {#if icon}{@render icon()}{/if}
    <div class="min-w-0 flex-1">
      <p class="text-sm font-medium">{title}</p>
      <p class="mt-0.5 text-xs text-base-content/60">{body}</p>
    </div>
  </button>
{/if}
