// Light / Dark / System segmented control bound to the theme store. Used in
// the account dropdown (AccountMenu). Port of the web ThemeModeControl.svelte.
import { Monitor, Moon, Sun, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT, type MessageKey } from "@/state/i18n";
import { themeStore, useTheme, type ThemeMode } from "@/state/theme";

const MODES: { value: ThemeMode; labelKey: MessageKey; Icon: LucideIcon }[] = [
  { value: "light", labelKey: "theme.light", Icon: Sun },
  { value: "dark", labelKey: "theme.dark", Icon: Moon },
  { value: "system", labelKey: "theme.system", Icon: Monitor },
];

export function ThemeModeControl() {
  const t = useT();
  const mode = useTheme((s) => s.mode);

  return (
    <div className="flex w-full gap-1 rounded-lg bg-muted p-0.5">
      {MODES.map((m) => {
        const selected = mode === m.value;
        return (
          <button
            key={m.value}
            type="button"
            className={cn(
              "flex h-6 flex-1 items-center justify-center gap-1 rounded-[min(var(--radius-md),10px)] px-2 text-xs transition-colors active:translate-y-px",
              selected
                ? "bg-background font-medium text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
            aria-pressed={selected}
            title={t("theme.buttonTitle", { label: t(m.labelKey) })}
            onClick={() => themeStore.getState().setMode(m.value)}
          >
            <m.Icon className="size-3.5" aria-hidden="true" />
            {t(m.labelKey)}
          </button>
        );
      })}
    </div>
  );
}

export default ThemeModeControl;
