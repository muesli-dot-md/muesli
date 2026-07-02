<script lang="ts">
  // One setting inside a SettingsCard: a title (+ optional description) on the
  // left, the control right-aligned. Rows stack with a hairline divider drawn by
  // the row's top border (the first row in a card has none). When `stacked` is
  // set the control drops to its own full-width line below the label — used by
  // wide forms (e.g. the server URL input). Presentational only. Desktop port of
  // apps/web/src/settings/SettingRow.svelte.
  import type { Snippet } from "svelte";

  let {
    title,
    description,
    stacked = false,
    leading,
    control,
    children,
  }: {
    title?: string;
    description?: string;
    /** Put the control on its own line under the label (wide forms). */
    stacked?: boolean;
    /** Optional leading icon/avatar snippet, vertically centered. */
    leading?: Snippet;
    /** The right-aligned (or, when stacked, below-the-label) control. */
    control?: Snippet;
    /** Free-form body when a row is more than a label+control. */
    children?: Snippet;
  } = $props();
</script>

<div
  class="border-t border-base-300/60 px-5 py-4 first:border-t-0 {stacked
    ? ''
    : 'flex flex-wrap items-center gap-x-4 gap-y-3'}"
>
  {#if leading}
    <div class="shrink-0">{@render leading()}</div>
  {/if}

  {#if title || description}
    <div class="min-w-0 flex-1">
      {#if title}
        <p class="text-sm font-medium">{title}</p>
      {/if}
      {#if description}
        <p class="mt-0.5 text-xs text-[var(--text-muted)]" style="text-wrap: pretty;">
          {description}
        </p>
      {/if}
    </div>
  {/if}

  {#if control}
    <div class="{stacked ? 'mt-3' : 'shrink-0'} flex items-center gap-2">
      {@render control()}
    </div>
  {/if}

  {#if children}
    {@render children()}
  {/if}
</div>
