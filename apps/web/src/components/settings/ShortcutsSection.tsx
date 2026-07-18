// Settings → Keyboard shortcuts (settings.md §2.5): a static, read-only
// reference hand-maintained next to the actual bindings (SearchPalette's
// global keys, the editor's markKey/CodeMirror defaults, the comment
// composer). Mod renders as ⌘ on Apple platforms, Ctrl elsewhere. React port
// of the web settings/ShortcutsSection.svelte.
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { useT, type MessageKey } from "@/state/i18n";
import { SettingsCard } from "./SettingsCard";
import { SettingsRow } from "./SettingsRow";

const isMac = /Mac|iPhone|iPad/.test(typeof navigator === "undefined" ? "" : navigator.platform);
const mod = isMac ? "⌘" : "Ctrl";
const shift = isMac ? "⇧" : "Shift";

const GROUPS: {
  titleKey: MessageKey;
  rows: { labelKey: MessageKey; keys: string[] }[];
}[] = [
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

export function ShortcutsSection() {
  const t = useT();

  return (
    <>
      <header className="mb-5">
        <h2 className="text-lg font-semibold tracking-tight">{t("settings.nav.shortcuts")}</h2>
      </header>

      {GROUPS.map((group) => (
        <SettingsCard key={group.titleKey} heading={t(group.titleKey)}>
          {group.rows.map((row) => (
            <SettingsRow
              key={row.labelKey}
              title={t(row.labelKey)}
              control={
                <KbdGroup>
                  {row.keys.map((key, i) => (
                    <Kbd key={i}>{key}</Kbd>
                  ))}
                </KbdGroup>
              }
            />
          ))}
        </SettingsCard>
      ))}
    </>
  );
}

export default ShortcutsSection;
