<script lang="ts">
  import { onMount, tick } from "svelte";
  import { Compartment, EditorState } from "@codemirror/state";
  import { EditorView, keymap } from "@codemirror/view";
  import { defaultKeymap, indentWithTab } from "@codemirror/commands";
  import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
  import { yCollab, yUndoManagerKeymap } from "y-codemirror.next";
  import * as Y from "yjs";
  import { t } from "./i18n/index.svelte";
  import { useDocSession } from "./session.svelte";
  import { collabDecorations, commentClickHandler } from "@muesli/editor-core/annotations";
  import { scrollPastEnd } from "@muesli/editor-core/scrollPastEnd";
  import { fenceLanguage, livePreview } from "./livePreview";
  import { mentionAutocomplete } from "./mentionAction.svelte";
  import { toggleInlineMark, type InlineMark } from "@muesli/editor-core/mdCommands";

  // DocApp is keyed on the doc id, so this whole component (EditorView, undo
  // manager, CRDT binding) remounts against the new session on doc switch.
  const session = useDocSession();
  const { ytext, provider } = session;
  const collab = session.store;

  let host: HTMLDivElement;
  let wrap: HTMLDivElement;
  let view: EditorView | null = $state.raw(null);

  // Suggest mode makes the editor read-only (user input is intercepted; remote
  // CRDT updates still apply) — edits are queued as suggestion drafts instead.
  const readOnly = new Compartment();

  // Floating affordance over the active selection: "Comment" normally,
  // "Suggest" in suggest mode. Opens a small composer popover.
  let affordance: { x: number; y: number } | null = $state(null);
  let composerOpen = $state(false);
  let composerText = $state("");
  let suggestAction: "replace" | "insert-after" | "delete" = $state("replace");
  let composerEl: HTMLDivElement | null = $state(null);

  const hasSelection = $derived(collab.selection.from !== collab.selection.to);
  const showAffordance = $derived(
    hasSelection && collab.availability !== "volatile" && collab.availability !== "auth",
  );

  function positionAffordance(v: EditorView) {
    const sel = v.state.selection.main;
    if (sel.empty) {
      affordance = null;
      composerOpen = false;
      return;
    }
    const coords = v.coordsAtPos(sel.head);
    if (!coords) {
      affordance = null;
      return;
    }
    const rect = wrap.getBoundingClientRect();
    affordance = {
      x: Math.max(8, Math.min(coords.left - rect.left, rect.width - 280)),
      y: Math.min(coords.bottom - rect.top + 6, rect.height - 40),
    };
  }

  // Docs-style inline shortcuts (toolbar parity); CM ignores them in read-only
  // suggest mode. Registered before defaultKeymap so nothing shadows them.
  const markKey = (key: string, mark: InlineMark) => ({
    key,
    preventDefault: true,
    run: (v: EditorView) => {
      if (v.state.readOnly) return false;
      v.dispatch({ ...toggleInlineMark(v.state, mark), userEvent: "input", scrollIntoView: true });
      return true;
    },
  });

  onMount(() => {
    const undoManager = new Y.UndoManager(ytext);
    const v = new EditorView({
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
          // layer, so they win where ranges overlap.
          collabDecorations,
          commentClickHandler((threadId) => collab.revealThread(threadId)),
          livePreview(),
          // VSCode/Atom "scroll beyond last line": bottom padding so the last
          // line can scroll up near the top. Visual only — no document text.
          scrollPastEnd(),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) collab.mapDraftsThroughChanges(u.changes);
            if (u.selectionSet || u.docChanged) {
              const sel = u.state.selection.main;
              collab.selection = { from: sel.from, to: sel.to };
              if (!composerOpen) positionAffordance(u.view);
            }
          }),
        ],
      }),
      parent: host,
    });
    view = v;
    collab.view = v;
    session.editorView = v; // the DocSession seam for doc chrome (toolbar/outline)
    collab.syncDecorations(); // data may have arrived before the editor mounted
    const onScroll = () => {
      if (!composerOpen && view) positionAffordance(view);
    };
    v.scrollDOM.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      v.scrollDOM.removeEventListener("scroll", onScroll);
      collab.view = null;
      session.editorView = null;
      view = null;
      v.destroy();
    };
  });

  $effect(() => {
    const ro = collab.suggestMode;
    view?.dispatch({
      effects: readOnly.reconfigure(ro ? EditorState.readOnly.of(true) : []),
    });
  });

  // The toolbar's comment button funnels through the same composer the
  // selection affordance opens (collabStore.requestComposer bumps the counter).
  let seenComposerRequest = 0;
  $effect(() => {
    const req = collab.composerRequest;
    if (req > seenComposerRequest) {
      seenComposerRequest = req;
      if (view && hasSelection && showAffordance) {
        positionAffordance(view);
        void openComposer();
      }
    }
  });

  async function openComposer() {
    composerOpen = true;
    composerText = "";
    suggestAction = "replace";
    await tick();
    composerEl?.querySelector("textarea")?.focus();
  }

  function closeComposer() {
    composerOpen = false;
    composerText = "";
  }

  async function submitComment() {
    const body = composerText.trim();
    if (!body) return;
    if (await collab.addComment(body)) {
      closeComposer();
      collab.sidebarOpen = true;
      collab.tab = "comments";
    }
  }

  function addSuggestDraft() {
    if (suggestAction !== "delete" && !composerText) return;
    collab.addDraft(suggestAction, composerText);
    closeComposer();
    collab.sidebarOpen = true;
    collab.tab = "suggestions";
  }
