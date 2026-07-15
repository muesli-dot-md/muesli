// @vitest-environment jsdom
// (the web accent.svelte.ts self-applies to document at import time)
//
// Pins web/desktop accent parity: the synced "accent" pref carries only an id,
// so the two apps' ACCENT_PRESETS must stay value-identical — a drift would
// render the same synced id as DIFFERENT colors per app. This test lives on
// the desktop side because importing across app boundaries makes vite resolve
// the other app's tsconfig: the desktop's extends ./.svelte-kit/tsconfig.json,
// which only exists after SvelteKit sync (this app's vitest runs the sveltekit
// plugin, which syncs; the web's does not), while the web's tsconfig is
// self-contained and safe to resolve from here.
import { describe, expect, it } from "vitest";
import { ACCENT_PRESETS as WEB_ACCENT_PRESETS } from "../../../web/src/accent.svelte";
import { en } from "../../../web/src/i18n/en";
import { ACCENT_LABELS, ACCENT_PRESETS } from "./accent.svelte";

describe("web/desktop accent parity", () => {
  it("ships identical ACCENT_PRESETS in both apps (ids, values, order)", () => {
    expect(ACCENT_PRESETS).toEqual(WEB_ACCENT_PRESETS);
  });

  it("this app's English labels equal the web's en locale strings for each preset", () => {
    for (const p of ACCENT_PRESETS) {
      expect(ACCENT_LABELS[p.id]).toBe(en[p.labelKey]);
    }
  });
});
