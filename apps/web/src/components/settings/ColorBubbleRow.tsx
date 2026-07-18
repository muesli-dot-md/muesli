// Shared row of round color swatches: a role="radiogroup" of 7 presets —
// arrow/Home/End move focus AND selection together, per the WAI-ARIA APG's
// "selection follows focus" radiogroup pattern — plus an 8th "custom" bubble
// backed by the native color picker, which lives OUTSIDE that radiogroup as
// its own toggle button (aria-pressed), since it has no fixed hue of its own
// to be "checked" against. Used by both the tint-hue and folder-color rows in
// PreferencesSection so the two pickers share one implementation.
// Presentational + a thin hue<->hex bridge (services/colorBubbles) —
// persistence lives in the caller's store. Adapted from the desktop
// ColorBubbleRow.tsx (itself the React port of the web Svelte original).
import { useEffect, useRef, useState } from "react";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  findPresetIndex,
  hexToHue,
  hueToHex,
  matchesPreset,
  swatchColor,
  type HuePreset,
} from "@/services/colorBubbles";

interface Props {
  /** The preset bubbles, in display order (first is conventionally the default). */
  presets: HuePreset[];
  /** Current hue (0–360). Highlights whichever bubble matches, else the custom one. */
  hue: number;
  /** Called with the newly chosen hue — preset click, arrow-key nav, or the color picker. */
  onSelect: (hue: number) => void;
  /** Accessible name for the row as a whole, e.g. "Tint hue" or "Icon hue". */
  groupLabel: string;
  customLabel?: string;
  disabled?: boolean;
  /** Override the fixed lightness/chroma every bubble in this row swatches at
   * (defaults to colorBubbles' SWATCH_L/SWATCH_C). The Tint hue row passes
   * TINT_SWATCH_L/TINT_SWATCH_C so its swatches read closer to the pale wash
   * the tint actually applies. */
  swatchL?: number;
  swatchC?: number;
}

/** Always-visible 1px boundary so every swatch has a legible edge even when
 * unselected and its fill sits close to the card background (WCAG 1.4.11). */
const BOUNDARY_BORDER = "1px solid color-mix(in oklch, var(--foreground) 50%, transparent)";

export function ColorBubbleRow({
  presets,
  hue,
  onSelect,
  groupLabel,
  customLabel = "Custom color",
  disabled = false,
  swatchL,
  swatchC,
}: Props) {
  // A rainbow ring stands in for "no custom color chosen yet" — the bubble
  // reads as an open-ended color well until it holds an actual pick.
  const customRing = `conic-gradient(from 180deg, ${[0, 60, 120, 180, 240, 300, 360]
    .map((h) => swatchColor(h, swatchL, swatchC))
    .join(", ")})`;

  const isCustom = !matchesPreset(hue, presets);
  // Routed through findPresetIndex so this can never disagree with
  // matchesPreset about which bubble is "checked". -1 when `hue` reads as
  // custom, meaning every preset radio reports aria-checked="false".
  const checkedIndex = findPresetIndex(hue, presets);

  const bubbleRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const colorInputRef = useRef<HTMLInputElement | null>(null);

  // Roving tabindex — scoped to the preset bubbles only; the custom bubble is
  // a plain sibling <button> with its own ordinary tab stop. The single
  // Tab-reachable preset follows whichever bubble last received actual DOM
  // focus or, failing that, whichever preset is checked (falling back to the
  // first preset when none is).
  const [focusedIndex, setFocusedIndex] = useState(
    checkedIndex !== -1 ? checkedIndex : 0,
  );

  // Keeps the roving tabindex on the checked preset whenever `hue` changes
  // from OUTSIDE this component's own arrow-key/click handling — e.g. a
  // "Reset to default" button changing the bound `hue` prop directly.
  useEffect(() => {
    if (checkedIndex !== -1) setFocusedIndex(checkedIndex);
  }, [checkedIndex]);

  function focusBubble(i: number) {
    const idx = (i + presets.length) % presets.length;
    bubbleRefs.current[idx]?.focus();
    // WAI-ARIA radiogroup semantics: arrow keys change the checked value
    // immediately, not just focus (selection follows focus).
    onSelect(presets[idx].hue);
  }

  function onKeyDown(e: React.KeyboardEvent, i: number) {
    if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      e.preventDefault();
      focusBubble(i + 1);
    } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      e.preventDefault();
      focusBubble(i - 1);
    } else if (e.key === "Home") {
      e.preventDefault();
      focusBubble(0);
    } else if (e.key === "End") {
      e.preventDefault();
      focusBubble(presets.length - 1);
    }
  }

  return (
    <div className={cn("flex flex-wrap gap-2.5", disabled && "opacity-40")}>
      {/* The presets only: pure radios, selection follows focus (WAI-ARIA
          APG). A REAL flex box, not display:contents — WebKit historically
          dropped explicit roles on boxless elements from the a11y tree. */}
      <div
        role="radiogroup"
        aria-label={groupLabel}
        className="flex flex-wrap gap-2.5"
      >
        {presets.map((preset, i) => {
          const checked = checkedIndex === i;
          return (
            <button
              key={preset.hue}
              ref={(el) => {
                bubbleRefs.current[i] = el;
              }}
              type="button"
              role="radio"
              aria-checked={checked}
              aria-label={preset.label}
              title={preset.label}
              disabled={disabled}
              tabIndex={focusedIndex === i ? 0 : -1}
              className={cn(
                "relative h-7 w-7 shrink-0 rounded-full ring-2 ring-offset-2 ring-offset-background transition-shadow active:translate-y-px",
                checked
                  ? "ring-primary"
                  : "ring-transparent hover:ring-surface-border",
              )}
              style={{
                background: swatchColor(preset.hue, swatchL, swatchC),
                border: BOUNDARY_BORDER,
              }}
              onClick={() => onSelect(preset.hue)}
              onKeyDown={(e) => onKeyDown(e, i)}
              onFocus={() => setFocusedIndex(i)}
            >
              {checked ? (
                <Check
                  className="pointer-events-none absolute inset-0 m-auto size-3.5 text-white drop-shadow"
                  aria-hidden="true"
                />
              ) : null}
            </button>
          );
        })}
      </div>

      {/* Custom bubble: a sibling of the radiogroup — a plain pressed/
          unpressed toggle button that opens the native color picker (a
          visually-hidden input[type=color]) so the OS-native swatch/
          eyedropper affordances come for free. */}
      <button
        type="button"
        aria-pressed={isCustom}
        aria-label={customLabel}
        title={`${customLabel}…`}
        disabled={disabled}
        className={cn(
          "relative h-7 w-7 shrink-0 rounded-full ring-2 ring-offset-2 ring-offset-background transition-shadow active:translate-y-px",
          isCustom ? "ring-primary" : "ring-transparent hover:ring-surface-border",
        )}
        style={{
          background: isCustom ? swatchColor(hue, swatchL, swatchC) : customRing,
          border: BOUNDARY_BORDER,
        }}
        onClick={() => colorInputRef.current?.click()}
      >
        {isCustom ? (
          <Check
            className="pointer-events-none absolute inset-0 m-auto size-3.5 text-white drop-shadow"
            aria-hidden="true"
          />
        ) : null}
      </button>
      <input
        ref={colorInputRef}
        type="color"
        className="sr-only"
        tabIndex={-1}
        disabled={disabled}
        value={hueToHex(hue, swatchL, swatchC)}
        onChange={(e) => onSelect(hexToHue(e.currentTarget.value))}
        aria-hidden="true"
      />
    </div>
  );
}

export default ColorBubbleRow;
