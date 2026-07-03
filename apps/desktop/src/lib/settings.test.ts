import { describe, it, expect } from "vitest";
import { settings } from "./settings.svelte";

// Node test env has no localStorage, so the store constructs from DEFAULTS and
// persist() is a guarded no-op — exactly what we want to pin here.
describe("settings.autoUpdate (spec 2026-07-02 Decision 2)", () => {
  it("defaults to true — silent auto-download is the default", () => {
    expect(settings.autoUpdate).toBe(true);
  });

  it("setAutoUpdate flips the flag", () => {
    settings.setAutoUpdate(false);
    expect(settings.autoUpdate).toBe(false);
    settings.setAutoUpdate(true);
    expect(settings.autoUpdate).toBe(true);
  });
});

describe("settings.wsBase default (sign-in server picker spec 2026-07-02, Decision 3)", () => {
  it("fresh installs point at the public app.muesli.md server", () => {
    // Node test env has no localStorage, so the singleton constructed from
    // DEFAULTS — exactly the fresh-install / cleared-storage case. Persisted
    // values win via load(); only the default flips.
    expect(settings.wsBase).toBe("wss://app.muesli.md/ws");
  });
});
