// Settings → Appearance (né Preferences): a Multica-style Theme card
// (Light/Dark/System preview cards), the accent picker, the background tint
// and folder-color controls (same palettes/ColorBubbleRow as the desktop,
// minus its window translucency), and the default home view. Everything is
// localStorage-backed; theme/accent/tint/folder-color additionally sync
// per-user through the server when signed in (state/prefsSync). React port of
// the web settings/PreferencesSection.svelte, adapted from the desktop
// PreferencesSection.tsx and re-threaded through the web i18n keys.
import { Check, Grid2x2, List, ListTree, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { cn } from "@/lib/utils";
import {
  FOLDER_HUE_PRESETS,
  TINT_HUE_PRESETS,
  TINT_SWATCH_C,
  TINT_SWATCH_L,
} from "@/services/colorBubbles";
import { ACCENT_PRESETS, accentStore, useAccent } from "@/state/accent";
import { backgroundStore, useBackground } from "@/state/background";
import { folderColorStore, useFolderColor } from "@/state/folderColor";
import { useT, type MessageKey } from "@/state/i18n";
import { prefsStore, usePrefs, type HomeView } from "@/state/prefs";
import { prefsSync } from "@/state/prefsSync";
import { ColorBubbleRow } from "./ColorBubbleRow";
import { SettingsCard } from "./SettingsCard";
import { SettingsRow } from "./SettingsRow";
import { ThemePreviewCards } from "./ThemePreviewCards";

const VIEW_OPTIONS: { value: HomeView; labelKey: MessageKey; Icon: LucideIcon }[] = [
  { value: "list", labelKey: "settings.list", Icon: List },
  { value: "grid", labelKey: "settings.grid", Icon: Grid2x2 },
  { value: "tree", labelKey: "settings.tree", Icon: ListTree },
];

function sliderValue(v: number | readonly number[]): number {
  return Array.isArray(v) ? (v[0] ?? 0) : (v as number);
}

export function PreferencesSection() {
  const t = useT();
  const accentId = useAccent((s) => s.id);
  const tint = useBackground((s) => s.tint);
  const bgHue = useBackground((s) => s.hue);
  const folderHue = useFolderColor((s) => s.hue);
  const homeView = usePrefs((s) => s.homeView);

  return (
    <>
      <header className="mb-5">
        <h2 className="text-lg font-semibold tracking-tight">{t("settings.nav.preferences")}</h2>
        <p className="mt-1 text-sm text-muted-foreground [text-wrap:pretty]">
          {t("settings.appearance.perBrowser")}
        </p>
      </header>

      {/* Theme card: Multica-style preview cards */}
      <SettingsCard heading={t("settings.theme")}>
        <div className="px-4 py-3.5">
          <ThemePreviewCards />
          <p className="mt-3 text-xs text-muted-foreground [text-wrap:pretty]">
            {t("settings.appearance.motionNote")}
          </p>
        </div>
      </SettingsCard>

      {/* Accent + default view */}
      <SettingsCard>
        <SettingsRow
          title={t("settings.accent")}
          description={t("settings.accent.hint")}
          control={ACCENT_PRESETS.map((p) => {
            const selected = accentId === p.id;
            // The web accent presets are labeled through i18n; the key is
            // derived from the stable preset id (settings.accent.<id>).
            const label = t(`settings.accent.${p.id}` as MessageKey);
            return (
              <button
                key={p.id}
                type="button"
                className={cn(
                  "flex h-8 w-8 items-center justify-center rounded-full transition-transform active:translate-y-px",
                  selected
                    ? "ring-2 ring-foreground/40 ring-offset-2 ring-offset-background"
                    : "hover:scale-105",
                )}
                style={{ backgroundColor: p.light }}
                title={label}
                aria-label={label}
                aria-pressed={selected}
                onClick={() => accentStore.getState().setId(p.id)}
              >
                {selected ? (
                  <Check className="size-4" style={{ color: p.lightContent }} aria-hidden="true" />
                ) : null}
              </button>
            );
          })}
        />

        <SettingsRow
          title={t("settings.defaultView")}
          description={t("settings.defaultView.hint")}
          control={
            <div className="flex gap-1 rounded-lg bg-muted p-0.5">
              {VIEW_OPTIONS.map((v) => {
                const selected = homeView === v.value;
                return (
                  <button
                    key={v.value}
                    type="button"
                    className={cn(
                      "flex h-7 items-center gap-1 rounded-[min(var(--radius-md),12px)] px-2.5 text-[0.8rem] transition-colors active:translate-y-px",
                      selected
                        ? "bg-background font-medium text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                    aria-pressed={selected}
                    onClick={() => prefsStore.getState().setHomeView(v.value)}
                  >
                    <v.Icon className="size-3.5" aria-hidden="true" />
                    {t(v.labelKey)}
                  </button>
                );
              })}
            </div>
          }
        />
      </SettingsCard>

      {/* Background tint: the desktop's floor controls, minus its window
          translucency (no web counterpart) — the wash lands flat on the page
          floor. */}
      <SettingsCard heading={t("settings.background")} description={t("settings.background.hint")}>
        <SettingsRow
          title={t("settings.background.tintStrength")}
          stacked
          control={
            <div className="w-full">
              <div className="mb-1.5 flex items-center justify-end">
                <span className="text-xs tabular-nums text-muted-foreground">{tint}%</span>
              </div>
              <Slider
                min={0}
                max={100}
                value={tint}
                onValueChange={(v: number | readonly number[]) =>
                  backgroundStore.getState().setTint(sliderValue(v))
                }
                aria-label={t("settings.background.tintStrength")}
              />
            </div>
          }
        />

        <SettingsRow
          title={t("settings.background.tintHue")}
          stacked
          control={
            <ColorBubbleRow
              presets={TINT_HUE_PRESETS}
              hue={bgHue}
              onSelect={(hue) => backgroundStore.getState().setHue(hue)}
              groupLabel={t("settings.background.tintHue")}
              customLabel={t("settings.customColor")}
              disabled={tint === 0}
              swatchL={TINT_SWATCH_L}
              swatchC={TINT_SWATCH_C}
            />
          }
        />

        <SettingsRow
          title={t("settings.background.reset")}
          description={t("settings.background.reset.hint")}
          control={
            // Routed through prefsSync so the synced keys are deleted
            // server-side (null), not written out as this app's defaults.
            <Button variant="ghost" size="sm" onClick={() => prefsSync.resetBackground()}>
              {t("settings.resetToDefault")}
            </Button>
          }
        />
      </SettingsCard>

      {/* File tree folder icon color */}
      <SettingsCard
        heading={t("settings.folderColor")}
        description={t("settings.folderColor.hint")}
      >
        <SettingsRow
          title={t("settings.folderColor.iconHue")}
          stacked
          control={
            <ColorBubbleRow
              presets={FOLDER_HUE_PRESETS}
              hue={folderHue}
              onSelect={(hue) => folderColorStore.getState().setHue(hue)}
              groupLabel={t("settings.folderColor.iconHue")}
              customLabel={t("settings.customColor")}
            />
          }
        />

        <SettingsRow
          title={t("settings.folderColor.reset")}
          description={t("settings.folderColor.reset.hint")}
          control={
            <Button variant="ghost" size="sm" onClick={() => prefsSync.resetFolderColor()}>
              {t("settings.resetToDefault")}
            </Button>
          }
        />
      </SettingsCard>
    </>
  );
}

export default PreferencesSection;
