<script lang="ts">
  // Light / Dark / System segmented control bound to the theme store. Used in
  // the account dropdown and the Settings modal.
  import Monitor from "@lucide/svelte/icons/monitor";
  import Moon from "@lucide/svelte/icons/moon";
  import Sun from "@lucide/svelte/icons/sun";
  import { t, type MessageKey } from "./i18n/index.svelte";
  import { theme, type ThemeMode } from "./theme.svelte";

  const modes: { value: ThemeMode; labelKey: MessageKey; icon: typeof Sun }[] = [
    { value: "light", labelKey: "theme.light", icon: Sun },
    { value: "dark", labelKey: "theme.dark", icon: Moon },
    { value: "system", labelKey: "theme.system", icon: Monitor },
  ];
</script>

<div class="join w-full">
  {#each modes as m (m.value)}
    <button
      class="btn join-item btn-xs flex-1 gap-1 {theme.mode === m.value
        ? 'btn-active'
        : 'btn-ghost'}"
      title={t("theme.buttonTitle", { label: t(m.labelKey) })}
      onclick={() => (theme.mode = m.value)}
    >
      <m.icon class="h-3.5 w-3.5" aria-hidden="true" />
      {t(m.labelKey)}
    </button>
  {/each}
</div>
