// Settings → Appearance (My Account): the desktop's look & feel — a
// Multica-style Theme card (Light/Dark/System preview cards), the accent
// picker, the window background floor controls (translucency / tint / hue),
// and the file tree's folder icon color. All localStorage-backed;
// theme/accent/tint/folder-color additionally sync per-user through the
// server when signed in (state/prefsSync) — translucency stays machine-local.
import { Check } from "lucide-react";
import { Slider } from "@/components/ui/slider";
import { cn } from "@/lib/utils";
import {
  FOLDER_HUE_PRESETS,
  TINT_HUE_PRESETS,
  TINT_SWATCH_C,
  TINT_SWATCH_L,
} from "@/services/colorBubbles";
import { Button } from "@/components/ui/button";
import {
  ACCENT_LABELS,
  ACCENT_PRESETS,
  accentStore,
  useAccent,
  type AccentId,
} from "@/state/accent";
import { backgroundStore, useBackground } from "@/state/background";
import { folderColorStore, useFolderColor } from "@/state/folderColor";
import { prefsSync } from "@/state/prefsSync";
import { SettingsCard } from "./SettingsCard";
import { SettingsRow } from "./SettingsRow";
import { SettingsSection } from "./SettingsSection";
import { ThemePreviewCards } from "./ThemePreviewCards";
import { ColorBubbleRow } from "./ColorBubbleRow";

function sliderValue(v: number | readonly number[]): number {
  return Array.isArray(v) ? (v[0] ?? 0) : (v as number);
}

export function PreferencesSection() {
  const accentId = useAccent((s: { id: AccentId }) => s.id);
  const translucency = useBackground((s: { translucency: number }) => s.translucency);
  const tint = useBackground((s: { tint: number }) => s.tint);
  const bgHue = useBackground((s: { hue: number }) => s.hue);
  const folderHue = useFolderColor((s: { hue: number }) => s.hue);

  return (
    <SettingsSection
      title="Appearance"
      description="Theme, accent, window background, and file tree colors. Signed in, everything but translucency follows your account across apps; otherwise it stays on this machine."
    >
      {/* Theme card: Multica-style preview cards */}
      <SettingsCard heading="Theme">
        <div className="px-4 py-3.5">
          <ThemePreviewCards />
        </div>
      </SettingsCard>

      {/* Accent picker: same presets/swatches/selected state as the webapp.
          The default blue preset equals the stock brand primary, so nothing
          changes until the user picks. */}
      <SettingsCard>
        <SettingsRow
          title="Accent color"
          description="Used for buttons, links and selection."
          control={ACCENT_PRESETS.map((p) => {
            const selected = accentId === p.id;
            const label = ACCENT_LABELS[p.id];
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
      </SettingsCard>

      {/* Background floor controls */}
      <SettingsCard
        heading="Background"
        description="Translucency lets the desktop show through the window floor; tint adds a subtle color wash."
      >
        <SettingsRow
          title="Translucency"
          stacked
          control={
            <div className="w-full">
              <div className="mb-1.5 flex items-center justify-end">
                <span className="text-xs tabular-nums text-muted-foreground">{translucency}%</span>
              </div>
              <Slider
                min={0}
                max={100}
                value={translucency}
                onValueChange={(v: number | readonly number[]) =>
                  backgroundStore.getState().setTranslucency(sliderValue(v))
                }
                aria-label="Background translucency"
              />
            </div>
          }
        />

        <SettingsRow
          title="Tint strength"
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
                aria-label="Tint strength"
              />
            </div>
          }
        />

        <SettingsRow
          title="Tint hue"
          stacked
          control={
            <ColorBubbleRow
              presets={TINT_HUE_PRESETS}
              hue={bgHue}
              onSelect={(hue) => backgroundStore.getState().setHue(hue)}
              groupLabel="Tint hue"
              disabled={tint === 0}
              swatchL={TINT_SWATCH_L}
              swatchC={TINT_SWATCH_C}
            />
          }
        />

        <SettingsRow
          title="Reset background"
          description="Restore translucency, tint, and hue to defaults."
          control={
            // Routed through prefsSync so the synced keys are deleted
            // server-side (null), not written out as this app's defaults.
            <Button variant="ghost" size="sm" onClick={() => prefsSync.resetBackground()}>
              Reset to default
            </Button>
          }
        />
      </SettingsCard>

      {/* File tree folder icon color */}
      <SettingsCard heading="Folder color" description="Color of folder icons in the file tree.">
        <SettingsRow
          title="Icon hue"
          stacked
          control={
            <ColorBubbleRow
              presets={FOLDER_HUE_PRESETS}
              hue={folderHue}
              onSelect={(hue) => folderColorStore.getState().setHue(hue)}
              groupLabel="Icon hue"
            />
          }
        />

        <SettingsRow
          title="Reset folder color"
          description="Restore the default folder color."
          control={
            <Button variant="ghost" size="sm" onClick={() => prefsSync.resetFolderColor()}>
              Reset to default
            </Button>
          }
        />
      </SettingsCard>
    </SettingsSection>
  );
}
