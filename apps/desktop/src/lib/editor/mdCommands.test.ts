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
  it("toggleList on an empty line puts the caret after the fresh marker", () => {
    const s = stateWith("", 0);
    const next = s.update(toggleList(s, "ordered")).state;
    expect(next.doc.toString()).toBe("1. ");
    expect(next.selection.main.head).toBe(3); // typing continues after "1. "
  });
  it("toggleList keeps the caret's offset within the line content", () => {
    const s = stateWith("item", 4); // caret at end of "item"
    const next = s.update(toggleList(s, "ordered")).state;
    expect(next.doc.toString()).toBe("1. item");
    expect(next.selection.main.head).toBe(7); // still at end of "item"
  });
  it("toggleList off shifts the caret back with the removed marker", () => {
    const s = stateWith("- item", 6); // caret at end
    const next = s.update(toggleList(s, "bullet")).state;
    expect(next.doc.toString()).toBe("item");
    expect(next.selection.main.head).toBe(4);
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
