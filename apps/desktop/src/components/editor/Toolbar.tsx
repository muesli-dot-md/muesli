// Docs-style toolbar: every command is a markdown-semantic transform from
// @muesli/editor-core/mdCommands dispatched on the active editor view from
// editorState. Port of src/lib/Toolbar.svelte.
import { useEffect, useMemo, useState } from "react";
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
} from "lucide-react";
import { undo, redo } from "@codemirror/commands";
import type { TransactionSpec } from "@codemirror/state";
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

import { editorStateStore, useEditorState } from "@/state/editorState";
import { useTabs } from "@/state/tabs";
import { usePresence } from "@/state/presence";
import { usePlatform } from "@/state/platform";
// Sibling module still being built by the state agent — import by contract.
import { recorderStore, useRecorder, type RecorderState } from "@/state/recorder";
import { exportHtmlFile, printDocument } from "@/services/docExport";
import { cn } from "@/lib/utils";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import PresenceStack from "./PresenceStack";
import ModeGroup from "./ModeGroup";

const styleLabel: Record<BlockStyle, string> = {
  normal: "Normal text",
  h1: "Heading 1",
  h2: "Heading 2",
  h3: "Heading 3",
  quote: "Quote",
  codeblock: "Code block",
};
const styleOptions: BlockStyle[] = ["normal", "h1", "h2", "h3", "quote", "codeblock"];

function Divider() {
  return <span className="mx-0.5 h-4 w-px shrink-0 bg-border/80" aria-hidden="true" />;
}

