// Docs-style toolbar (editor redesign §Toolbar): every command is a
// markdown-semantic transform from mdCommands dispatched on the session's
// EditorView. Port of src/Toolbar.svelte (the WEB feature set: y-undo/redo,
// style dropdown, marks, link popover, comment, lists, insert menu + image
// panel, Download .md, Export menu, Editing/Suggesting mode dropdown), using
// the desktop Toolbar.tsx shadcn structure where identical.
//
// Reactivity: `view` arrives as a prop from DocApp state (set when the editor
// mounts), and useCollabSnapshot(collab) re-renders on every selection move /
// suggest-mode flip / availability change — active states re-derive from the
// live view state on those version bumps (cheap tree walks).
import { useMemo, useState } from "react";
import {
  Undo2,
  Redo2,
  Bold,
  Italic,
  Strikethrough,
  Code,
  Link as LinkIcon,
  MessageSquarePlus,
  ListTodo,
  List,
  ListOrdered,
  Plus,
  Download,
  FileDown,
  Printer,
  ChevronDown,
  Pencil,
  MessageSquareText,
  Table,
  Image as ImageIcon,
  Minus,
  FileCode,
  Sigma,
  Workflow,
  CircleAlert,
  Brackets,
} from "lucide-react";
import { yUndoManagerKeymap } from "y-codemirror.next";
import type { TransactionSpec } from "@codemirror/state";

import { useT } from "@/state/i18n";
import { useDocSession, useEditorView } from "@/state/session";
import { useCollabSnapshot } from "@/state/collabStore";
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
import { cn } from "@/lib/utils";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

// y-codemirror.next exports undo/redo only through its keymap entries
// (Mod-z runs undo; the Mod-y entry runs redo).
const yUndo = yUndoManagerKeymap[0].run!;
const yRedo = yUndoManagerKeymap[1].run!;

const styleOptions: BlockStyle[] = ["normal", "h1", "h2", "h3", "quote", "codeblock"];

function Divider() {
  return <span className="mx-1 h-5 w-px shrink-0 bg-border/80" aria-hidden="true" />;
}

