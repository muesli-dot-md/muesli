// @vitest-environment jsdom
// The .svelte.test.ts name is load-bearing: it routes this file through the
// Svelte compiler so the last test can hold its props in $state and mutate
// them in place, exercising the component's real $effect resync path.
// Invariant (round-2 a11y review): the 7 preset bubbles are a pure
// WAI-ARIA radiogroup — arrow keys move focus AND selection together
// ("selection follows focus") — while the custom bubble is a separate
// toggle button that lives OUTSIDE that radiogroup, entirely decoupled from
// its roving tabindex. Previously the custom bubble was an 8th `role="radio"`
// member of the same group, so arrowing onto it moved focus without
// changing aria-checked, leaving a focused radio reporting unchecked while a
// different radio still reported checked. This must never be possible: a
// preset radio's aria-checked and the custom button's aria-pressed can never
// both read "the other one is selected" at the same time.
import { describe, it, expect, afterEach, vi } from "vitest";
import { mount, unmount, flushSync } from "svelte";
import ColorBubbleRow from "./ColorBubbleRow.svelte";
import type { HuePreset } from "../colorBubbles";

// A small palette local to this test, decoupled from the real TINT/FOLDER
// hues in colorBubbles.ts so retuning those palettes can never break this
// structural/keyboard test.
const presets: HuePreset[] = [
  { hue: 10, label: "Red" },
  { hue: 100, label: "Green" },
  { hue: 220, label: "Blue" },
];

let host: HTMLElement | undefined;
let component: ReturnType<typeof mount> | undefined;

afterEach(() => {
  if (component) unmount(component);
  host?.remove();
  component = undefined;
  host = undefined;
});

function render(hue: number, onSelect: (hue: number) => void) {
  host = document.createElement("div");
  document.body.appendChild(host);
  component = mount(ColorBubbleRow, {
    target: host,
    props: { presets, hue, onSelect, groupLabel: "Test hue" },
  });
  flushSync();
  return host;
}

describe("ColorBubbleRow", () => {
  it("moves focus and selection together between presets on ArrowRight", () => {
    const onSelect = vi.fn();
    const el = render(presets[0].hue, onSelect);
    const radios = [...el.querySelectorAll('[role="radio"]')] as HTMLButtonElement[];
    expect(radios).toHaveLength(presets.length);

    radios[0].focus();
    radios[0].dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }),
    );
    flushSync();

    // Selection moved with focus, in the same keypress — not just DOM focus
    // alone (WAI-ARIA APG radiogroup "selection follows focus").
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(presets[1].hue);
    expect(document.activeElement).toBe(radios[1]);
    expect(radios[1].tabIndex).toBe(0);
    expect(radios[0].tabIndex).toBe(-1);
  });

  it("wraps ArrowRight from the last preset to the first, skipping the custom bubble", () => {
    const onSelect = vi.fn();
    const el = render(presets[presets.length - 1].hue, onSelect);
    const radios = [...el.querySelectorAll('[role="radio"]')] as HTMLButtonElement[];

    radios[presets.length - 1].focus();
    radios[presets.length - 1].dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }),
    );
    flushSync();

    // Wraps to preset 0 — never onto the custom button, which is not a group
    // member and must be unreachable by arrow navigation.
    expect(onSelect).toHaveBeenCalledWith(presets[0].hue);
    expect(document.activeElement).toBe(radios[0]);
    expect(radios[0].tabIndex).toBe(0);
  });

  it("wraps Home/End to the first/last preset without touching the custom bubble", () => {
    const onSelect = vi.fn();
    const el = render(presets[1].hue, onSelect);
    const radios = [...el.querySelectorAll('[role="radio"]')] as HTMLButtonElement[];

    radios[1].focus();
    radios[1].dispatchEvent(
      new KeyboardEvent("keydown", { key: "End", bubbles: true, cancelable: true }),
    );
    flushSync();
    expect(onSelect).toHaveBeenLastCalledWith(presets[presets.length - 1].hue);
    expect(document.activeElement).toBe(radios[radios.length - 1]);

    radios[radios.length - 1].dispatchEvent(
      new KeyboardEvent("keydown", { key: "Home", bubbles: true, cancelable: true }),
    );
    flushSync();
    expect(onSelect).toHaveBeenLastCalledWith(presets[0].hue);
    expect(document.activeElement).toBe(radios[0]);
  });

  it("keeps the custom bubble outside the radiogroup and toggles its aria-pressed independently", () => {
    // hue matches a preset: exactly one radio checked, custom button unpressed.
    let el = render(presets[0].hue, vi.fn());
    let group = el.querySelector('[role="radiogroup"]');
    expect(group).not.toBeNull();
    let radios = [...group!.querySelectorAll('[role="radio"]')];
    expect(radios).toHaveLength(presets.length);

    const buttons = [...el.querySelectorAll("button")];
    let customButton = buttons.find((b) => !group!.contains(b));
    expect(customButton).toBeDefined();
    expect(customButton!.getAttribute("role")).toBeNull();
    expect(customButton!.getAttribute("aria-pressed")).toBe("false");
    expect(radios.filter((r) => r.getAttribute("aria-checked") === "true")).toHaveLength(1);

    if (component) unmount(component);
    host?.remove();

    // hue reads as custom (55 matches none of 10/100/220): every preset
    // radio reports unchecked, and only the custom button reports pressed —
    // these two states can never contradict each other.
    el = render(55, vi.fn());
    group = el.querySelector('[role="radiogroup"]');
    radios = [...group!.querySelectorAll('[role="radio"]')];
    customButton = [...el.querySelectorAll("button")].find((b) => !group!.contains(b));
    expect(customButton!.getAttribute("aria-pressed")).toBe("true");
    expect(radios.every((r) => r.getAttribute("aria-checked") === "false")).toBe(true);
  });

  it("syncs the roving tabindex to the checked preset when hue changes externally (e.g. Reset to default)", () => {
    const onSelect = vi.fn();
    // Starts on a custom hue (no preset checked, tabindex defaults to the
    // first preset). The props live in $state so the "Reset to default"
    // below is a REAL in-place prop mutation on the mounted component —
    // the $effect resync path itself, not a remount.
    const props = $state({ presets, hue: 55, onSelect, groupLabel: "Test hue" });
    host = document.createElement("div");
    document.body.appendChild(host);
    component = mount(ColorBubbleRow, { target: host, props });
    flushSync();
    const radios = [...host.querySelectorAll('[role="radio"]')] as HTMLButtonElement[];
    expect(radios[0].tabIndex).toBe(0);

    // External reset: the bound hue prop jumps straight to a preset — the
    // roving tabindex must land on that preset, not stay on the first one.
    props.hue = presets[2].hue;
    flushSync();
    expect(radios[2].getAttribute("aria-checked")).toBe("true");
    expect(radios[2].tabIndex).toBe(0);
    expect(radios[0].tabIndex).toBe(-1);
  });
});
