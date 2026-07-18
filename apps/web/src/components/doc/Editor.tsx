// Editor — the live CodeMirror host for one doc session. Port of
// src/Editor.svelte, with the desktop EditorPane's remount discipline:
//
// REMOUNT SAFETY: the mount effect below has EMPTY deps. Everything it needs —
// ytext, provider, the collab store — hangs off the session, which is created
// once per keyed DocApp mount (App keys DocApp on `${docId} ${shareToken}`) and
// is therefore immutable for this component's lifetime. React state that
// changes per keystroke / presence event / store version bump (affordance
// position, composer open, collab snapshot version) is read via refs or
// getState-style direct reads inside CM callbacks, so no re-render can ever
// re-run the effect and remount CodeMirror or duplicate the Y.UndoManager.
// Suggest mode does NOT remount either: it reconfigures a Compartment.
import { useCallback, useEffect, useRef, useState } from "react";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, keymap, type KeyBinding } from "@codemirror/view";
import { defaultKeymap, indentWithTab } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { yCollab, yUndoManagerKeymap } from "y-codemirror.next";
import * as Y from "yjs";

import { t as tNow, useT } from "@/state/i18n";
import { gotoDoc } from "@/state/route";
import { useDocSession } from "@/state/session";
import { useCollabSnapshot } from "@/state/collabStore";
import { useMentionAutocomplete } from "@/state/mentionAutocomplete";

import { collabDecorations, commentClickHandler } from "@muesli/editor-core/annotations";
import { collabTheme } from "@muesli/editor-core/annotationsTheme";
import { scrollPastEnd } from "@muesli/editor-core/scrollPastEnd";
import {
  fenceLanguage,
  livePreview,
  type LivePreviewLabels,
} from "@muesli/editor-core/livePreview";
import { toggleInlineMark, type InlineMark } from "@muesli/editor-core/mdCommands";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";

// Passed to livePreview() as a getter and re-evaluated by every widget
// toDOM/render — the same points where the old in-app copy called t()
// directly. So a mid-session setLocale(), or a non-English catalog that
// finishes its async load after this editor mounts (the i18n engine falls
// back to English until then), reaches every widget built afterwards.
// Uses the module-level t (not the hook): widgets render outside React.
const liveLabels = (): LivePreviewLabels => ({
  toggleTask: tNow("editor.toggleTask"),
  mermaid: {
    zoomIn: tNow("editor.mermaid.zoomIn"),
    reset: tNow("editor.mermaid.reset"),
    zoomOut: tNow("editor.mermaid.zoomOut"),
  },
  table: {
    insertRowAbove: tNow("editor.table.insertRowAbove"),
    insertRowBelow: tNow("editor.table.insertRowBelow"),
    insertColumnLeft: tNow("editor.table.insertColumnLeft"),
    insertColumnRight: tNow("editor.table.insertColumnRight"),
    deleteRow: tNow("editor.table.deleteRow"),
    deleteColumn: tNow("editor.table.deleteColumn"),
    resizeColumn: tNow("editor.table.resizeColumn"),
    formulaError: tNow("editor.table.formulaError"),
  },
});

// Docs-style inline shortcuts (toolbar parity); CM ignores them in read-only
// suggest mode. Registered before defaultKeymap so nothing shadows them.
const markKey = (key: string, mark: InlineMark): KeyBinding => ({
  key,
  preventDefault: true,
  run: (v: EditorView) => {
    if (v.state.readOnly) return false;
    v.dispatch({ ...toggleInlineMark(v.state, mark), userEvent: "input", scrollIntoView: true });
    return true;
  },
});

type SuggestAction = "replace" | "insert-after" | "delete";

