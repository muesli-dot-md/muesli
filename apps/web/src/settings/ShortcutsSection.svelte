<script lang="ts">
  // Settings → Keyboard shortcuts (settings.md §2.5): a static, read-only
  // reference hand-maintained next to the actual bindings (SearchPalette's
  // global keys, Editor.svelte's markKey/CodeMirror defaults, the comment
  // composer). Mod renders as ⌘ on Apple platforms, Ctrl elsewhere.
  import { t, type MessageKey } from "../i18n/index.svelte";
  import SettingRow from "./SettingRow.svelte";
  import SettingsCard from "./SettingsCard.svelte";

  const isMac = /Mac|iPhone|iPad/.test(
    typeof navigator === "undefined" ? "" : navigator.platform,
  );
  const mod = isMac ? "⌘" : "Ctrl";
  const shift = isMac ? "⇧" : "Shift";

  const groups: { titleKey: MessageKey; rows: { labelKey: MessageKey; keys: string[] }[] }[] = [
    {
      titleKey: "settings.shortcuts.navigation",
      rows: [
        { labelKey: "settings.shortcuts.search", keys: [mod, "K"] },
        { labelKey: "settings.shortcuts.searchAlt", keys: ["/"] },
        { labelKey: "settings.shortcuts.closeDialogs", keys: ["Esc"] },
      ],
    },
    {
      titleKey: "settings.shortcuts.editor",
      rows: [
        { labelKey: "settings.shortcuts.bold", keys: [mod, "B"] },
        { labelKey: "settings.shortcuts.italic", keys: [mod, "I"] },
        { labelKey: "settings.shortcuts.undo", keys: [mod, "Z"] },
        { labelKey: "settings.shortcuts.redo", keys: [mod, shift, "Z"] },
        { labelKey: "settings.shortcuts.indent", keys: ["Tab"] },
        { labelKey: "settings.shortcuts.submitComment", keys: [mod, "Enter"] },
      ],
    },
  ];
</script>

<header class="mb-5">
  <h2 class="text-lg font-semibold tracking-tight">{t("settings.nav.shortcuts")}</h2>
</header>

{#each groups as group (group.titleKey)}
  <SettingsCard heading={t(group.titleKey)}>
    {#each group.rows as row (row.labelKey)}
      <SettingRow title={t(row.labelKey)}>
        {#snippet control()}
          {#each row.keys as key, i (i)}
            <kbd class="kbd kbd-sm">{key}</kbd>
          {/each}
        {/snippet}
      </SettingRow>
    {/each}
  </SettingsCard>
{/each}
