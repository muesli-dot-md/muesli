// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  collabDecorations,
  commentClickHandler,
  setCollabDecorations,
  setFlashRange,
} from "./annotations";
import { collabTheme } from "./annotationsTheme";

// jsdom container for the editor views; torn down after each test.
let view: EditorView | null = null;

// Mount with the opt-in baseTheme (annotationsTheme.ts) by default so the
// "injects the highlight baseTheme styles" assertion exercises it. This mirrors
// the desktop app, which adds collabTheme to its extensions; the web app styles
// the same classes via app.css and omits the theme.
function mount(doc: string, extensions: Extension = [collabDecorations, collabTheme]): EditorView {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  view = new EditorView({
    state: EditorState.create({ doc, extensions }),
    parent,
  });
  return view;
}

afterEach(() => {
  view?.destroy();
  view = null;
});

describe("collab decorations", () => {
  it("renders a comment anchor mark carrying its thread id", () => {
    const v = mount("hello world");
    v.dispatch({
      effects: setCollabDecorations.of({
        comments: [{ from: 0, to: 5, threadId: "thread-7" }],
        suggestions: [],
      }),
    });
    const anchor = v.dom.querySelector(".cm-comment-anchor[data-thread-id]");
    expect(anchor).not.toBeNull();
    expect(anchor?.getAttribute("data-thread-id")).toBe("thread-7");
    expect(anchor?.textContent).toBe("hello");
  });

  it("renders suggestion deletion + insertion decorations", () => {
    const v = mount("hello world");
    v.dispatch({
      effects: setCollabDecorations.of({
        comments: [],
        suggestions: [{ from: 0, to: 5, insert: "HI", id: "s1" }],
      }),
    });
    expect(v.dom.querySelector(".cm-suggest-deletion")).not.toBeNull();
    const ins = v.dom.querySelector(".cm-suggest-insertion");
    expect(ins).not.toBeNull();
    expect(ins?.textContent).toBe("HI");
  });

  it("renders a flash mark and clears it on null", () => {
    const v = mount("hello world");
    v.dispatch({ effects: setFlashRange.of({ from: 0, to: 5 }) });
    expect(v.dom.querySelector(".cm-collab-flash")).not.toBeNull();
    v.dispatch({ effects: setFlashRange.of(null) });
    expect(v.dom.querySelector(".cm-collab-flash")).toBeNull();
  });

  it("injects the highlight baseTheme styles into the document", () => {
    // The baseTheme ships with the extension (so highlights are visible without
    // touching app.css). Mounting any view registers the generated stylesheet.
    mount("hello world");
    const styleText = Array.from(document.querySelectorAll("style"))
      .map((s) => s.textContent ?? "")
      .join("\n");
    expect(styleText).toContain("cm-comment-anchor");
    expect(styleText).toContain("cm-suggest-deletion");
    expect(styleText).toContain("cm-suggest-insertion");
    expect(styleText).toContain("cm-collab-flash");
    // Theme-aware: colors derive from daisyUI semantic vars, not hardcoded hex.
    expect(styleText).toContain("var(--color-warning)");
  });

  it("routes a click on a comment anchor to the thread id", () => {
    const seen: string[] = [];
    const v = mount("hello world", [collabDecorations, commentClickHandler((id) => seen.push(id))]);
    v.dispatch({
      effects: setCollabDecorations.of({
        comments: [{ from: 0, to: 5, threadId: "abc" }],
        suggestions: [],
      }),
    });
    const anchor = v.dom.querySelector<HTMLElement>(".cm-comment-anchor[data-thread-id]");
    anchor?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(seen).toEqual(["abc"]);
  });
});