export default function Editor() {
  const t = useT();
  // DocApp is keyed on the doc id + share token, so this whole component
  // (EditorView, undo manager, CRDT binding) remounts against a fresh session
  // on doc switch. The session is immutable for this component's lifetime.
  const session = useDocSession();
  const collab = session.store;
  // Subscribe to the collab store's reactive fields (suggestMode, selection,
  // availability, members, composerRequest) — re-renders this component, never
  // the mount effect.
  useCollabSnapshot(collab);

  const wrapRef = useRef<HTMLDivElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const composerElRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);

  // Suggest mode makes the editor read-only (user input is intercepted; remote
  // CRDT updates still apply) — edits are queued as suggestion drafts instead.
  const [readOnly] = useState(() => new Compartment());

  // Floating affordance over the active selection: "Comment" normally,
  // "Suggest" in suggest mode. Opens a small composer popover.
  const [affordance, setAffordance] = useState<{ x: number; y: number } | null>(null);
  const [composerOpen, setComposerOpen] = useState(false);
  const [composerText, setComposerText] = useState("");
  const [suggestAction, setSuggestAction] = useState<SuggestAction>("replace");
  // Mirror for CodeMirror callbacks (created once at mount; reading React
  // state there would be a stale closure).
  const composerOpenRef = useRef(false);

  const suggestMode = collab.suggestMode;
  const hasSelection = collab.selection.from !== collab.selection.to;
  const showAffordance =
    hasSelection && collab.availability !== "volatile" && collab.availability !== "auth";

  // Stable identity ([] deps; refs + setState only) — safe to close over in
  // the CM updateListener created by the mount effect.
  const positionAffordance = useCallback((v: EditorView): void => {
    const wrap = wrapRef.current;
    const sel = v.state.selection.main;
    if (sel.empty || !wrap) {
      setAffordance(null);
      setComposerOpen(false);
      composerOpenRef.current = false;
      return;
    }
    const coords = v.coordsAtPos(sel.head);
    if (!coords) {
      setAffordance(null);
      return;
    }
    const rect = wrap.getBoundingClientRect();
    setAffordance({
      x: Math.max(8, Math.min(coords.left - rect.left, rect.width - 280)),
      y: Math.min(coords.bottom - rect.top + 6, rect.height - 40),
    });
  }, []);

  // ── The mount effect ────────────────────────────────────────────────────────
  // Runs exactly once per keyed DocApp mount. Never re-runs on keystrokes,
  // presence changes, or collab-store version bumps (empty deps; see header).
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const { ytext, provider } = session;
    const store = session.store;

    const undoManager = new Y.UndoManager(ytext);
    const view = new EditorView({
      state: EditorState.create({
        doc: ytext.toString(),
        extensions: [
          keymap.of([
            ...yUndoManagerKeymap,
            markKey("Mod-b", "strong"),
            markKey("Mod-i", "em"),
            ...defaultKeymap,
            indentWithTab,
          ]),
          EditorView.lineWrapping,
          // base: markdownLanguage = GFM (tables, task lists, strikethrough) —
          // the default is commonmark-only, which live preview can't render.
          markdown({ base: markdownLanguage, codeLanguages: fenceLanguage }),
          yCollab(ytext, provider.awareness, { undoManager }),
          readOnly.of([]),
          // Decoration precedence (documented in livePreview/index.ts): the
          // collab marks (comments/suggestions) come BEFORE the live-preview
          // layer, so they win where ranges overlap. collabTheme is the opt-in
          // baseTheme for those highlights (editor-core no longer bundles it).
          collabDecorations,
          collabTheme,
          commentClickHandler((threadId) => store.revealThread(threadId)),
          livePreview({ labels: liveLabels, onNavigateWikilink: gotoDoc }),
          // VSCode/Atom "scroll beyond last line": bottom padding so the last
          // line can scroll up near the top. Visual only — no document text.
          scrollPastEnd(),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) store.mapDraftsThroughChanges(u.changes);
            if (u.selectionSet || u.docChanged) {
              const sel = u.state.selection.main;
              store.selection = { from: sel.from, to: sel.to };
              if (!composerOpenRef.current) positionAffordance(u.view);
            }
          }),
        ],
      }),
      parent: host,
    });
    viewRef.current = view;
    store.view = view; // deliberately non-reactive seam (collabStore)
    // The DocSession seam for doc chrome (toolbar/outline) — the setter
    // notifies useEditorView subscribers, so Toolbar/OutlineRail re-render.
    session.editorView = view;
    store.syncDecorations(); // data may have arrived before the editor mounted

    const onScroll = () => {
      if (!composerOpenRef.current && viewRef.current) positionAffordance(viewRef.current);
    };
    view.scrollDOM.addEventListener("scroll", onScroll, { passive: true });

    // Cleanup — exact Svelte teardown order: scroll listener off, store seam
    // cleared, session seam cleared, then destroy the view. The session itself
    // is destroyed by DocApp's cleanup, which runs AFTER this (child first).
    return () => {
      view.scrollDOM.removeEventListener("scroll", onScroll);
      store.view = null;
      session.editorView = null;
      viewRef.current = null;
      view.destroy();
    };
    // Session is immutable for this keyed mount; everything else via refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Suggest mode flips the readOnly compartment WITHOUT remounting the editor.
  useEffect(() => {
    viewRef.current?.dispatch({
      effects: readOnly.reconfigure(suggestMode ? EditorState.readOnly.of(true) : []),
    });
  }, [suggestMode, readOnly]);

  const openComposer = useCallback((): void => {
    setComposerOpen(true);
    composerOpenRef.current = true;
    setComposerText("");
    setSuggestAction("replace");
  }, []);

  const closeComposer = useCallback((): void => {
    setComposerOpen(false);
    composerOpenRef.current = false;
    setComposerText("");
  }, []);

  // Focus the freshly rendered composer textarea (the Svelte `await tick()`).
  useEffect(() => {
    if (composerOpen) {
      composerElRef.current?.querySelector("textarea")?.focus();
    }
  }, [composerOpen, suggestAction]);

  // The toolbar's comment button funnels through the same composer the
  // selection affordance opens (collabStore.requestComposer bumps the counter).
  const composerRequest = collab.composerRequest;
  const seenComposerRequestRef = useRef(0);
  useEffect(() => {
    if (composerRequest > seenComposerRequestRef.current) {
      seenComposerRequestRef.current = composerRequest;
      const v = viewRef.current;
      if (v && hasSelection && showAffordance) {
        positionAffordance(v);
        openComposer();
      }
    }
  }, [composerRequest, hasSelection, showAffordance, positionAffordance, openComposer]);

  async function submitComment(): Promise<void> {
    const body = composerText.trim();
    if (!body) return;
    if (await collab.addComment(body)) {
      closeComposer();
      collab.sidebarOpen = true;
      collab.tab = "comments";
    }
  }

  function addSuggestDraft(): void {
    if (suggestAction !== "delete" && !composerText) return;
    collab.addDraft(suggestAction, composerText);
    closeComposer();
    collab.sidebarOpen = true;
    collab.tab = "suggestions";
  }

  // Mention autocomplete for the comment composer textarea (imperative DOM
  // dropdown, ported from the Svelte action). Callback ref so the autocomplete
  // attaches the moment the composer's textarea mounts.
  const commentTextareaRef = useMentionAutocomplete({ members: collab.members });

  return (
    <div ref={wrapRef} className="relative h-full">
      {/* CodeMirror mounts directly into this div. */}
      <div ref={hostRef} className="h-full overflow-auto" />

      {affordance && showAffordance && (
        <div
          ref={composerElRef}
          className="absolute z-20"
          style={{ left: affordance.x, top: affordance.y }}
        >
          {!composerOpen ? (
            <Button variant="outline" size="xs" className="bg-popover shadow" onClick={openComposer}>
              {suggestMode ? t("editor.suggestAction") : t("editor.commentAction")}
            </Button>
          ) : suggestMode ? (
            <div className="w-72 rounded-lg border bg-popover p-3 shadow-lg">
              <select
                className="mb-2 h-7 w-full rounded-md border bg-background px-2 text-xs"
                value={suggestAction}
                onChange={(e) => setSuggestAction(e.target.value as SuggestAction)}
              >
                <option value="replace">{t("editor.replaceSelection")}</option>
                <option value="insert-after">{t("editor.insertAfterSelection")}</option>
                <option value="delete">{t("editor.deleteSelection")}</option>
              </select>
              {suggestAction !== "delete" && (
                <Textarea
                  className="w-full font-mono text-xs"
                  rows={2}
                  placeholder={
                    suggestAction === "replace"
                      ? t("editor.replacementText")
                      : t("editor.textToInsert")
                  }
                  value={composerText}
                  onChange={(e) => setComposerText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") closeComposer();
                  }}
                />
              )}
              <div className="mt-2 flex justify-end gap-1">
                <Button variant="ghost" size="xs" onClick={closeComposer}>
                  {t("common.cancel")}
                </Button>
                <Button size="xs" onClick={addSuggestDraft}>
                  {t("editor.addToSuggestion")}
                </Button>
              </div>
            </div>
          ) : (
            <div className="w-72 rounded-lg border bg-popover p-3 shadow-lg">
              <Textarea
                ref={commentTextareaRef}
                className="w-full text-sm"
                rows={2}
                placeholder={t("editor.commentPlaceholder")}
                value={composerText}
                onChange={(e) => setComposerText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void submitComment();
                  if (e.key === "Escape") closeComposer();
                }}
              />
              <div className="mt-2 flex justify-end gap-1">
                <Button variant="ghost" size="xs" onClick={closeComposer}>
                  {t("common.cancel")}
                </Button>
                <Button
                  size="xs"
                  disabled={!composerText.trim()}
                  onClick={() => void submitComment()}
                >
                  {t("editor.comment")}
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      {suggestMode && (
        <div className="absolute right-3 top-2 z-10">
          <Badge
            className="border-transparent bg-amber-500/15 text-amber-700 dark:bg-amber-400/15 dark:text-amber-400"
            title={t("suggest.modeBadgeTitle")}
          >
            {t("suggest.modeBadge")}
          </Badge>
        </div>
      )}
    </div>
  );
}