</script>

<div bind:this={wrap} class="relative h-full">
  <div bind:this={host} class="h-full overflow-auto"></div>

  {#if affordance && showAffordance}
    <div
      class="absolute z-20"
      style:left="{affordance.x}px"
      style:top="{affordance.y}px"
      bind:this={composerEl}
    >
      {#if !composerOpen}
        <button class="btn btn-xs shadow" onclick={openComposer}>
          {collab.suggestMode ? t("editor.suggestAction") : t("editor.commentAction")}
        </button>
      {:else if collab.suggestMode}
        <div class="w-72 rounded-box border border-base-300 bg-base-100 p-3 shadow-lg">
          <select class="select select-xs mb-2 w-full" bind:value={suggestAction}>
            <option value="replace">{t("editor.replaceSelection")}</option>
            <option value="insert-after">{t("editor.insertAfterSelection")}</option>
            <option value="delete">{t("editor.deleteSelection")}</option>
          </select>
          {#if suggestAction !== "delete"}
            <textarea
              class="textarea textarea-sm w-full font-mono text-xs"
              rows="2"
              placeholder={suggestAction === "replace" ? t("editor.replacementText") : t("editor.textToInsert")}
              bind:value={composerText}
            ></textarea>
          {/if}
          <div class="mt-2 flex justify-end gap-1">
            <button class="btn btn-ghost btn-xs" onclick={closeComposer}>{t("common.cancel")}</button>
            <button class="btn btn-primary btn-xs" onclick={addSuggestDraft}>
              {t("editor.addToSuggestion")}
            </button>
          </div>
        </div>
      {:else}
        <div class="w-72 rounded-box border border-base-300 bg-base-100 p-3 shadow-lg">
          <textarea
            class="textarea textarea-sm w-full"
            rows="2"
            placeholder={t("editor.commentPlaceholder")}
            bind:value={composerText}
            use:mentionAutocomplete={{ members: collab.members }}
            onkeydown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submitComment();
              if (e.key === "Escape") closeComposer();
            }}
          ></textarea>
          <div class="mt-2 flex justify-end gap-1">
            <button class="btn btn-ghost btn-xs" onclick={closeComposer}>{t("common.cancel")}</button>
            <button
              class="btn btn-primary btn-xs"
              disabled={!composerText.trim()}
              onclick={submitComment}
            >
              {t("editor.comment")}
            </button>
          </div>
        </div>
      {/if}
    </div>
  {/if}

  {#if collab.suggestMode}
    <div class="absolute right-3 top-2 z-10">
      <span class="badge badge-warning badge-sm gap-1" title={t("suggest.modeBadgeTitle")}>
        {t("suggest.modeBadge")}
      </span>
    </div>
  {/if}
</div>
