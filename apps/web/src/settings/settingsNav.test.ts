// @vitest-environment jsdom
// route.svelte.ts reads location.hash + binds a hashchange listener at import,
// so this suite needs a DOM (the default node env throws "location is not defined").
import { afterEach, describe, expect, it } from "vitest";
import { route, settingsSections } from "../route.svelte";
import { ACCOUNT_ITEMS, WORKSPACE_ITEM, settingsNavItems } from "./settingsNav";

describe("settingsNav", () => {
  it("drops the workspace item in open mode / signed out", () => {
    expect(settingsNavItems(false)).toEqual(ACCOUNT_ITEMS);
    expect(settingsNavItems(false).map((i) => i.section)).not.toContain("workspace");
  });

  it("appends the single workspace item when a workspace is available", () => {
    const items = settingsNavItems(true);
    expect(items.slice(0, -1)).toEqual(ACCOUNT_ITEMS);
    expect(items.at(-1)).toEqual(WORKSPACE_ITEM);
  });

  it("puts Profile first in My Account (Multica order)", () => {
    expect(ACCOUNT_ITEMS[0].section).toBe("profile");
  });

  it("keeps Language directly after the Appearance page it was split from", () => {
    const sections = ACCOUNT_ITEMS.map((i) => i.section);
    expect(sections.indexOf("language")).toBe(sections.indexOf("preferences") + 1);
  });

  it("exposes exactly one workspace entry — General/Members merged into one page", () => {
    const sections = settingsNavItems(true).map((i) => i.section);
    expect(sections.filter((s) => s === "workspace")).toHaveLength(1);
    expect(sections).not.toContain("general");
    expect(sections).not.toContain("members");
  });

  it("references only real settings sections", () => {
    const valid = new Set<string>(settingsSections);
    for (const item of settingsNavItems(true)) {
      expect(valid.has(item.section)).toBe(true);
    }
  });
});

describe("settings section aliases", () => {
  afterEach(() => {
    // Leave the hash clean for whatever runs next in this environment.
    location.hash = "";
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });

  function parse(hash: string) {
    location.hash = hash;
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    return route.current;
  }

  it("deep-links the old general/members hashes into the workspace page", () => {
    expect(parse("#~settings/general")).toEqual({ kind: "settings", section: "workspace" });
    expect(parse("#~settings/members")).toEqual({ kind: "settings", section: "workspace" });
  });

  it("keeps the pre-Multica appearance hash pointing at preferences", () => {
    expect(parse("#~settings/appearance")).toEqual({ kind: "settings", section: "preferences" });
  });
});
