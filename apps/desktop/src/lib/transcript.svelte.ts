import type { TranscriptEvent, TranscriptLine } from "./types";

interface LineEntry extends TranscriptLine {
  source: "me" | "them";
}

export function createTranscriptStore() {
  let lines = $state<Map<string, LineEntry>>(new Map());

  function applyPartial(e: TranscriptEvent) {
    const key = `${e.source}:${e.utteranceId}`;
    const updated = new Map(lines);
    updated.set(key, {
      text: e.text,
      final: false,
      utteranceId: e.utteranceId,
      t0: e.t0,
      source: e.source,
    });
    lines = updated;
  }

  function applyFinal(e: TranscriptEvent) {
    const key = `${e.source}:${e.utteranceId}`;
    const updated = new Map(lines);
    updated.set(key, {
      text: e.text,
      final: true,
      utteranceId: e.utteranceId,
      t0: e.t0,
      source: e.source,
    });
    lines = updated;
  }

  function getLines(source: "me" | "them"): TranscriptLine[] {
    return [...lines.values()]
      .filter((l) => l.source === source)
      .sort((a, b) => a.utteranceId - b.utteranceId);
  }

  return {
    applyPartial,
    applyFinal,
    get lines() {
      // Return a function so callers can do s.lines('me')
      return getLines;
    },
  };
}
