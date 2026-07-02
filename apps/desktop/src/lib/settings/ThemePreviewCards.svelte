<script lang="ts">
  // Multica-style Theme picker: three preview cards (Light / Dark / System) that
  // each paint a tiny mock window with a traffic-light dot row and skeleton lines,
  // tinted with the theme they represent. The System card splits diagonally to
  // hint "follows your OS". Bound to the desktop theme store. Desktop port of
  // apps/web/src/settings/ThemePreviewCards.svelte (literal strings, no i18n).
  import { Check } from "lucide-svelte";
  import { theme, type ThemeMode } from "$lib/theme.svelte";

  const modes: { value: ThemeMode; label: string }[] = [
    { value: "light", label: "Light" },
    { value: "dark", label: "Dark" },
    { value: "system", label: "System" },
  ];
</script>

{#snippet preview(kind: "light" | "dark")}
  {@const dark = kind === "dark"}
  <div
    class="flex h-full w-full flex-col gap-1.5 p-2"
    style="background: {dark ? 'oklch(0.21 0.004 285)' : 'oklch(0.985 0 0)'};"
  >
    <div class="flex gap-1">
      <span class="h-1.5 w-1.5 rounded-full" style="background: oklch(0.7 0.16 25);"></span>
      <span class="h-1.5 w-1.5 rounded-full" style="background: oklch(0.82 0.15 85);"></span>
      <span class="h-1.5 w-1.5 rounded-full" style="background: oklch(0.78 0.16 145);"></span>
    </div>
    <div class="flex flex-1 gap-1.5">
      <div
        class="w-1/3 rounded-sm"
        style="background: {dark ? 'oklch(0.28 0.004 285)' : 'oklch(0.93 0 0)'};"
      ></div>
      <div class="flex flex-1 flex-col gap-1 pt-0.5">
        {#each [0.9, 0.7, 0.8] as w, i (i)}
          <div
            class="h-1 rounded-full"
            style="width: {w * 100}%; background: {dark
              ? 'oklch(0.42 0.004 285)'
              : 'oklch(0.85 0 0)'};"
          ></div>
        {/each}
      </div>
    </div>
  </div>
{/snippet}

<div class="grid grid-cols-3 gap-3">
  {#each modes as m (m.value)}
    {@const selected = theme.mode === m.value}
    <button
      class="arc-tap group flex flex-col gap-2 rounded-box p-1.5 text-left transition-[box-shadow,transform]
        {selected ? '' : 'hover:bg-[var(--row-hover)]'}"
      style={selected ? "box-shadow: var(--shadow-lift); background: var(--lift);" : ""}
      aria-pressed={selected}
      onclick={() => theme.setMode(m.value)}
    >
      <div
        class="relative aspect-[4/3] w-full overflow-hidden rounded-field ring-1 {selected
          ? 'ring-primary'
          : 'ring-base-300'}"
      >
        {#if m.value === "system"}
          <!-- diagonal split: light top-left, dark bottom-right -->
          <div class="absolute inset-0" style="clip-path: polygon(0 0, 100% 0, 0 100%);">
            {@render preview("light")}
          </div>
          <div class="absolute inset-0" style="clip-path: polygon(100% 0, 100% 100%, 0 100%);">
            {@render preview("dark")}
          </div>
        {:else}
          {@render preview(m.value)}
        {/if}
        {#if selected}
          <span
            class="absolute right-1.5 top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-primary text-primary-content shadow"
          >
            <Check size={10} aria-hidden="true" />
          </span>
        {/if}
      </div>
      <span
        class="px-1 text-center text-xs font-medium {selected
          ? 'text-base-content'
          : 'text-[var(--text-muted)]'}"
      >
        {m.label}
      </span>
    </button>
  {/each}
</div>
