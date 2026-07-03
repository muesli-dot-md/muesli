// @vitest-environment jsdom
// route.svelte.ts reads location.hash + binds a hashchange listener at import,
// so this suite needs a DOM (the default node env throws "location is not defined").
import { describe, expect, it } from "vitest";
import { settingsSections } from "../route.svelte";
import {
  ACCOUNT_GROUP,
  WORKSPACE_GROUP,
  groupForSection,
  settingsNavGroups,
  settingsNavItems,
} from "./settingsNav";

describe("settingsNav", () => {
  it("drops the workspace group in open mode / signed out", () => {
    expect(settingsNavGroups(false)).toEqual([ACCOUNT_GROUP]);
    expect(settingsNavGroups(false).map((g) => g.id)).toEqual(["account"]);
  });

  it("shows account then workspace when a workspace is available", () => {
    expect(settingsNavGroups(true).map((g) => g.id)).toEqual([
      "account",
      "workspace",
    ]);
  });

  it("puts Profile first in My Account (Multica order)", () => {
    expect(ACCOUNT_GROUP.items[0].section).toBe("profile");
  });

  it("only exposes General + Members under the workspace group", () => {
    expect(WORKSPACE_GROUP.items.map((i) => i.section)).toEqual([
      "general",
      "members",
    ]);
  });

  it("flattens items in group order", () => {
    const flat = settingsNavItems(true).map((i) => i.section);
    expect(flat[0]).toBe("profile");
    expect(flat.slice(-2)).toEqual(["general", "members"]);
  });

  it("classifies every section into exactly one rendered group", () => {
    for (const item of settingsNavItems(true)) {
      const g = groupForSection(item.section);
      expect(g === "account" || g === "workspace").toBe(true);
    }
    expect(groupForSection("general")).toBe("workspace");
    expect(groupForSection("members")).toBe("workspace");
    expect(groupForSection("profile")).toBe("account");
  });

  it("references only real settings sections", () => {
    const valid = new Set<string>(settingsSections);
    for (const item of settingsNavItems(true)) {
      expect(valid.has(item.section)).toBe(true);
    }
  });
});