export default function Toolbar() {
  const view = useEditorState((s) => s.activeView);
  // Reading selectionEpoch forces a re-render (and the memos below to re-run)
  // whenever the epoch is bumped (i.e. on every cursor move / selection change).
  const selectionEpoch = useEditorState((s) => s.selectionEpoch);
  const canEdit = view !== null;
  const isReading = useTabs((s) => s.active()?.mode === "read");
  const title = useTabs((s) => s.active()?.name ?? "untitled");
  const people = usePresence((s) => s.people);
  const transcription = usePlatform((s) => s.transcription);
  const recording = useRecorder((s: RecorderState) => s.recording);
  const recorderStatus = useRecorder((s: RecorderState) => s.status);

  const activeMarks = useMemo(
    () => (view ? activeInlineMarks(view.state) : new Set<InlineMark>()),
    [view, selectionEpoch],
  );
  const blockStyle = useMemo(
    () => (view ? currentBlockStyle(view.state) : ("normal" as BlockStyle)),
    [view, selectionEpoch],
  );
  const listKind = useMemo(
    () => (view ? currentListKind(view.state) : (null as ListKind | null)),
    [view, selectionEpoch],
  );

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
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkText, setLinkText] = useState("");
  const [linkUrl, setLinkUrl] = useState("");

  function prefillLinkPopover() {
    if (!view) return;
    const sel = view.state.selection.main;
    const selText = view.state.doc.sliceString(sel.from, sel.to);
    if (isProbablyUrl(selText)) {
      setLinkUrl(selText.trim());
      setLinkText("");
    } else {
      setLinkText(selText);
      setLinkUrl("");
    }
  }

  function applyLink() {
    if (!view || !linkUrl.trim()) return;
    dispatch(insertLink(view.state, linkText.trim(), linkUrl.trim()));
    setLinkOpen(false);
  }

  // --- image popover (Insert menu) -------------------------------------------
  const [imageOpen, setImageOpen] = useState(false);
  const [imageUrl, setImageUrl] = useState("");
  const [imageAlt, setImageAlt] = useState("");

  function applyImage() {
    if (!view || !imageUrl.trim()) return;
    const md = `![${imageAlt.trim()}](${imageUrl.trim()})`;
    dispatch(insertBlockSnippet(view.state, md));
    setImageOpen(false);
    setImageUrl("");
    setImageAlt("");
  }

  // Both popovers write through `view` on Apply; once the editor view is gone
  // (reading view, tab teardown) an open popover could only no-op, so they
  // close with it. The prefill fields reset too: the selection they were
  // seeded from died with the view, so it must not resurface on reopen.
  useEffect(() => {
    if (!view) {
      setLinkOpen(false);
      setImageOpen(false);
      setLinkText("");
      setLinkUrl("");
      setImageUrl("");
      setImageAlt("");
    }
  }, [view]);

  type SnippetKind = keyof typeof SNIPPETS;
  function runSnippet(kind: SnippetKind) {
    if (!view) return;
    if (kind === "wikilink") dispatch(insertWikilink(view.state));
    else dispatch(insertBlockSnippet(view.state, SNIPPETS[kind], SNIPPET_CURSOR[kind]));
  }

  function runTable() {
    if (view) dispatch(insertBlockSnippet(view.state, tableSkeleton()));
  }

  // --- export ----------------------------------------------------------------
  // Delivery is desktop-specific (native save dialog / print sheet) — see
  // @/services/docExport. No "Download .md": on desktop the note already lives
  // on disk in the workspace.
  // Export reads the CURRENT text at click time straight from the store — not
  // a render-time closure over a possibly-stale subscription.
  function exportHtml() {
    void exportHtmlFile(title, editorStateStore.getState().currentText);
  }

  function exportPdf() {
    void printDocument(title, editorStateStore.getState().currentText);
  }

  return (
    <div
      className="flex flex-wrap items-center gap-0.5 border-b border-border px-3 py-1"
      role="toolbar"
      aria-label="Formatting toolbar"
    >
      {/* Reading view keeps only Export, presence, and the mode group (the way
          back out): the editing cluster targets the live editor view, which
          does not exist there, so it hides rather than rendering a row of dead
          controls. In edit mode the cluster is always present and disables
          itself via canEdit while the view is still mounting. */}
      {!isReading && (
        <>
          <Button variant="ghost" size="icon-sm" title="Undo" disabled={!canEdit} onClick={runUndo}>
            <Undo2 aria-hidden="true" />
          </Button>
          <Button variant="ghost" size="icon-sm" title="Redo" disabled={!canEdit} onClick={runRedo}>
            <Redo2 aria-hidden="true" />
          </Button>

          <Divider />

          <DropdownMenu>
            <DropdownMenuTrigger
              disabled={!canEdit}
              render={
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-32 justify-between font-normal"
                  title="Text style"
                />
              }
            >
              <span className="truncate">{styleLabel[blockStyle]}</span>
              <ChevronDown className="size-3 opacity-60" aria-hidden="true" />
            </DropdownMenuTrigger>
            <DropdownMenuContent className="w-44">
              {styleOptions.map((style) => (
                <DropdownMenuItem
                  key={style}
                  className={blockStyle === style ? "bg-muted" : undefined}
                  onClick={() => runStyle(style)}
                >
                  {styleLabel[style]}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          <Divider />

          <Button
            variant="ghost"
            size="icon-sm"
            className={cn(activeMarks.has("strong") && "bg-muted text-foreground")}
            aria-pressed={activeMarks.has("strong")}
            title="Bold"
            disabled={!canEdit}
            onClick={() => runMark("strong")}
          >
            <Bold aria-hidden="true" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            className={cn(activeMarks.has("em") && "bg-muted text-foreground")}
            aria-pressed={activeMarks.has("em")}
            title="Italic"
            disabled={!canEdit}
            onClick={() => runMark("em")}
          >
            <Italic aria-hidden="true" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            className={cn(activeMarks.has("strike") && "bg-muted text-foreground")}
            aria-pressed={activeMarks.has("strike")}
            title="Strikethrough"
            disabled={!canEdit}
            onClick={() => runMark("strike")}
          >
            <Strikethrough aria-hidden="true" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            className={cn(activeMarks.has("code") && "bg-muted text-foreground")}
            aria-pressed={activeMarks.has("code")}
            title="Inline code"
            disabled={!canEdit}
            onClick={() => runMark("code")}
          >
            <Code aria-hidden="true" />
          </Button>

          <Divider />

          <Popover
            open={linkOpen}
            onOpenChange={(open) => {
              if (open) prefillLinkPopover();
              setLinkOpen(open);
            }}
          >
            <PopoverTrigger
              disabled={!canEdit}
              render={<Button variant="ghost" size="icon-sm" title="Insert link" />}
            >
              <Link aria-hidden="true" />
            </PopoverTrigger>
            <PopoverContent align="start" className="w-72 p-3">
              <label className="mb-2 block">
                <span className="mb-1 block text-xs text-muted-foreground">Text</span>
                <Input
                  className="h-7 w-full text-sm"
                  value={linkText}
                  onChange={(e) => setLinkText(e.target.value)}
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs text-muted-foreground">URL</span>
                <Input
                  className="h-7 w-full font-mono text-xs"
                  placeholder="https://"
                  autoFocus
                  value={linkUrl}
                  onChange={(e) => setLinkUrl(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") applyLink();
                    if (e.key === "Escape") setLinkOpen(false);
                  }}
                />
              </label>
              <div className="mt-2 flex justify-end gap-1">
                <Button variant="ghost" size="xs" onClick={() => setLinkOpen(false)}>
                  Cancel
                </Button>
                <Button size="xs" disabled={!linkUrl.trim()} onClick={applyLink}>
                  Apply
                </Button>
              </div>
            </PopoverContent>
          </Popover>

          <Divider />

          <Button
            variant="ghost"
            size="icon-sm"
            className={cn(listKind === "task" && "bg-muted text-foreground")}
            aria-pressed={listKind === "task"}
            title="Checklist"
            disabled={!canEdit}
            onClick={() => runList("task")}
          >
            <ListTodo aria-hidden="true" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            className={cn(listKind === "bullet" && "bg-muted text-foreground")}
            aria-pressed={listKind === "bullet"}
            title="Bulleted list"
            disabled={!canEdit}
            onClick={() => runList("bullet")}
          >
            <List aria-hidden="true" />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            className={cn(listKind === "ordered" && "bg-muted text-foreground")}
            aria-pressed={listKind === "ordered"}
            title="Numbered list"
            disabled={!canEdit}
            onClick={() => runList("ordered")}
          >
            <ListOrdered aria-hidden="true" />
          </Button>

          <Divider />

          {/* Insert menu + the image panel it can open. The relative wrapper
              anchors the image panel under the Insert button (as in Svelte). */}
          <div className="relative">
            <DropdownMenu>
              <DropdownMenuTrigger
                disabled={!canEdit}
                render={<Button variant="ghost" size="sm" className="gap-1 font-normal" />}
              >
                <Plus aria-hidden="true" />
                Insert
                <ChevronDown className="size-3 opacity-60" aria-hidden="true" />
              </DropdownMenuTrigger>
              <DropdownMenuContent className="w-56">
                <DropdownMenuItem onClick={runTable}>
                  <Table aria-hidden="true" />
                  Table
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setImageOpen(true)}>
                  <Image aria-hidden="true" />
                  Image by URL
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => runSnippet("hr")}>
                  <Minus aria-hidden="true" />
                  Horizontal rule
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => runSnippet("codeblock")}>
                  <FileCode aria-hidden="true" />
                  Code block
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => runSnippet("math")}>
                  <Sigma aria-hidden="true" />
                  Math block
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => runSnippet("mermaid")}>
                  <Workflow aria-hidden="true" />
                  Mermaid diagram
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => runSnippet("callout")}>
                  <CircleAlert aria-hidden="true" />
                  Callout
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => runSnippet("wikilink")}>
                  <Brackets aria-hidden="true" />
                  Wikilink
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            {imageOpen && (
              <div className="absolute left-0 top-full z-30 mt-1 w-72 rounded-lg border bg-popover p-3 shadow-lg">
                <label className="mb-2 block">
                  <span className="mb-1 block text-xs text-muted-foreground">Image URL</span>
                  <Input
                    className="h-7 w-full font-mono text-xs"
                    placeholder="https://"
                    autoFocus
                    value={imageUrl}
                    onChange={(e) => setImageUrl(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") applyImage();
                      if (e.key === "Escape") setImageOpen(false);
                    }}
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-xs text-muted-foreground">Alt text</span>
                  <Input
                    className="h-7 w-full text-sm"
                    value={imageAlt}
                    onChange={(e) => setImageAlt(e.target.value)}
                  />
                </label>
                <div className="mt-2 flex justify-end gap-1">
                  <Button variant="ghost" size="xs" onClick={() => setImageOpen(false)}>
                    Cancel
                  </Button>
                  <Button size="xs" disabled={!imageUrl.trim()} onClick={applyImage}>
                    Insert image
                  </Button>
                </div>
              </div>
            )}
          </div>

          <Divider />
        </>
      )}

      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button variant="ghost" size="sm" className="gap-1 font-normal" title="Export" />}
        >
          <FileDown aria-hidden="true" />
          Export
          <ChevronDown className="size-3 opacity-60" aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent className="w-52">
          <DropdownMenuItem onClick={exportHtml}>
            <FileCode aria-hidden="true" />
            HTML (.html)
          </DropdownMenuItem>
          <DropdownMenuItem onClick={exportPdf}>
            <Printer aria-hidden="true" />
            PDF (print)
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Record: stream live transcription into this note. macOS-only (the
          feature is hidden entirely on Windows/Linux); filled red while live.
          Hidden in reading view like the rest of the editing cluster, EXCEPT
          while a recording is live — its stop control must stay reachable
          mid-capture. */}
      {transcription && (!isReading || recording) && (
        <>
          <Divider />
          <Button
            variant={recording || recorderStatus === "starting" ? "destructive" : "ghost"}
            size="sm"
            className="gap-1.5 font-normal"
            title={recording ? "Stop recording" : "Record transcription into this note"}
            disabled={recorderStatus === "starting" || (!canEdit && !recording)}
            onClick={() => recorderStore.getState().toggle()}
          >
            {recorderStatus === "starting" ? (
              <>
                <Spinner className="size-3.5" />
                Starting…
              </>
            ) : recording ? (
              <>
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-destructive" />
                Recording
              </>
            ) : (
              <>
                <Mic aria-hidden="true" />
                Record
              </>
            )}
          </Button>
        </>
      )}

      <div className="ml-auto" />

      {/* Presence chips live IN the toolbar row (left of the mode group),
          never absolutely positioned over it: an overlay at the row's right
          end would occlude and steal clicks from the mode group whenever
          collaborators are present. */}
      {people.length > 0 && (
        <div className="mr-2 flex items-center">
          <PresenceStack people={people} />
        </div>
      )}

      <ModeGroup />
    </div>
  );
}
