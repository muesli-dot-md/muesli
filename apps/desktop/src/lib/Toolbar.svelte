<script lang="ts">
  // Docs-style toolbar: every command is a markdown-semantic transform from
  // @muesli/editor-core/mdCommands dispatched on the active editor view from editorState.
  import {
    Undo2,
    Redo2,
    Bold,
    Italic,
    Strikethrough,
    Code,
    Link,
    ListTodo,
    List,
    ListOrdered,
    Plus,
    FileDown,
    Printer,
    ChevronDown,
    Table,
    Image,
    Minus,
    FileCode,
    Sigma,
    Workflow,
    CircleAlert,
    Brackets,
    Mic,
  } from "lucide-svelte";
  import { recorder } from "$lib/recorder.svelte";
  import { platform } from "$lib/platform.svelte";
  import { presence } from "$lib/sync/presence.svelte";
  import PresenceStack from "$lib/PresenceStack.svelte";
  import ModeGroup from "$lib/ModeGroup.svelte";
  import { undo, redo } from "@codemirror/commands";
  import type { TransactionSpec } from "@codemirror/state";
  import { editorState } from "$lib/editorState.svelte";
  import { tabs } from "$lib/tabs.svelte";
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
  import { exportHtmlFile, printDocument } from "$lib/docExport";

  const view = $derived(editorState.activeView);
  const canEdit = $derived(view !== null);
  const isReading = $derived(tabs.active()?.mode === "read");

  // Reading selectionEpoch inside each derived forces Svelte 5 to re-run them
  // whenever the epoch is bumped (i.e. on every cursor move / selection change).
  const activeMarks = $derived(
    (void editorState.selectionEpoch, view ? activeInlineMarks(view.state) : new Set<InlineMark>()),
  );
  const blockStyle = $derived(
    (void editorState.selectionEpoch,
    view ? currentBlockStyle(view.state) : ("normal" as BlockStyle)),
  );
  const listKind = $derived(
    (void editorState.selectionEpoch,
    view ? currentListKind(view.state) : (null as ListKind | null)),
  );

  const title = $derived(tabs.active()?.name ?? "untitled");

  const styleLabel: Record<BlockStyle, string> = {
    normal: "Normal text",
    h1: "Heading 1",
    h2: "Heading 2",
    h3: "Heading 3",
    quote: "Quote",
    codeblock: "Code block",
  };
  const styleOptions: BlockStyle[] = ["normal", "h1", "h2", "h3", "quote", "codeblock"];

  // daisyUI dropdowns are focus-driven; blur the trigger to close after a pick.
  function closeDropdown() {
    (document.activeElement as HTMLElement | null)?.blur();
  }

  function dispatch(spec: TransactionSpec) {
    if (!view) return;
    view.dispatch({ ...spec, userEvent: "input", scrollIntoView: true });
    view.focus();
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
    if (view) {
      undo(view);
      view.focus();
    }
  }

  function runRedo() {
    if (view) {
      redo(view);
      view.focus();
    }
  }

  // --- link popover ----------------------------------------------------------
  let linkOpen = $state(false);
  let linkText = $state("");
  let linkUrl = $state("");

  function openLinkPopover() {
    if (!view) return;
    const sel = view.state.selection.main;
    const selText = view.state.doc.sliceString(sel.from, sel.to);
    if (isProbablyUrl(selText)) {
      linkUrl = selText.trim();
      linkText = "";
    } else {
      linkText = selText;
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

  // Both popovers write through `view` on Apply; once the editor view is gone
  // (reading view, tab teardown) an open popover could only no-op, so they
  // close with it. The prefill fields reset too: the selection they were
  // seeded from died with the view, so it must not resurface on reopen.
  $effect(() => {
    if (!view) {
      linkOpen = false;
      imageOpen = false;
      linkText = "";
      linkUrl = "";
      imageUrl = "";
      imageAlt = "";
    }
  });

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

  // --- export ------------------------------------------------------------------
  // Delivery is desktop-specific (native save dialog / print sheet), unlike the
  // web app's browser download/window.open — see $lib/docExport. No "Download
  // .md" here: on desktop the note already lives on disk in the workspace.
  function exportHtml() {
    void exportHtmlFile(title, editorState.currentText);
    closeDropdown();
  }

  function exportPdf() {
    void printDocument(title, editorState.currentText);
    closeDropdown();
  }
</script>

{#snippet divider()}
  <span class="mx-0.5 h-4 w-px shrink-0 bg-base-300/80" aria-hidden="true"></span>
{/snippet}

<div
  class="flex flex-wrap items-center gap-0.5 border-b border-base-300 bg-base-100 px-3 py-1"
  role="toolbar"
  aria-label="Formatting toolbar"
>
  <!-- Reading view keeps only Export, presence, and the mode group (the way
       back out): the editing cluster below targets the live editor view, which
       does not exist there, so it hides rather than rendering a row of dead
       controls. In edit mode the cluster is always present and disables itself
       via canEdit while the view is still mounting. -->
  {#if !isReading}
    <button
      class="btn btn-ghost btn-sm btn-square"
      title="Undo"
      disabled={!canEdit}
      onclick={runUndo}
    >
      <Undo2 class="h-4 w-4" aria-hidden="true" />
    </button>
    <button
      class="btn btn-ghost btn-sm btn-square"
      title="Redo"
      disabled={!canEdit}
      onclick={runRedo}
    >
      <Redo2 class="h-4 w-4" aria-hidden="true" />
    </button>

    {@render divider()}

    <div class="dropdown">
      <div
        tabindex={canEdit ? 0 : -1}
        role="button"
        class="btn btn-ghost btn-sm w-32 justify-between font-normal"
        class:btn-disabled={!canEdit}
        title="Text style"
      >
        <span class="truncate">{styleLabel[blockStyle]}</span>
        <ChevronDown class="h-3 w-3 opacity-60" aria-hidden="true" />
      </div>
      <ul
        class="menu dropdown-content z-30 mt-1 w-44 rounded-box border border-base-300 bg-base-100 p-1 shadow"
      >
        {#each styleOptions as style (style)}
          <li>
            <button
              class={blockStyle === style ? "menu-active" : ""}
              onclick={() => runStyle(style)}
            >
              {styleLabel[style]}
            </button>
          </li>
        {/each}
      </ul>
    </div>

    {@render divider()}

    <button
      class="btn btn-ghost btn-sm btn-square {activeMarks.has('strong') ? 'btn-active' : ''}"
      title="Bold"
      disabled={!canEdit}
      onclick={() => runMark("strong")}
    >
      <Bold class="h-4 w-4" aria-hidden="true" />
    </button>
    <button
      class="btn btn-ghost btn-sm btn-square {activeMarks.has('em') ? 'btn-active' : ''}"
      title="Italic"
      disabled={!canEdit}
      onclick={() => runMark("em")}
    >
      <Italic class="h-4 w-4" aria-hidden="true" />
    </button>
    <button
      class="btn btn-ghost btn-sm btn-square {activeMarks.has('strike') ? 'btn-active' : ''}"
      title="Strikethrough"
      disabled={!canEdit}
      onclick={() => runMark("strike")}
    >
      <Strikethrough class="h-4 w-4" aria-hidden="true" />
    </button>
    <button
      class="btn btn-ghost btn-sm btn-square {activeMarks.has('code') ? 'btn-active' : ''}"
      title="Inline code"
      disabled={!canEdit}
      onclick={() => runMark("code")}
    >
      <Code class="h-4 w-4" aria-hidden="true" />
    </button>

    {@render divider()}

    <div class="relative">
      <button
        class="btn btn-ghost btn-sm btn-square"
        title="Insert link"
        disabled={!canEdit}
        onclick={() => (linkOpen ? (linkOpen = false) : openLinkPopover())}
      >
        <Link class="h-4 w-4" aria-hidden="true" />
      </button>
      {#if linkOpen}
        <div
          class="absolute left-0 top-full z-30 mt-1 w-72 rounded-box border border-base-300 bg-base-100 p-3 shadow-lg"
        >
          <label class="mb-2 block">
            <span class="mb-1 block text-xs opacity-70">Text</span>
            <input class="input input-sm w-full" bind:value={linkText} />
          </label>
          <label class="block">
            <span class="mb-1 block text-xs opacity-70">URL</span>
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
            <button class="btn btn-ghost btn-xs" onclick={() => (linkOpen = false)}>Cancel</button>
            <button class="btn btn-primary btn-xs" disabled={!linkUrl.trim()} onclick={applyLink}>
              Apply
            </button>
          </div>
        </div>
      {/if}
    </div>

    {@render divider()}

    <button
      class="btn btn-ghost btn-sm btn-square {listKind === 'task' ? 'btn-active' : ''}"
      title="Checklist"
      disabled={!canEdit}
      onclick={() => runList("task")}
    >
      <ListTodo class="h-4 w-4" aria-hidden="true" />
    </button>
    <button
      class="btn btn-ghost btn-sm btn-square {listKind === 'bullet' ? 'btn-active' : ''}"
      title="Bulleted list"
      disabled={!canEdit}
      onclick={() => runList("bullet")}
    >
      <List class="h-4 w-4" aria-hidden="true" />
    </button>
    <button
      class="btn btn-ghost btn-sm btn-square {listKind === 'ordered' ? 'btn-active' : ''}"
      title="Numbered list"
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
        Insert
        <ChevronDown class="h-3 w-3 opacity-60" aria-hidden="true" />
      </div>
      <ul
        class="menu dropdown-content z-30 mt-1 w-56 rounded-box border border-base-300 bg-base-100 p-1 shadow"
      >
        <li>
          <button onclick={runTable}>
            <Table class="h-4 w-4" aria-hidden="true" />
            Table
          </button>
        </li>
        <li>
          <button
            onclick={() => {
              imageOpen = true;
              closeDropdown();
            }}
          >
            <Image class="h-4 w-4" aria-hidden="true" />
            Image by URL
          </button>
        </li>
        <li>
          <button onclick={() => runSnippet("hr")}>
            <Minus class="h-4 w-4" aria-hidden="true" />
            Horizontal rule
          </button>
        </li>
        <li>
          <button onclick={() => runSnippet("codeblock")}>
            <FileCode class="h-4 w-4" aria-hidden="true" />
            Code block
          </button>
        </li>
        <li>
          <button onclick={() => runSnippet("math")}>
            <Sigma class="h-4 w-4" aria-hidden="true" />
            Math block
          </button>
        </li>
        <li>
          <button onclick={() => runSnippet("mermaid")}>
            <Workflow class="h-4 w-4" aria-hidden="true" />
            Mermaid diagram
          </button>
        </li>
        <li>
          <button onclick={() => runSnippet("callout")}>
            <CircleAlert class="h-4 w-4" aria-hidden="true" />
            Callout
          </button>
        </li>
        <li>
          <button onclick={() => runSnippet("wikilink")}>
            <Brackets class="h-4 w-4" aria-hidden="true" />
            Wikilink
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
            <span class="mb-1 block text-xs opacity-70">Image URL</span>
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
            <span class="mb-1 block text-xs opacity-70">Alt text</span>
            <input class="input input-sm w-full" bind:value={imageAlt} />
          </label>
          <div class="mt-2 flex justify-end gap-1">
            <button class="btn btn-ghost btn-xs" onclick={() => (imageOpen = false)}>Cancel</button>
            <button class="btn btn-primary btn-xs" disabled={!imageUrl.trim()} onclick={applyImage}>
              Insert image
            </button>
          </div>
        </div>
      </div>
    {/if}

    {@render divider()}
  {/if}

  <div class="dropdown">
    <div tabindex="0" role="button" class="btn btn-ghost btn-sm gap-1 font-normal" title="Export">
      <FileDown class="h-4 w-4" aria-hidden="true" />
      Export
      <ChevronDown class="h-3 w-3 opacity-60" aria-hidden="true" />
    </div>
    <ul
      class="menu dropdown-content z-30 mt-1 w-52 rounded-box border border-base-300 bg-base-100 p-1 shadow"
    >
      <li>
        <button onclick={exportHtml}>
          <FileCode class="h-4 w-4" aria-hidden="true" />
          HTML (.html)
        </button>
      </li>
      <li>
        <button onclick={exportPdf}>
          <Printer class="h-4 w-4" aria-hidden="true" />
          PDF (print)
        </button>
      </li>
    </ul>
  </div>

  <!-- Record: stream live transcription into this note. macOS-only (the feature
       is hidden entirely on Windows/Linux); filled red while live. Hidden in
       reading view like the rest of the editing cluster, EXCEPT while a
       recording is live — its stop control must stay reachable mid-capture. -->
  {#if platform.transcription && (!isReading || recorder.recording)}
    {@render divider()}

    <button
      class="btn btn-sm gap-1.5 font-normal {recorder.recording || recorder.status === 'starting'
        ? 'btn-error'
        : 'btn-ghost'}"
      title={recorder.recording ? "Stop recording" : "Record transcription into this note"}
      disabled={recorder.status === "starting" || (!canEdit && !recorder.recording)}
      onclick={() => recorder.toggle()}
    >
      {#if recorder.status === "starting"}
        <span class="loading loading-spinner loading-xs"></span>
        Starting…
      {:else if recorder.recording}
        <span class="h-1.5 w-1.5 rounded-full bg-error-content animate-pulse"></span>
        Recording
      {:else}
        <Mic class="h-4 w-4" aria-hidden="true" />
        Record
      {/if}
    </button>
  {/if}

  <div class="ml-auto"></div>

  <!-- Presence chips live IN the toolbar row (left of the mode group), never
       absolutely positioned over it: an overlay at the row's right end would
       occlude and steal clicks from the mode group whenever collaborators are
       present. One chip per person, deduped across this user's tabs/apps. -->
  {#if presence.people.length > 0}
    <div class="mr-2 flex items-center">
      <PresenceStack people={presence.people} />
    </div>
  {/if}

  <ModeGroup />
</div>
