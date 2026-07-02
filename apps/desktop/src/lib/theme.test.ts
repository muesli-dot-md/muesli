import { describe, it, expect } from "vitest";
import { resolveTheme, theme } from "./theme.svelte";

describe("resolveTheme", () => {
  it("system + prefersDark → arc-dark", () => {
    expect(resolveTheme("system", true)).toBe("arc-dark");
  });

  it("system + !prefersDark → arc-light", () => {
    expect(resolveTheme("system", false)).toBe("arc-light");
  });

  it("light → arc-light", () => {
    expect(resolveTheme("light", false)).toBe("arc-light");
    expect(resolveTheme("light", true)).toBe("arc-light");
  });

  it("dark → arc-dark", () => {
    expect(resolveTheme("dark", false)).toBe("arc-dark");
    expect(resolveTheme("dark", true)).toBe("arc-dark");
  });
});

describe("theme.setMode", () => {
  it("sets each mode directly — one click = one mode, no cycling", () => {
    theme.setMode("dark");
    expect(theme.mode).toBe("dark");
    theme.setMode("light");
    expect(theme.mode).toBe("light");
    theme.setMode("system");
    expect(theme.mode).toBe("system");
  });
});
