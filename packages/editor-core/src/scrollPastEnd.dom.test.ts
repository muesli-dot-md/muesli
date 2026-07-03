// @vitest-environment jsdom
//
// DOM-level coverage: scrollPastEnd() should add a non-zero bottom padding to
// the .cm-content element so the viewport can scroll beyond the last line.
// jsdom has no layout, so we stub scrollDOM.clientHeight to give the measure a
// viewport height to work from.

import { describe, it, expect, afterEach } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { scrollPastEnd } from "./scrollPastEnd";

let view: EditorView | null = null;

afterEach(() => {
  view?.destroy();
  view = null;
});

describe("scrollPastEnd extension", () => {
  it("applies a non-zero bottom padding to .cm-content", async () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);

    view = new EditorView({
      state: EditorState.create({
        doc: "line one\nline two\nline three",
        extensions: [scrollPastEnd()],
      }),
      parent,
    });

    // jsdom reports 0 for clientHeight; stub a realistic viewport height so the
    // plugin's measure has something to work from, then force a re-measure and
    // let the requestMeasure callback flush (CM measures on requestAnimationFrame).
    Object.defineProperty(view.scrollDOM, "clientHeight", {
      configurable: true,
      get: () => 600,
    });
    view.requestMeasure();
    await new Promise<void>((r) => requestAnimationFrame(() => r()));

    const content = view.contentDOM;
    const pad = parseInt(content.style.paddingBottom || "0", 10);
    expect(pad).toBeGreaterThan(0);

    document.body.removeChild(parent);
  });

  it("adds no document content (visual only)", () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const doc = "alpha\nbeta";
    view = new EditorView({
      state: EditorState.create({ doc, extensions: [scrollPastEnd()] }),
      parent,
    });
    expect(view.state.doc.toString()).toBe(doc);
    document.body.removeChild(parent);
  });
});
