import { describe, it, expect } from "vitest";
import { createTranscriptStore } from "./transcript.svelte";

const ev = (source: "me" | "them", text: string, utteranceId: number) => ({
  source,
  text,
  t0: 0,
  t1: 1,
  utteranceId,
});

describe("transcript store", () => {
  it("promotes a partial to a final for the same source+utteranceId", () => {
    const s = createTranscriptStore();
    s.applyPartial(ev("me", "hel", 0));
    s.applyFinal(ev("me", "hello", 0));
    const meLines = s.lines("me");
    expect(meLines).toHaveLength(1);
    expect(meLines[0].text).toBe("hello");
    expect(meLines[0].final).toBe(true);
  });

  it("keeps me and them lanes separate", () => {
    const s = createTranscriptStore();
    s.applyFinal(ev("me", "a", 0));
    s.applyFinal(ev("them", "b", 0));
    expect(s.lines("me")).toHaveLength(1);
    expect(s.lines("them")).toHaveLength(1);
  });

  it("partial then final updates the same line in place; lines sorted by utteranceId", () => {
    const s = createTranscriptStore();
    s.applyPartial(ev("me", "first partial", 0));
    s.applyPartial(ev("me", "second partial", 1));
    s.applyFinal(ev("me", "first final", 0));
    const lines = s.lines("me");
    expect(lines).toHaveLength(2);
    expect(lines[0].utteranceId).toBe(0);
    expect(lines[0].text).toBe("first final");
    expect(lines[0].final).toBe(true);
    expect(lines[1].utteranceId).toBe(1);
    expect(lines[1].text).toBe("second partial");
    expect(lines[1].final).toBe(false);
  });
});
