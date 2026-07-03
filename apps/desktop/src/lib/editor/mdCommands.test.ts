import { describe, it, expect } from "vitest";
import { EditorState } from "@codemirror/state";
import {
  setBlockStyle, currentBlockStyle, toggleList, currentListKind,
  isProbablyUrl, parseOutline, tableSkeleton,
} from "$lib/editor/mdCommands";

function stateWith(doc: string, anchor = 0, head = anchor) {
  return EditorState.create({ doc, selection: { anchor, head } });
}

describe("mdCommands", () => {
  it("setBlockStyle h1 prefixes the line", () => {
    const s = stateWith("hello", 1);
    const tr = setBlockStyle(s, "h1");
    const next = s.update(tr).state;
    expect(next.doc.toString()).toBe("# hello");
    expect(currentBlockStyle(next)).toBe("h1");
  });
  it("toggleList bullet adds a marker", () => {
    const s = stateWith("item", 1);
    const next = s.update(toggleList(s, "bullet")).state;
    expect(next.doc.toString().startsWith("- ")).toBe(true);
    expect(currentListKind(next)).toBe("bullet");
  });
  it("isProbablyUrl recognises a url", () => {
    expect(isProbablyUrl("https://x.com")).toBe(true);
    expect(isProbablyUrl("just text")).toBe(false);
  });
  it("parseOutline extracts headings in order", () => {
    const items = parseOutline("# A\n\n## B\n\ntext\n# C");
    expect(items.map((i) => i.text)).toEqual(["A", "B", "C"]);
    expect(items.map((i) => i.level)).toEqual([1, 2, 1]);
  });
  it("tableSkeleton produces a GFM table", () => {
    expect(tableSkeleton(2, 1)).toContain("| --- |");
  });
});
