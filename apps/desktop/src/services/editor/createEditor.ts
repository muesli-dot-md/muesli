import { EditorView, keymap, placeholder, type ViewUpdate } from "@codemirror/view";
import { EditorState, type Extension } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { search, searchKeymap } from "@codemirror/search";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { scrollPastEnd } from "@muesli/editor-core/scrollPastEnd";
import { muesliTheme } from "./theme";
import {
  defaultLivePreviewLabels,
  livePreview,
  fenceLanguage,
} from "@muesli/editor-core/livePreview";

export interface CreateEditorOpts {
  parent: HTMLElement;
  doc: string;
  onChange: (text: string) => void;
  /** Called when the selection moves (even without a doc change). Used by Toolbar to recompute active marks. */
  onSelection?: () => void;
  /** Optional extra extension (e.g. yCollab in Task 7). Added LAST so it can override. */
  collab?: Extension;
  /**
   * Collaboration decoration extensions (comment/suggestion highlights + the
   * comment-click handler). Added BEFORE live preview so collab marks win where
   * ranges overlap (mirrors apps/web/src/Editor.svelte's extension order).
   */
  annotations?: Extension;
  /**
   * Fired on every editor transaction (doc or selection change). Lets the
   * collab store keep its UTF-16 selection fresh and remap queued suggestion
   * drafts through local edits — mirrors the web editor's updateListener.
   */
  onUpdate?: (update: ViewUpdate) => void;
  /**
   * Obsidian-style live-preview decorations (hide markdown markers, style
   * content inline, reveal raw markdown on the cursor's line). Default: true.
   * Set false for a plain "source" editing experience.
   */
  livePreview?: boolean;
}

export function createEditor(opts: CreateEditorOpts): EditorView {
  const {
    parent,
    doc,
    onChange,
    onSelection,
    collab,
    annotations,
    onUpdate,
    livePreview: useLivePreview = true,
  } = opts;

  const extensions: Extension[] = [
    // A blank file would otherwise render as pure nothing (the caret only
    // draws once focused) — give the empty doc a hint that this is the editor.
    placeholder("Start writing…"),
    markdown({ base: markdownLanguage, codeLanguages: fenceLanguage }),
    EditorView.lineWrapping,
    history(),
    // In-file find/replace: ⌘F (Cmd on macOS, Ctrl elsewhere via Mod-) opens the
    // standard CodeMirror search panel, scoped to THIS editor. Distinct from the
    // global ⌘K workspace search palette. `top: true` puts the panel at the top.
    search({ top: true }),
    keymap.of([...searchKeymap, ...defaultKeymap, ...historyKeymap, indentWithTab]),
    muesliTheme,
    // VSCode/Atom "scroll beyond last line": bottom padding so the last line can
    // scroll up near the top of the pane. Visual only — adds no document text.
    scrollPastEnd(),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        onChange(update.state.doc.toString());
      }
      if ((update.docChanged || update.selectionSet) && onSelection) {
        onSelection();
      }
      if (onUpdate) onUpdate(update);
    }),
  ];

  // Collab decoration extensions (comment/suggestion highlights + click handler)
  // go BEFORE live preview so their marks win where ranges overlap.
  if (annotations) {
    extensions.push(annotations);
  }

  // Live-preview decorations go BEFORE the collab extension so that yCollab's
  // remote-cursor/selection decorations layer on top, and both decoration sets
  // coexist cleanly. Desktop is not localized (AGENTS.md) — literal English
  // labels — and has no onNavigateWikilink yet: [[wikilink]] cmd/ctrl+click is
  // a no-op until wikilink navigation ships here.
  if (useLivePreview) {
    extensions.push(...livePreview({ labels: () => defaultLivePreviewLabels }));
  }

  if (collab) {
    extensions.push(collab);
  }

  const state = EditorState.create({ doc, extensions });
  const view = new EditorView({ state, parent });
  // Clicking a file means "let me type": focus immediately so the caret is
  // visible (CodeMirror draws no cursor while unfocused, which on an empty
  // file looks like a dead pane).
  view.focus();
  return view;
}
