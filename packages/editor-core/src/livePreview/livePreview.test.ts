// @vitest-environment jsdom
//
// Smoke coverage for the two things each app configures livePreview() with
// (see options.ts): widget labels and wikilink navigation. Everything else
// about widget behavior is covered with the default labels by mermaid.test.ts
// and table.test.ts; this file only proves the options object actually reaches
// the DOM/click handlers instead of the values silently staying at default.

import { describe, it, expect, afterEach } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import {
  defaultLivePreviewLabels,
  defaultLivePreviewOptions,
  fenceLanguage,
  livePreview,
  type LivePreviewLabels,
  type LivePreviewOptions,
} from "./index";

const FRENCH_LABELS: LivePreviewLabels = {
  toggleTask: "Basculer la tâche",
  mermaid: { zoomIn: "Zoom avant", reset: "Réinitialiser", zoomOut: "Zoom arrière" },
  table: {
    insertRowAbove: "Insérer une ligne au-dessus",
    insertRowBelow: "Insérer une ligne en dessous",
    insertColumnLeft: "Insérer une colonne à gauche",
    insertColumnRight: "Insérer une colonne à droite",
    deleteRow: "Supprimer la ligne",
    deleteColumn: "Supprimer la colonne",
    resizeColumn: "Redimensionner la colonne",
    formulaError: "Erreur de formule",
  },
};

let view: EditorView;
let host: HTMLElement;

function mkView(doc: string, options: LivePreviewOptions = defaultLivePreviewOptions): void {
  host = document.createElement("div");
  document.body.appendChild(host);
  view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor: 0 },
      extensions: [
        markdown({ base: markdownLanguage, codeLanguages: fenceLanguage }),
        livePreview(options),
      ],
    }),
    parent: host,
  });
}

afterEach(() => {
  view.destroy();
  host.remove();
});

// Cursor must sit away from the task line — on it, the raw `[ ]` markup
// reveals instead of the checkbox widget (same reveal-on-touch rule as the
// mermaid/table blocks).
const TASK_DOC = "before\n\n- [ ] a task";

describe("livePreview() label configuration", () => {
  it("renders defaultLivePreviewOptions' English labels (desktop's config)", () => {
    mkView(TASK_DOC, defaultLivePreviewOptions);
    const checkbox = view.dom.querySelector<HTMLInputElement>(".cm-live-task");
    expect(checkbox?.getAttribute("aria-label")).toBe(defaultLivePreviewLabels.toggleTask);
  });

  it("threads a non-default labels getter through to widget DOM", () => {
    mkView(TASK_DOC, { labels: () => FRENCH_LABELS });
    const checkbox = view.dom.querySelector<HTMLInputElement>(".cm-live-task");
    expect(checkbox?.getAttribute("aria-label")).toBe(FRENCH_LABELS.toggleTask);
  });

  // Pins the lazy-label semantics: labels is a GETTER re-read at every widget
  // build, not a value snapshotted when livePreview() is installed. This is
  // what lets the webapp's mid-session setLocale() (and its async i18n
  // catalog load racing the first editor mount) reach widgets built after
  // the change — the regression the extraction originally introduced.
  it("re-reads the labels getter on each widget build", () => {
    let labels = defaultLivePreviewLabels;
    mkView(TASK_DOC, { labels: () => labels });
    expect(
      view.dom.querySelector<HTMLInputElement>(".cm-live-task")?.getAttribute("aria-label"),
    ).toBe(defaultLivePreviewLabels.toggleTask);

    labels = FRENCH_LABELS; // the app's locale changed mid-session
    // Flip `[ ]` to `[x]`: CheckboxWidget.eq() compares `checked`, so the
    // edit forces a fresh toDOM() — the rebuilt DOM must show the new labels.
    const box = TASK_DOC.indexOf("[ ]") + 1;
    view.dispatch({ changes: { from: box, to: box + 1, insert: "x" } });
    expect(
      view.dom.querySelector<HTMLInputElement>(".cm-live-task")?.getAttribute("aria-label"),
    ).toBe(FRENCH_LABELS.toggleTask);
  });
});

describe("livePreview() wikilink navigation", () => {
  const DOC = "before [[My Doc]] after";

  it("calls onNavigateWikilink with the slug on ctrl/cmd+click", () => {
    const seen: string[] = [];
    mkView(DOC, {
      labels: () => defaultLivePreviewLabels,
      onNavigateWikilink: (target) => seen.push(target),
    });
    const wiki = view.dom.querySelector<HTMLElement>(".cm-live-wikilink");
    expect(wiki).not.toBeNull();
    wiki!.dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true, cancelable: true, ctrlKey: true, button: 0 }),
    );
    expect(seen).toEqual([wiki!.dataset.liveDoc]);
  });

  it("is a no-op when onNavigateWikilink is omitted (desktop, today)", () => {
    mkView(DOC, { labels: () => defaultLivePreviewLabels });
    const wiki = view.dom.querySelector<HTMLElement>(".cm-live-wikilink");
    expect(wiki).not.toBeNull();
    expect(() =>
      wiki!.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, cancelable: true, ctrlKey: true, button: 0 }),
      ),
    ).not.toThrow();
  });
});
