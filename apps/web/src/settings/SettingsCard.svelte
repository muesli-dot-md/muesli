<script lang="ts">
  // A card surface for the two-pane settings layout (Obsidian-style): a soft
  // --shadow-card panel that hosts SettingRow children divided by hairlines.
  // An optional small-caps heading sits ABOVE the card (a section label), and
  // an optional description sits under it. `tone="danger"` tints the surface
  // for the profile danger zone. Purely presentational — no logic.
  import type { Snippet } from "svelte";

  let {
    heading,
    description,
    tone = "default",
    children,
  }: {
    heading?: string;
    description?: string;
    tone?: "default" | "danger";
    children: Snippet;
  } = $props();
</script>

<section class="mt-6 first:mt-0">
  {#if heading}
    <h3
      class="mb-2 px-1 text-xs font-semibold uppercase tracking-wide {tone === 'danger'
        ? 'text-error'
        : 'text-[var(--text-muted)]'}"
    >
      {heading}
    </h3>
  {/if}
  {#if description}
    <p class="mb-2 px-1 text-xs text-[var(--text-muted)]" style="text-wrap: pretty;">
      {description}
    </p>
  {/if}
  <div
    class="overflow-hidden rounded-box bg-base-100 {tone === 'danger'
      ? 'ring-1 ring-error/25'
      : ''}"
    style="box-shadow: var(--shadow-card);"
  >
    {@render children()}
  </div>
</section>
