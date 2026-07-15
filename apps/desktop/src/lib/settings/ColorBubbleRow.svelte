<script lang="ts">
  // Shared row of round color swatches: a role="radiogroup" of 7 presets —
  // arrow/Home/End move focus AND selection together, per the WAI-ARIA APG's
  // "selection follows focus" radiogroup pattern — plus an 8th "custom"
  // bubble backed by the native color picker, which lives OUTSIDE that
  // radiogroup as its own toggle button (aria-pressed), since it has no
  // fixed hue of its own to be "checked" against — see the markup below.
  // Used by both the tint-hue and folder-color rows in
  // PreferencesSection.svelte so the two pickers share one implementation
  // instead of duplicated markup. Presentational + a thin hue<->hex bridge
  // (colorBubbles.ts) — persistence lives in the caller's store
  // (background.svelte.ts / folderColor.svelte.ts).
  import { Check } from "lucide-svelte";
  import {
    swatchColor,
    hueToHex,
    hexToHue,
    matchesPreset,
    findPresetIndex,
    type HuePreset,
  } from "$lib/colorBubbles";

  let {
    presets,
    hue,
    onSelect,
    groupLabel,
    customLabel = "Custom color",
    disabled = false,
    swatchL,
    swatchC,
  }: {
    /** The preset bubbles, in display order (first is conventionally the default). */
    presets: HuePreset[];
    /** Current hue (0–360). Highlights whichever bubble matches, else the custom one. */
    hue: number;
    /** Called with the newly chosen hue, from a preset click, arrow-key nav, or the color picker. */
    onSelect: (hue: number) => void;
    /** Accessible name for the row as a whole, e.g. "Tint hue" or "Folder color". */
    groupLabel: string;
    customLabel?: string;
    disabled?: boolean;
    /** Override the fixed lightness/chroma every bubble in this row swatches
     * at (defaults to colorBubbles.ts's SWATCH_L/SWATCH_C). The Tint hue row
     * passes TINT_SWATCH_L/TINT_SWATCH_C so its swatches read closer to the
     * pale wash the tint actually applies — see colorBubbles.ts. */
    swatchL?: number;
    swatchC?: number;
  } = $props();

  // A rainbow ring stands in for "no custom color chosen yet" — the bubble
  // reads as an open-ended color well until it holds an actual pick.
  const CUSTOM_RING = $derived(
    `conic-gradient(from 180deg, ${swatchColor(0, swatchL, swatchC)}, ${swatchColor(60, swatchL, swatchC)}, ${swatchColor(120, swatchL, swatchC)}, ${swatchColor(180, swatchL, swatchC)}, ${swatchColor(240, swatchL, swatchC)}, ${swatchColor(300, swatchL, swatchC)}, ${swatchColor(360, swatchL, swatchC)})`,
  );

  const isCustom = $derived(!matchesPreset(hue, presets));
  // Routed through findPresetIndex (colorBubbles.ts) rather than a local
  // `Math.abs(p.hue - hue) < <tolerance>` check, so this can never disagree
  // with matchesPreset about which bubble is "checked". -1 when `hue` reads
  // as custom, meaning every preset radio reports aria-checked="false" —
  // never checked at the same time the custom button reports aria-pressed
  // — these two states can't contradict each other. See isCustom above,
  // which drives the custom button's aria-pressed independently.
  const checkedIndex = $derived(findPresetIndex(hue, presets));

  let bubbles: (HTMLButtonElement | undefined)[] = $state([]);
  let colorInput: HTMLInputElement | undefined = $state(undefined);

  // Roving tabindex — scoped to the 7 preset bubbles only (role="radiogroup"
  // below); the custom bubble is a plain sibling <button> with its own
  // ordinary tab stop, not part of this group (see the markup). The single
  // Tab-reachable preset follows whichever bubble last received actual DOM
  // focus (arrow-key nav, Tab, or a mouse click — see the onfocus handlers
  // below) or, failing that, whichever preset is checked (falling back to
  // the first preset when none is — matching the WAI-ARIA APG's roving
  // tabindex pattern for a radiogroup with nothing checked yet).
  let focusedIndex = $state(0);

  // Keeps the roving tabindex on the checked preset whenever `hue` changes
  // from *outside* this component's own arrow-key/click handling — e.g. a
  // "Reset to default" button elsewhere in the page changing the bound
  // `hue` prop directly. Internal changes (focusBubble, a preset's onclick)
  // already set focusedIndex to the same value themselves, so this is a
  // harmless no-op re-assignment in that case; it only does real work for
  // externally-driven changes, and is a no-op while `hue` reads as custom
  // (checkedIndex === -1), leaving focusedIndex wherever it last was.
  $effect(() => {
    if (checkedIndex !== -1) {
      focusedIndex = checkedIndex;
    }
  });

  function focusBubble(i: number) {
    const idx = (i + presets.length) % presets.length;
    bubbles[idx]?.focus();
    // WAI-ARIA radiogroup semantics: arrow keys change the checked value
    // immediately, not just focus (selection follows focus).
    onSelect(presets[idx].hue);
  }

  // Roving-tabindex radiogroup: arrow keys move focus AND selection between
  // presets, Home/End jump to the ends — matches native <input type="radio">
  // group behavior instead of relying on Tab to reach every bubble.
  function onKeydown(e: KeyboardEvent, i: number) {
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

  function onFocusBubble(i: number) {
    focusedIndex = i;
  }

  function onColorInput(e: Event & { currentTarget: HTMLInputElement }) {
    onSelect(hexToHue(e.currentTarget.value));
  }
</script>

<div class="flex flex-wrap gap-2.5" class:opacity-40={disabled}>
  <!-- The 7 presets only: pure radios, selection follows focus (WAI-ARIA
       APG). The radiogroup is a REAL flex box, not display:contents — WebKit
       historically dropped explicit roles on boxless elements from the a11y
       tree, and this ships in whatever WKWebView the OS provides. Same gap as
       the outer row keeps the custom button visually in line. -->
  <div role="radiogroup" aria-label={groupLabel} class="flex flex-wrap gap-2.5">
    {#each presets as preset, i (preset.hue)}
      {@const checked = checkedIndex === i}
      <button
        bind:this={bubbles[i]}
        type="button"
        role="radio"
        aria-checked={checked}
        aria-label={preset.label}
        title={preset.label}
        {disabled}
        tabindex={focusedIndex === i ? 0 : -1}
        class="swatch-boundary arc-tap relative h-7 w-7 shrink-0 rounded-full ring-2 ring-offset-2 ring-offset-base-100 transition-shadow {checked
          ? 'ring-primary'
          : 'ring-transparent hover:ring-base-300'}"
        style="background: {swatchColor(preset.hue, swatchL, swatchC)};"
        onclick={() => onSelect(preset.hue)}
        onkeydown={(e) => onKeydown(e, i)}
        onfocus={() => onFocusBubble(i)}
      >
        {#if checked}
          <Check
            size={13}
            class="pointer-events-none absolute inset-0 m-auto text-white drop-shadow"
            aria-hidden="true"
          />
        {/if}
      </button>
    {/each}
  </div>

  <!-- Custom bubble: a sibling of the radiogroup, not a member of it — it has
       no fixed hue of its own to be "checked" against, so it's a plain
       pressed/unpressed toggle button (its own ordinary tab stop, not part
       of the group's roving tabindex) that opens the native color picker (a
       visually-hidden input[type=color]) rather than a bespoke popover, so
       the OS-native swatch/eyedropper affordances come for free. Native
       <button> already activates on Enter/Space, so onclick alone covers
       every activation path. -->
  <button
    type="button"
    aria-pressed={isCustom}
    aria-label={customLabel}
    title={`${customLabel}…`}
    {disabled}
    class="swatch-boundary arc-tap relative h-7 w-7 shrink-0 rounded-full ring-2 ring-offset-2 ring-offset-base-100 transition-shadow {isCustom
      ? 'ring-primary'
      : 'ring-transparent hover:ring-base-300'}"
    style="background: {isCustom ? swatchColor(hue, swatchL, swatchC) : CUSTOM_RING};"
    onclick={() => colorInput?.click()}
  >
    {#if isCustom}
      <Check
        size={13}
        class="pointer-events-none absolute inset-0 m-auto text-white drop-shadow"
        aria-hidden="true"
      />
    {/if}
  </button>
  <input
    bind:this={colorInput}
    type="color"
    class="sr-only"
    tabindex="-1"
    {disabled}
    value={hueToHex(hue, swatchL, swatchC)}
    oninput={onColorInput}
    aria-hidden="true"
  />
</div>

<style>
  /* Always-on 1px boundary so every swatch has a visible edge even when
     unselected (ring-transparent) and its fill sits close to the card's own
     background — e.g. the Tint row's pale L0.82/C0.09 swatches, which read
     at ~1.7:1 against a white card with no drawn edge otherwise, short of
     WCAG 1.4.11's 3:1 minimum for UI component boundaries. Mixed from
     --color-base-content (measured ~3.2:1 against light-theme base-100,
     ~4.4:1 in dark) so it auto-adapts between themes instead of a fixed
     gray; border-base-300 (this app's usual subtle-border token) was
     measured at only ~1.5:1 here and isn't strong enough on its own. This is
     a real border (box model), independent of the ring-* box-shadow above,
     so the selected state's ring-primary offset ring layers on top of it
     rather than replacing it. */
  .swatch-boundary {
    border: 1px solid color-mix(in oklch, var(--color-base-content) 50%, transparent);
  }
</style>
