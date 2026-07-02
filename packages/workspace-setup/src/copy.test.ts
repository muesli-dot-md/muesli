import { describe, it, expect } from "vitest";
import { makeT } from "./copy";

describe("makeT", () => {
  it("uses built-in English with {param} interpolation", () => {
    const t = makeT();
    expect(t("wizard.stepOf", { n: 2, total: 4 })).toBe("Step 2 of 4");
  });
  it("prefers a host override but falls back when it echoes the key", () => {
    const t = makeT((key) => (key === "wizard.back" ? "Zurück" : key));
    expect(t("wizard.back")).toBe("Zurück");
    expect(t("wizard.cancel")).toBe("Cancel"); // override echoed the key → fallback
  });
});
