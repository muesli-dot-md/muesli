// @vitest-environment jsdom
//
// Widget-interaction test for the live-preview mermaid block: a double-click on
// the rendered diagram must move the CodeMirror selection INTO the ```mermaid
// fenced block, which is what triggers blocks.ts to reveal the editable source.
// jsdom can't run the real mermaid SVG render (the lazy import has no DOM
// canvas), so the widget shows its <pre> source placeholder — but the dblclick
// handler keys off the .cm-live-mermaid container, which exists either way.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { attachMermaidInteraction } from "@muesli/editor-core/mermaidInteraction";
import { fenceLanguage, livePreview } from "./index";

const DOC = ["before", "", "```mermaid", "graph TD; A-->B", "```", "", "after"].join("\n");

function blockRange(doc: string): { from: number; to: number } {
  const from = doc.indexOf("```mermaid");
  const fenceEnd = doc.indexOf("```", from + 3);
  return { from, to: fenceEnd + 3 };
}

let view: EditorView;
let host: HTMLElement;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  // Place the cursor far from the block so the widget renders (block hidden).
  view = new EditorView({
    state: EditorState.create({
      doc: DOC,
      selection: { anchor: 0 },
      extensions: [
        markdown({ base: markdownLanguage, codeLanguages: fenceLanguage }),
        livePreview(),
      ],
    }),
    parent: host,
  });
});

afterEach(() => {
  view.destroy();
  host.remove();
});

describe("mermaid widget dblclick-to-edit", () => {
  it("renders the mermaid block as a widget while the cursor is outside it", () => {
    const widget = view.dom.querySelector(".cm-live-mermaid");
    expect(widget).not.toBeNull();
  });

  it("dblclick on the diagram moves the selection into the block range", () => {
    const widget = view.dom.querySelector<HTMLElement>(".cm-live-mermaid");
    expect(widget).not.toBeNull();

    const target = widget!.querySelector(".mermaid-block") ?? widget!;
    target.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));

    const { from, to } = blockRange(DOC);
    const sel = view.state.selection.main;
    // The cursor must now touch the fenced block (inclusive edges), which is
    // exactly what reveals the raw source.
    expect(sel.from).toBeGreaterThanOrEqual(from);
    expect(sel.from).toBeLessThanOrEqual(to);
  });
});

describe("mermaid zoom control positioning", () => {
  const labels = { zoomIn: "Zoom in", reset: "Reset zoom", zoomOut: "Zoom out" };

  it("anchors the +/1:1/− cluster INSIDE the diagram holder, not as a sibling after it", () => {
    const root = document.createElement("div");
    root.className = "cm-live-mermaid";
    const holder = document.createElement("div");
    holder.className = "mermaid-block";
    holder.innerHTML = "<svg></svg>";
    root.appendChild(holder);
    document.body.appendChild(root);

    attachMermaidInteraction(root, holder, labels);

    const controls = root.querySelector(".mermaid-controls");
    expect(controls).not.toBeNull();
    // Must be a descendant of the positioned/overflow-hidden diagram box so it
    // overlays the bottom-right corner — NOT a sibling rendered below it.
    expect(controls!.parentElement).toBe(holder);
    expect(controls!.closest(".mermaid-block")).toBe(holder);
    // Three buttons: +, 1:1, −.
    expect(controls!.querySelectorAll("button").length).toBe(3);

    root.remove();
  });
});
