<script lang="ts">
  // Docs-style toolbar (editor redesign §Toolbar): every command is a
  // markdown-semantic transform from mdCommands.ts dispatched on the session's
  // EditorView. Reactive availability comes from session.editorView; active
  // states re-derive from collab.selection (kept fresh by Editor.svelte).
  import Undo2 from "@lucide/svelte/icons/undo-2";
  import Redo2 from "@lucide/svelte/icons/redo-2";
  import Bold from "@lucide/svelte/icons/bold";
  import Italic from "@lucide/svelte/icons/italic";
  import Strikethrough from "@lucide/svelte/icons/strikethrough";
  import Code from "@lucide/svelte/icons/code";
  import LinkIcon from "@lucide/svelte/icons/link";
  import MessageSquarePlus from "@lucide/svelte/icons/message-square-plus";
  import ListTodo from "@lucide/svelte/icons/list-todo";
  import List from "@lucide/svelte/icons/list";
  import ListOrdered from "@lucide/svelte/icons/list-ordered";
  import Plus from "@lucide/svelte/icons/plus";
  import Download from "@lucide/svelte/icons/download";
  import FileDown from "@lucide/svelte/icons/file-down";
  import Printer from "@lucide/svelte/icons/printer";
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import Pencil from "@lucide/svelte/icons/pencil";
  import MessageSquareText from "@lucide/svelte/icons/message-square-text";
  import Table from "@lucide/svelte/icons/table";
  import ImageIcon from "@lucide/svelte/icons/image";
  import Minus from "@lucide/svelte/icons/minus";
  import FileCode from "@lucide/svelte/icons/file-code";
  import Sigma from "@lucide/svelte/icons/sigma";
  import Workflow from "@lucide/svelte/icons/workflow";
  import CircleAlert from "@lucide/svelte/icons/circle-alert";
  import Brackets from "@lucide/svelte/icons/brackets";
  import { yUndoManagerKeymap } from "y-codemirror.next";
  import type { TransactionSpec } from "@codemirror/state";
  import { t } from "./i18n/index.svelte";
  import { useDocSession } from "./session.svelte";
  import {
    activeInlineMarks,
    currentBlockStyle,
    currentListKind,
    insertBlockSnippet,
    insertLink,
    insertWikilink,
    isProbablyUrl,
    setBlockStyle,
    SNIPPETS,
    SNIPPET_CURSOR,
    tableSkeleton,
    toggleInlineMark,
    toggleList,
    type BlockStyle,
    type InlineMark,
    type ListKind,
  } from "@muesli/editor-core/mdCommands";
  import { downloadHtml, downloadMarkdown, printDocument } from "@muesli/editor-core/docExport";

  let { title }: { title: string } = $props();

  const session = useDocSession();
  const collab = session.store;

  // y-codemirror.next exports undo/redo only through its keymap entries
  // (Mod-z runs undo; the Mod-y entry runs redo).
  const yUndo = yUndoManagerKeymap[0].run!;
  const yRedo = yUndoManagerKeymap[1].run!;

  const view = $derived(session.editorView);
  // suggest mode pauses direct edits (the editor is read-only); only the
  // comment flow and downloads stay live.
  const canEdit = $derived(view !== null && !collab.suggestMode);
  const hasSelection = $derived(collab.selection.from !== collab.selection.to);
  const canComment = $derived(
    hasSelection && collab.availability !== "volatile" && collab.availability !== "auth",
  );

  // Active states, re-derived whenever the selection moves (cheap tree walks).
  const active = $derived.by(() => {
    void collab.selection;
    const v = session.editorView;
    if (!v) {
      return {
        marks: new Set<InlineMark>(),
        block: "normal" as BlockStyle,
        list: null as ListKind | null,
      };
    }
    return {
      marks: activeInlineMarks(v.state),
      block: currentBlockStyle(v.state),
      list: currentListKind(v.state),
    };
  });

  const styleLabel: Record<BlockStyle, () => string> = {
    normal: () => t("toolbar.styleNormal"),
    h1: () => t("toolbar.styleH1"),
    h2: () => t("toolbar.styleH2"),
    h3: () => t("toolbar.styleH3"),
    quote: () => t("toolbar.styleQuote"),
    codeblock: () => t("toolbar.styleCodeBlock"),
  };
  const styleOptions: BlockStyle[] = ["normal", "h1", "h2", "h3", "quote", "codeblock"];

  // daisyUI dropdowns are focus-driven; blur the trigger to close after a pick.
  function closeDropdown() {
    (document.activeElement as HTMLElement | null)?.blur();
  }

  function dispatch(spec: TransactionSpec) {
    const v = session.editorView;
    if (!v || v.state.readOnly) return;
    v.dispatch({ ...spec, userEvent: "input", scrollIntoView: true });
    v.focus();
  }

  function runMark(mark: InlineMark) {
    if (view) dispatch(toggleInlineMark(view.state, mark));
  }

  function runStyle(style: BlockStyle) {
    if (view) dispatch(setBlockStyle(view.state, style));
    closeDropdown();
  }

  function runList(kind: ListKind) {
    if (view) dispatch(toggleList(view.state, kind));
  }

  function runUndo() {
    if (view && !view.state.readOnly) {
      yUndo(view);
      view.focus();
    }
  }

  function runRedo() {
    if (view && !view.state.readOnly) {
      yRedo(view);
      view.focus();
    }
  }

  // --- link popover ----------------------------------------------------------
  let linkOpen = $state(false);
  let linkText = $state("");
  let linkUrl = $state("");

  function openLinkPopover() {
    if (!view) return;
    const sel = view.state.doc.sliceString(collab.selection.from, collab.selection.to);
    // smart prefill: a selected URL becomes the target, other text the label
    if (isProbablyUrl(sel)) {
      linkUrl = sel.trim();
      linkText = "";
    } else {
      linkText = sel;
      linkUrl = "";
    }
    linkOpen = true;
  }

  function applyLink() {
    if (!view || !linkUrl.trim()) return;
    dispatch(insertLink(view.state, linkText.trim(), linkUrl.trim()));
    linkOpen = false;
  }

  // --- image popover (Insert menu) --------------------------------------------
  let imageOpen = $state(false);
  let imageUrl = $state("");
  let imageAlt = $state("");

  function applyImage() {
    if (!view || !imageUrl.trim()) return;
    const md = `![${imageAlt.trim()}](${imageUrl.trim()})`;
    dispatch(insertBlockSnippet(view.state, md));
    imageOpen = false;
    imageUrl = "";
    imageAlt = "";
  }

  type SnippetKind = keyof typeof SNIPPETS;
  function runSnippet(kind: SnippetKind) {
    if (!view) return;
    if (kind === "wikilink") dispatch(insertWikilink(view.state));
    else dispatch(insertBlockSnippet(view.state, SNIPPETS[kind], SNIPPET_CURSOR[kind]));
    closeDropdown();
  }

  function runTable() {
    if (view) dispatch(insertBlockSnippet(view.state, tableSkeleton()));
    closeDropdown();
  }

  // --- download / export --------------------------------------------------------
  function download() {
    downloadMarkdown(session.docId, session.ytext.toString());
  }

  function exportHtml() {
    downloadHtml(session.docId, title, session.ytext.toString());
    closeDropdown();
  }

  function exportPdf() {
    printDocument(title, session.ytext.toString());
    closeDropdown();
  }

  function setMode(suggest: boolean) {
    collab.suggestMode = suggest;
    closeDropdown();
  }
