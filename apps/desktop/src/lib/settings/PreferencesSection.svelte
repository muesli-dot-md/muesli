<script lang="ts">
  // Settings → Preferences (My Account): the desktop's per-machine look & feel —
  // a Multica-style Theme card (Light/Dark/System preview cards) plus the window
  // background floor controls (translucency / tint / hue). All localStorage, no
  // API. Mirrors the webapp's Preferences page chrome; the desktop has no accent
  // picker / default-view / language, so those are omitted. Literal strings (no
  // i18n). Folds in the former AppearanceSection's background block.
  import { background } from "$lib/background.svelte";
  import SettingsCard from "./SettingsCard.svelte";
  import SettingRow from "./SettingRow.svelte";
  import ThemePreviewCards from "./ThemePreviewCards.svelte";
</script>

<header class="mb-5">
  <h2 class="text-lg font-semibold tracking-tight">Preferences</h2>
  <p class="mt-1 text-sm text-[var(--text-muted)]" style="text-wrap: pretty;">
    Theme and window background. Saved on this machine only.
  </p>
</header>

<!-- Theme card: Multica-style preview cards -->
<SettingsCard heading="Theme">
  <div class="px-5 py-4">
    <ThemePreviewCards />
  </div>
</SettingsCard>

<!-- Background floor controls -->
<SettingsCard
  heading="Background"
  description="Translucency lets the desktop show through the window floor; tint adds a subtle color wash."
>
  <SettingRow title="Translucency" stacked>
    {#snippet control()}
      <div class="w-full">
        <div class="mb-1.5 flex items-center justify-end">
          <span class="text-xs text-[var(--text-muted)] tabular-nums"
            >{background.translucency}%</span
          >
        </div>
        <input
          type="range"
          min="0"
          max="100"
          class="range range-xs range-primary w-full"
          value={background.translucency}
          oninput={(e) => (background.translucency = +e.currentTarget.value)}
          aria-label="Background translucency"
        />
      </div>
    {/snippet}
  </SettingRow>

  <SettingRow title="Tint strength" stacked>
    {#snippet control()}
      <div class="w-full">
        <div class="mb-1.5 flex items-center justify-end">
          <span class="text-xs text-[var(--text-muted)] tabular-nums">{background.tint}%</span>
        </div>
        <input
          type="range"
          min="0"
          max="100"
          class="range range-xs range-primary w-full"
          value={background.tint}
          oninput={(e) => (background.tint = +e.currentTarget.value)}
          aria-label="Tint strength"
        />
      </div>
    {/snippet}
  </SettingRow>

  <SettingRow title="Tint hue" stacked>
    {#snippet control()}
      <div class="w-full" class:opacity-40={background.tint === 0}>
        <div class="mb-1.5 flex items-center justify-end">
          <span
            class="inline-block h-4 w-4 rounded-full border border-base-300"
            style="background: oklch(0.7 0.16 {background.hue});"
          ></span>
        </div>
        <input
          type="range"
          min="0"
          max="360"
          class="range range-xs w-full"
          value={background.hue}
          oninput={(e) => (background.hue = +e.currentTarget.value)}
          disabled={background.tint === 0}
          aria-label="Tint hue"
        />
      </div>
    {/snippet}
  </SettingRow>

  <SettingRow
    title="Reset background"
    description="Restore translucency, tint, and hue to defaults."
  >
    {#snippet control()}
      <button class="btn btn-ghost btn-sm" onclick={() => background.reset()}
        >Reset to default</button
      >
    {/snippet}
  </SettingRow>
</SettingsCard>