export default function Toolbar({
  title,
}: {
  /** Display title (for HTML/PDF exports; downloads use the doc slug). */
  title: string;
}) {
  const t = useT();
  const session = useDocSession();
  const collab = session.store;
  const version = useCollabSnapshot(collab);
  // Reactive availability: null until the Editor mounts its view.
  const view = useEditorView(session);

  // suggest mode pauses direct edits (the editor is read-only); only the
  // comment flow and downloads stay live.
  const canEdit = view !== null && !collab.suggestMode;
  const hasSelection = collab.selection.from !== collab.selection.to;
  const canComment =
    hasSelection && collab.availability !== "volatile" && collab.availability !== "auth";

  // Active states, re-derived whenever the selection moves (cheap tree walks;
  // `version` bumps on every selection write from the editor's updateListener).
  const activeMarks = useMemo(
    () => (view ? activeInlineMarks(view.state) : new Set<InlineMark>()),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [view, version],
  );
  const blockStyle = useMemo(
    () => (view ? currentBlockStyle(view.state) : ("normal" as BlockStyle)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [view, version],
  );
  const listKind = useMemo(
    () => (view ? currentListKind(view.state) : (null as ListKind | null)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [view, version],
  );

  const styleLabel: Record<BlockStyle, string> = {
    normal: t("toolbar.styleNormal"),
    h1: t("toolbar.styleH1"),
    h2: t("toolbar.styleH2"),
    h3: t("toolbar.styleH3"),
    quote: t("toolbar.styleQuote"),
    codeblock: t("toolbar.styleCodeBlock"),
  };

  function dispatch(spec: TransactionSpec) {
    if (!view || view.state.readOnly) return;
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
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkText, setLinkText] = useState("");
  const [linkUrl, setLinkUrl] = useState("");

  function prefillLinkPopover() {
    if (!view) return;
    const sel = view.state.doc.sliceString(collab.selection.from, collab.selection.to);
    // smart prefill: a selected URL becomes the target, other text the label
    if (isProbablyUrl(sel)) {
      setLinkUrl(sel.trim());
      setLinkText("");
    } else {
      setLinkText(sel);
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

  type SnippetKind = keyof typeof SNIPPETS;
  function runSnippet(kind: SnippetKind) {
    if (!view) return;
    if (kind === "wikilink") dispatch(insertWikilink(view.state));
    else dispatch(insertBlockSnippet(view.state, SNIPPETS[kind], SNIPPET_CURSOR[kind]));
  }

  function runTable() {
    if (view) dispatch(insertBlockSnippet(view.state, tableSkeleton()));
  }

  // --- download / export -----------------------------------------------------
  function download() {
    downloadMarkdown(session.docId, session.ytext.toString());
  }

  function exportHtml() {
    downloadHtml(session.docId, title, session.ytext.toString());
  }

  function exportPdf() {
    printDocument(title, session.ytext.toString());
  }

  function setMode(suggest: boolean) {
    collab.suggestMode = suggest;
  }

  return (
    <div
      className="flex flex-wrap items-center gap-0.5 border-b border-border bg-background px-3 py-1"
      role="toolbar"
      aria-label={t("toolbar.label")}
    >
      <Button
        variant="ghost"
        size="icon-sm"
        title={t("toolbar.undo")}
        disabled={!canEdit}
        onClick={runUndo}
      >
        <Undo2 aria-hidden="true" />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        title={t("toolbar.redo")}
        disabled={!canEdit}
        onClick={runRedo}
      >
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
              title={t("toolbar.style")}
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
        title={t("toolbar.bold")}
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
        title={t("toolbar.italic")}
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
        title={t("toolbar.strikethrough")}
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
        title={t("toolbar.inlineCode")}
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
          render={<Button variant="ghost" size="icon-sm" title={t("toolbar.link")} />}
        >
          <LinkIcon aria-hidden="true" />
        </PopoverTrigger>
        <PopoverContent align="start" className="w-72 p-3">
          <label className="mb-2 block">
            <span className="mb-1 block text-xs text-muted-foreground">
              {t("toolbar.linkText")}
            </span>
            <Input
              className="h-7 w-full text-sm"
              value={linkText}
              onChange={(e) => setLinkText(e.target.value)}
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs text-muted-foreground">{t("toolbar.linkUrl")}</span>
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
              {t("common.cancel")}
            </Button>
            <Button size="xs" disabled={!linkUrl.trim()} onClick={applyLink}>
              {t("toolbar.linkApply")}
            </Button>
          </div>
        </PopoverContent>
      </Popover>

      <Button
        variant="ghost"
        size="icon-sm"
        title={t("toolbar.comment")}
        disabled={!canComment}
        onClick={() => collab.requestComposer()}
      >
        <MessageSquarePlus aria-hidden="true" />
      </Button>

      <Divider />

      <Button
        variant="ghost"
        size="icon-sm"
        className={cn(listKind === "task" && "bg-muted text-foreground")}
        aria-pressed={listKind === "task"}
        title={t("toolbar.checklist")}
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
        title={t("toolbar.bulletList")}
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
        title={t("toolbar.numberedList")}
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
            {t("toolbar.insertMenu")}
            <ChevronDown className="size-3 opacity-60" aria-hidden="true" />
          </DropdownMenuTrigger>
          <DropdownMenuContent className="w-56">
            <DropdownMenuItem onClick={runTable}>
              <Table aria-hidden="true" />
              {t("toolbar.insertTable")}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setImageOpen(true)}>
              <ImageIcon aria-hidden="true" />
              {t("toolbar.insertImage")}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => runSnippet("hr")}>
              <Minus aria-hidden="true" />
              {t("toolbar.insertHr")}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => runSnippet("codeblock")}>
              <FileCode aria-hidden="true" />
              {t("toolbar.insertCodeBlock")}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => runSnippet("math")}>
              <Sigma aria-hidden="true" />
              {t("toolbar.insertMath")}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => runSnippet("mermaid")}>
              <Workflow aria-hidden="true" />
              {t("toolbar.insertMermaid")}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => runSnippet("callout")}>
              <CircleAlert aria-hidden="true" />
              {t("toolbar.insertCallout")}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => runSnippet("wikilink")}>
              <Brackets aria-hidden="true" />
              {t("toolbar.insertWikilink")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        {imageOpen && (
          <div className="absolute left-0 top-full z-30 mt-1 w-72 rounded-lg border bg-popover p-3 shadow-lg">
            <label className="mb-2 block">
              <span className="mb-1 block text-xs text-muted-foreground">
                {t("toolbar.imageUrl")}
              </span>
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
              <span className="mb-1 block text-xs text-muted-foreground">
                {t("toolbar.imageAlt")}
              </span>
              <Input
                className="h-7 w-full text-sm"
                value={imageAlt}
                onChange={(e) => setImageAlt(e.target.value)}
              />
            </label>
            <div className="mt-2 flex justify-end gap-1">
              <Button variant="ghost" size="xs" onClick={() => setImageOpen(false)}>
                {t("common.cancel")}
              </Button>
              <Button size="xs" disabled={!imageUrl.trim()} onClick={applyImage}>
                {t("toolbar.insertImageApply")}
              </Button>
            </div>
          </div>
        )}
      </div>

      <Divider />

      <Button variant="ghost" size="icon-sm" title={t("toolbar.downloadMd")} onClick={download}>
        <Download aria-hidden="true" />
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="sm"
              className="gap-1 font-normal"
              title={t("toolbar.exportMenu")}
            />
          }
        >
          <FileDown aria-hidden="true" />
          {t("toolbar.exportMenu")}
          <ChevronDown className="size-3 opacity-60" aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent className="w-52">
          <DropdownMenuItem onClick={exportHtml}>
            <FileCode aria-hidden="true" />
            {t("toolbar.exportHtml")}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={exportPdf}>
            <Printer aria-hidden="true" />
            {t("toolbar.exportPdf")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <div className="ml-auto" />

      {collab.availability !== "volatile" && (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="sm"
                className="gap-1.5 font-normal"
                title={t("toolbar.mode")}
              />
            }
          >
            {collab.suggestMode ? (
              <>
                <MessageSquareText aria-hidden="true" />
                {t("toolbar.modeSuggesting")}
              </>
            ) : (
              <>
                <Pencil aria-hidden="true" />
                {t("toolbar.modeEditing")}
              </>
            )}
            <ChevronDown className="size-3 opacity-60" aria-hidden="true" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuItem
              className={!collab.suggestMode ? "bg-muted" : undefined}
              onClick={() => setMode(false)}
            >
              <Pencil aria-hidden="true" />
              {t("toolbar.modeEditing")}
            </DropdownMenuItem>
            <DropdownMenuItem
              className={collab.suggestMode ? "bg-muted" : undefined}
              onClick={() => setMode(true)}
            >
              <MessageSquareText aria-hidden="true" />
              {t("toolbar.modeSuggesting")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}