</script>

{#snippet divider()}
  <span class="mx-1 h-5 w-px shrink-0 bg-base-300" aria-hidden="true"></span>
{/snippet}

<div
  class="flex flex-wrap items-center gap-0.5 border-b border-base-300 bg-base-100 px-3 py-1"
  role="toolbar"
  aria-label={t("toolbar.label")}
>
  <button
    class="btn btn-ghost btn-sm btn-square"
    title={t("toolbar.undo")}
    disabled={!canEdit}
    onclick={runUndo}
  >
    <Undo2 class="h-4 w-4" aria-hidden="true" />
  </button>
  <button
    class="btn btn-ghost btn-sm btn-square"
    title={t("toolbar.redo")}
    disabled={!canEdit}
    onclick={runRedo}
  >
    <Redo2 class="h-4 w-4" aria-hidden="true" />
  </button>

  {@render divider()}

  <div class="dropdown">
    <!-- div triggers throughout: Safari/Firefox don't focus <button> on click,
         and daisyUI dropdowns open via :focus-within -->
    <div
      tabindex={canEdit ? 0 : -1}
      role="button"
      class="btn btn-ghost btn-sm w-32 justify-between font-normal"
      class:btn-disabled={!canEdit}
      title={t("toolbar.style")}
    >
      <span class="truncate">{styleLabel[active.block]()}</span>
      <ChevronDown class="h-3 w-3 opacity-60" aria-hidden="true" />
    </div>
    <ul
      class="menu dropdown-content z-30 mt-1 w-44 rounded-box border border-base-300 bg-base-100 p-1 shadow"
    >
      {#each styleOptions as style (style)}
        <li>
          <button
            class={active.block === style ? "menu-active" : ""}
            onclick={() => runStyle(style)}
          >
            {styleLabel[style]()}
          </button>
        </li>
      {/each}
    </ul>
  </div>

  {@render divider()}

  <button
    class="btn btn-ghost btn-sm btn-square {active.marks.has('strong') ? 'btn-active' : ''}"
    title={t("toolbar.bold")}
    disabled={!canEdit}
    onclick={() => runMark("strong")}
  >
    <Bold class="h-4 w-4" aria-hidden="true" />
  </button>
  <button
    class="btn btn-ghost btn-sm btn-square {active.marks.has('em') ? 'btn-active' : ''}"
    title={t("toolbar.italic")}
    disabled={!canEdit}
    onclick={() => runMark("em")}
  >
    <Italic class="h-4 w-4" aria-hidden="true" />
  </button>
  <button
    class="btn btn-ghost btn-sm btn-square {active.marks.has('strike') ? 'btn-active' : ''}"
    title={t("toolbar.strikethrough")}
    disabled={!canEdit}
    onclick={() => runMark("strike")}
  >
    <Strikethrough class="h-4 w-4" aria-hidden="true" />
  </button>
  <button
    class="btn btn-ghost btn-sm btn-square {active.marks.has('code') ? 'btn-active' : ''}"
    title={t("toolbar.inlineCode")}
    disabled={!canEdit}
    onclick={() => runMark("code")}
  >
    <Code class="h-4 w-4" aria-hidden="true" />
  </button>

  {@render divider()}

  <div class="relative">
    <button
      class="btn btn-ghost btn-sm btn-square"
      title={t("toolbar.link")}
      disabled={!canEdit}
      onclick={() => (linkOpen ? (linkOpen = false) : openLinkPopover())}
    >
      <LinkIcon class="h-4 w-4" aria-hidden="true" />
    </button>
    {#if linkOpen}
      <div
        class="absolute left-0 top-full z-30 mt-1 w-72 rounded-box border border-base-300 bg-base-100 p-3 shadow-lg"
      >
        <label class="mb-2 block">
          <span class="mb-1 block text-xs opacity-70">{t("toolbar.linkText")}</span>
          <input class="input input-sm w-full" bind:value={linkText} />
        </label>
        <label class="block">
          <span class="mb-1 block text-xs opacity-70">{t("toolbar.linkUrl")}</span>
          <!-- svelte-ignore a11y_autofocus -->
          <input
            class="input input-sm w-full font-mono text-xs"
            placeholder="https://"
            autofocus
            bind:value={linkUrl}
            onkeydown={(e) => {
              if (e.key === "Enter") applyLink();
              if (e.key === "Escape") linkOpen = false;
            }}
          />
        </label>
        <div class="mt-2 flex justify-end gap-1">
          <button class="btn btn-ghost btn-xs" onclick={() => (linkOpen = false)}
            >{t("common.cancel")}</button
          >
          <button class="btn btn-primary btn-xs" disabled={!linkUrl.trim()} onclick={applyLink}>
            {t("toolbar.linkApply")}
          </button>
        </div>
      </div>
    {/if}
  </div>
  <button
    class="btn btn-ghost btn-sm btn-square"
    title={t("toolbar.comment")}
    disabled={!canComment}
    onclick={() => collab.requestComposer()}
  >
    <MessageSquarePlus class="h-4 w-4" aria-hidden="true" />
  </button>

  {@render divider()}

  <button
    class="btn btn-ghost btn-sm btn-square {active.list === 'task' ? 'btn-active' : ''}"
    title={t("toolbar.checklist")}
    disabled={!canEdit}
    onclick={() => runList("task")}
  >
    <ListTodo class="h-4 w-4" aria-hidden="true" />
  </button>
  <button
    class="btn btn-ghost btn-sm btn-square {active.list === 'bullet' ? 'btn-active' : ''}"
    title={t("toolbar.bulletList")}
    disabled={!canEdit}
    onclick={() => runList("bullet")}
  >
    <List class="h-4 w-4" aria-hidden="true" />
  </button>
  <button
    class="btn btn-ghost btn-sm btn-square {active.list === 'ordered' ? 'btn-active' : ''}"
    title={t("toolbar.numberedList")}
    disabled={!canEdit}
    onclick={() => runList("ordered")}
  >
    <ListOrdered class="h-4 w-4" aria-hidden="true" />
  </button>

  {@render divider()}

  <div class="dropdown">
    <div
      tabindex={canEdit ? 0 : -1}
      role="button"
      class="btn btn-ghost btn-sm gap-1 font-normal"
      class:btn-disabled={!canEdit}
    >
      <Plus class="h-4 w-4" aria-hidden="true" />
      {t("toolbar.insertMenu")}
      <ChevronDown class="h-3 w-3 opacity-60" aria-hidden="true" />
    </div>
    <ul
      class="menu dropdown-content z-30 mt-1 w-56 rounded-box border border-base-300 bg-base-100 p-1 shadow"
    >
      <li>
        <button onclick={runTable}>
          <Table class="h-4 w-4" aria-hidden="true" />
          {t("toolbar.insertTable")}
        </button>
      </li>
      <li>
        <button
          onclick={() => {
            imageOpen = true;
            closeDropdown();
          }}
        >
          <ImageIcon class="h-4 w-4" aria-hidden="true" />
          {t("toolbar.insertImage")}
        </button>
      </li>
      <li>
        <button onclick={() => runSnippet("hr")}>
          <Minus class="h-4 w-4" aria-hidden="true" />
          {t("toolbar.insertHr")}
        </button>
      </li>
      <li>
        <button onclick={() => runSnippet("codeblock")}>
          <FileCode class="h-4 w-4" aria-hidden="true" />
          {t("toolbar.insertCodeBlock")}
        </button>
      </li>
      <li>
        <button onclick={() => runSnippet("math")}>
          <Sigma class="h-4 w-4" aria-hidden="true" />
          {t("toolbar.insertMath")}
        </button>
      </li>
      <li>
        <button onclick={() => runSnippet("mermaid")}>
          <Workflow class="h-4 w-4" aria-hidden="true" />
          {t("toolbar.insertMermaid")}
        </button>
      </li>
      <li>
        <button onclick={() => runSnippet("callout")}>
          <CircleAlert class="h-4 w-4" aria-hidden="true" />
          {t("toolbar.insertCallout")}
        </button>
      </li>
      <li>
        <button onclick={() => runSnippet("wikilink")}>
          <Brackets class="h-4 w-4" aria-hidden="true" />
          {t("toolbar.insertWikilink")}
        </button>
      </li>
    </ul>
  </div>

  {#if imageOpen}
    <div class="relative">
      <div
        class="absolute left-0 top-full z-30 mt-1 w-72 rounded-box border border-base-300 bg-base-100 p-3 shadow-lg"
      >
        <label class="mb-2 block">
          <span class="mb-1 block text-xs opacity-70">{t("toolbar.imageUrl")}</span>
          <!-- svelte-ignore a11y_autofocus -->
          <input
            class="input input-sm w-full font-mono text-xs"
            placeholder="https://"
            autofocus
            bind:value={imageUrl}
            onkeydown={(e) => {
              if (e.key === "Enter") applyImage();
              if (e.key === "Escape") imageOpen = false;
            }}
          />
        </label>
        <label class="block">
          <span class="mb-1 block text-xs opacity-70">{t("toolbar.imageAlt")}</span>
          <input class="input input-sm w-full" bind:value={imageAlt} />
        </label>
        <div class="mt-2 flex justify-end gap-1">
          <button class="btn btn-ghost btn-xs" onclick={() => (imageOpen = false)}
            >{t("common.cancel")}</button
          >
          <button class="btn btn-primary btn-xs" disabled={!imageUrl.trim()} onclick={applyImage}>
            {t("toolbar.insertImageApply")}
          </button>
        </div>
      </div>
    </div>
  {/if}

  {@render divider()}

  <button
    class="btn btn-ghost btn-sm btn-square"
    title={t("toolbar.downloadMd")}
    onclick={download}
  >
    <Download class="h-4 w-4" aria-hidden="true" />
  </button>
  <div class="dropdown">
    <div
      tabindex="0"
      role="button"
      class="btn btn-ghost btn-sm gap-1 font-normal"
      title={t("toolbar.exportMenu")}
    >
      <FileDown class="h-4 w-4" aria-hidden="true" />
      {t("toolbar.exportMenu")}
      <ChevronDown class="h-3 w-3 opacity-60" aria-hidden="true" />
    </div>
    <ul
      class="menu dropdown-content z-30 mt-1 w-52 rounded-box border border-base-300 bg-base-100 p-1 shadow"
    >
      <li>
        <button onclick={exportHtml}>
          <FileCode class="h-4 w-4" aria-hidden="true" />
          {t("toolbar.exportHtml")}
        </button>
      </li>
      <li>
        <button onclick={exportPdf}>
          <Printer class="h-4 w-4" aria-hidden="true" />
          {t("toolbar.exportPdf")}
        </button>
      </li>
    </ul>
  </div>

  <div class="ml-auto"></div>

  {#if collab.availability !== "volatile"}
    <div class="dropdown dropdown-end">
      <div
        tabindex="0"
        role="button"
        class="btn btn-ghost btn-sm gap-1.5 font-normal"
        title={t("toolbar.mode")}
      >
        {#if collab.suggestMode}
          <MessageSquareText class="h-4 w-4" aria-hidden="true" />
          {t("toolbar.modeSuggesting")}
        {:else}
          <Pencil class="h-4 w-4" aria-hidden="true" />
          {t("toolbar.modeEditing")}
        {/if}
        <ChevronDown class="h-3 w-3 opacity-60" aria-hidden="true" />
      </div>
      <ul
        class="menu dropdown-content z-30 mt-1 w-44 rounded-box border border-base-300 bg-base-100 p-1 shadow"
      >
        <li>
          <button class={!collab.suggestMode ? "menu-active" : ""} onclick={() => setMode(false)}>
            <Pencil class="h-4 w-4" aria-hidden="true" />
            {t("toolbar.modeEditing")}
          </button>
        </li>
        <li>
          <button class={collab.suggestMode ? "menu-active" : ""} onclick={() => setMode(true)}>
            <MessageSquareText class="h-4 w-4" aria-hidden="true" />
            {t("toolbar.modeSuggesting")}
          </button>
        </li>
      </ul>
    </div>
  {/if}
</div>
