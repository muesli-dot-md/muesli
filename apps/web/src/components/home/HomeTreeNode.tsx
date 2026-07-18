// Recursive node for the Home "tree" view (spec §3) — mirrors the desktop
// FileTree/TreeNode "Arc depth" pattern: the row itself (.tree-row-wrap)
// carries the active/hover highlight across the pane width, with a
// disclosure chevron and an indent-guide line (.tree-children) marking
// nesting depth. Folders expand/collapse; docs open. Reuses Home's
// drag-drop + context-menu callbacks so behavior matches the list/grid views.

import type { CSSProperties, DragEvent, MouseEvent } from "react";
import { ChevronRight, FileText, Folder, Star } from "lucide-react";

import { useT } from "@/state/i18n";
import type { DocumentSummary, FolderSummary } from "@/services/workspaceApi";
import { FolderOpenGlyph } from "./FolderOpenGlyph";
import type { InfoTarget } from "./InfoPanel";

export interface HomeTreeNodeProps {
  folder: FolderSummary;
  depth: number;
  /** child folders of a given folder id, pre-sorted */
  childFolders: (id: string) => FolderSummary[];
  /** docs whose folder_id === id, pre-sorted */
  folderDocs: (id: string) => DocumentSummary[];
  expanded: Record<string, boolean>;
  toggle: (id: string) => void;
  selectedRef: { kind: "doc" | "folder"; id: string } | null;
  activeSlug: string | null;
  dndEnabled: boolean;
  dropKey: string | null;
  docName: (d: DocumentSummary) => string;
  onSelect: (tgt: InfoTarget) => void;
  onOpen: (tgt: InfoTarget) => void;
  onContextMenu: (e: MouseEvent, tgt: InfoTarget) => void;
  onDragStart: (e: DragEvent, tgt: InfoTarget) => void;
  onDragEnd: () => void;
  onDragOver: (e: DragEvent, destId: string | null, key: string) => void;
  onDragLeave: (key: string) => void;
  onDrop: (e: DragEvent, destId: string | null) => void;
}

export function HomeTreeNode(props: HomeTreeNodeProps) {
  const {
    folder,
    depth,
    childFolders,
    folderDocs,
    expanded,
    toggle,
    selectedRef,
    activeSlug,
    dndEnabled,
    dropKey,
    docName,
    onSelect,
    onOpen,
    onContextMenu,
    onDragStart,
    onDragEnd,
    onDragOver,
    onDragLeave,
    onDrop,
  } = props;
  const t = useT();

  const isOpen = expanded[folder.id] === true;
  const kids = childFolders(folder.id);
  const docs = folderDocs(folder.id);
  const folderTgt: InfoTarget = { kind: "folder", folder };
  const isFolderSelected = selectedRef?.kind === "folder" && selectedRef.id === folder.id;
  const dropping = dropKey === "folder:" + folder.id;

  const rowStyle: CSSProperties = {
    paddingLeft: `${depth * 14 + 12}px`,
    paddingTop: 2,
    paddingBottom: 2,
    paddingRight: 12,
  };

  return (
    <>
      {/* Folder row */}
      <div
        className={`tree-row-wrap flex cursor-pointer items-center select-none ${
          isFolderSelected ? "active" : ""
        } ${dropping ? "drop-target" : ""}`}
        style={rowStyle}
        draggable={dndEnabled}
        onDragStart={(e) => onDragStart(e, folderTgt)}
        onDragEnd={onDragEnd}
        onDragOver={(e) => onDragOver(e, folder.id, "folder:" + folder.id)}
        onDragLeave={() => onDragLeave("folder:" + folder.id)}
        onDrop={(e) => onDrop(e, folder.id)}
        onClick={(e) => {
          e.stopPropagation();
          onSelect(folderTgt);
          toggle(folder.id);
        }}
        onDoubleClick={() => onOpen(folderTgt)}
        onContextMenu={(e) => onContextMenu(e, folderTgt)}
        role="treeitem"
        aria-expanded={isOpen}
        aria-selected={isFolderSelected}
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            toggle(folder.id);
          }
        }}
      >
        <span
          className="shrink-0 text-foreground/45 transition-transform duration-150"
          style={isOpen ? { transform: "rotate(90deg)" } : undefined}
        >
          <ChevronRight size={15} aria-hidden="true" />
        </span>
        <div className="tree-row-label min-w-0 items-center gap-1.5" style={{ padding: "1px 7px" }}>
          {/* --folder-accent (app.css) composes to exactly --arc-accent until the
              user picks a folder hue in Settings → Appearance; both glyphs carry
              the soft same-hue interior wash: .folder-glyph fills the CLOSED
              lucide Folder, and FolderOpenGlyph's closed flap subpath takes the
              same fill (lucide's own FolderOpen path cannot be filled — see
              app.css). Mirrors the desktop's TreeNode. */}
          {isOpen ? (
            <FolderOpenGlyph size={17} className="shrink-0 text-[var(--folder-accent)]" />
          ) : (
            <Folder
              size={17}
              className="folder-glyph shrink-0 text-[var(--folder-accent)]"
              aria-hidden="true"
            />
          )}
          <span className="truncate text-sm">{folder.name}</span>
        </div>
      </div>

      {isOpen && (
        <div
          className="tree-children"
          style={{ "--guide-x": `${depth * 14 + 23}px` } as CSSProperties}
        >
          {kids.map((k) => (
            <HomeTreeNode key={k.id} {...props} folder={k} depth={depth + 1} />
          ))}
          {docs.map((d) => {
            const docTgt: InfoTarget = { kind: "doc", doc: d };
            const isDocSelected = selectedRef?.kind === "doc" && selectedRef.id === d.document_id;
            return (
              <div
                key={d.document_id}
                className={`tree-row-wrap flex cursor-pointer items-center select-none ${
                  isDocSelected || activeSlug === d.slug ? "active" : ""
                }`}
                style={{
                  paddingLeft: `${(depth + 1) * 14 + 12}px`,
                  paddingTop: 2,
                  paddingBottom: 2,
                  paddingRight: 12,
                }}
                draggable={dndEnabled}
                onDragStart={(e) => onDragStart(e, docTgt)}
                onDragEnd={onDragEnd}
                onClick={(e) => {
                  e.stopPropagation();
                  onSelect(docTgt);
                }}
                onDoubleClick={() => onOpen(docTgt)}
                onContextMenu={(e) => onContextMenu(e, docTgt)}
                role="treeitem"
                aria-selected={isDocSelected}
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onOpen(docTgt);
                  }
                }}
              >
                <span className="shrink-0" style={{ width: 15 }} />
                <div
                  className="tree-row-label min-w-0 items-center gap-1.5"
                  style={{ padding: "1px 7px" }}
                >
                  <FileText size={15} className="shrink-0 text-primary" aria-hidden="true" />
                  <span className="truncate text-sm">{docName(d)}</span>
                  {d.starred && (
                    <Star
                      className="h-3 w-3 shrink-0 text-[var(--color-warning)]"
                      fill="currentColor"
                      aria-label={t("home.starred")}
                    />
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}

export default HomeTreeNode;
