// The document browser's three main-pane views (spec §3): list (table), grid
// (cards), and tree (Arc-depth rows via HomeTreeNode). Extracted from
// Home.svelte's template during the React decomposition — HomeShell owns all
// state and passes one callbacks bundle down so behavior stays identical
// across views (selection, open, context menus, kebab, drag-drop relocation).

import type { DragEvent, MouseEvent } from "react";
import { ChevronDown, ChevronUp, EllipsisVertical, FileText, Folder, Star } from "lucide-react";

import { useT } from "@/state/i18n";
import { driveDate, fullDateTime } from "@/services/time";
import type { DocumentSummary, FolderSummary } from "@/services/workspaceApi";
import { HomeTreeNode } from "./HomeTreeNode";
import type { InfoTarget } from "./InfoPanel";

export interface BrowserCallbacks {
  docName: (d: DocumentSummary) => string;
  isSelected: (tgt: InfoTarget) => boolean;
  isDragging: (tgt: InfoTarget) => boolean;
  select: (tgt: InfoTarget) => void;
  openTarget: (tgt: InfoTarget) => void;
  onItemContextMenu: (e: MouseEvent, tgt: InfoTarget) => void;
  onKebab: (e: MouseEvent, tgt: InfoTarget) => void;
  onEmptyContextMenu: (e: MouseEvent) => void;
  clearSelection: () => void;
  startDrag: (e: DragEvent, tgt: InfoTarget) => void;
  endDrag: () => void;
  onDragOver: (e: DragEvent, destId: string | null, key: string) => void;
  onDragLeave: (key: string) => void;
  onDrop: (e: DragEvent, destId: string | null) => void;
  dndEnabled: boolean;
  dropKey: string | null;
}

export interface Listing {
  folders: FolderSummary[];
  docs: DocumentSummary[];
}

export function DocIcon({ className }: { className: string }) {
  return <FileText className={className} aria-hidden="true" />;
}

export function FolderIcon({ className }: { className: string }) {
  // filled, Drive-style
  return <Folder className={className} fill="currentColor" aria-hidden="true" />;
}

/** Row-hover kebab: the per-item "More actions" trigger. */
export function Kebab({ cb, tgt }: { cb: BrowserCallbacks; tgt: InfoTarget }) {
  const t = useT();
  return (
    <button
      type="button"
      className="arc-tap flex h-6 w-6 items-center justify-center rounded-full opacity-0 transition-colors group-hover:opacity-100 hover:bg-[var(--color-base-200)] focus:opacity-100"
      title={t("home.moreActions")}
      onClick={(e) => cb.onKebab(e, tgt)}
    >
      <EllipsisVertical className="h-4 w-4" aria-hidden="true" />
    </button>
  );
}

function StarBadge({ className, label }: { className: string; label: string }) {
  return (
    <Star
      className={`${className} shrink-0 text-[var(--color-warning)]`}
      fill="currentColor"
      aria-label={label}
    />
  );
}

// ---------------------------------------------------------------------------
// List view (table)
// ---------------------------------------------------------------------------

export function ListView({
  cb,
  listing,
  sortKey,
  sortAsc,
  setSort,
}: {
  cb: BrowserCallbacks;
  listing: Listing;
  sortKey: "name" | "modified";
  sortAsc: boolean;
  setSort: (key: "name" | "modified") => void;
}) {
  const t = useT();

  const sortArrow = (key: "name" | "modified") =>
    sortKey === key ? (
      sortAsc ? (
        <ChevronUp className="inline h-3 w-3" aria-hidden="true" />
      ) : (
        <ChevronDown className="inline h-3 w-3" aria-hidden="true" />
      )
    ) : null;

  return (
    <div
      className="min-h-0 flex-1 overflow-y-auto px-3"
      onClick={(e) => {
        if (e.target === e.currentTarget) cb.clearSelection();
      }}
      onContextMenu={cb.onEmptyContextMenu}
    >
      <table className="w-full">
        <thead className="sticky top-0 z-10 bg-[var(--color-base-100)]">
          <tr className="border-b border-[var(--color-base-300)]/60 text-left text-xs text-muted-foreground">
            <th className="px-3 py-2 font-medium">
              <button type="button" className="cursor-pointer" onClick={() => setSort("name")}>
                {t("home.colName")}
                {sortArrow("name")}
              </button>
            </th>
            <th className="w-36 px-3 py-2 font-medium">
              <button type="button" className="cursor-pointer" onClick={() => setSort("modified")}>
                {t("home.colModified")}
                {sortArrow("modified")}
              </button>
            </th>
            <th className="w-20 px-3 py-2">
              <span className="sr-only">{t("home.colActions")}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {listing.folders.map((f) => {
            const tgt: InfoTarget = { kind: "folder", folder: f };
            return (
              <tr
                key={f.id}
                className={`group cursor-pointer border-b border-[var(--color-base-300)]/60 ${
                  cb.dropKey === "folder:" + f.id
                    ? "bg-primary/15 ring-2 ring-inset ring-primary"
                    : cb.isSelected(tgt)
                      ? "bg-primary/10"
                      : "hover:bg-[var(--color-base-200)]/60"
                } ${cb.isDragging(tgt) ? "opacity-40" : ""}`}
                draggable={cb.dndEnabled}
                onDragStart={(e) => cb.startDrag(e, tgt)}
                onDragEnd={cb.endDrag}
                onDragOver={(e) => cb.onDragOver(e, f.id, "folder:" + f.id)}
                onDragLeave={() => cb.onDragLeave("folder:" + f.id)}
                onDrop={(e) => cb.onDrop(e, f.id)}
                onClick={(e) => {
                  e.stopPropagation();
                  cb.select(tgt);
                }}
                onDoubleClick={() => cb.openTarget(tgt)}
                onContextMenu={(e) => cb.onItemContextMenu(e, tgt)}
              >
                <td className="px-3 py-2">
                  <div className="flex min-w-0 items-center gap-3">
                    <FolderIcon className="h-5 w-5 shrink-0 opacity-60" />
                    <span className="truncate font-medium">{f.name}</span>
                  </div>
                </td>
                <td
                  className="px-3 py-2 text-sm tabular-nums opacity-70"
                  title={fullDateTime(f.updated_at)}
                >
                  {driveDate(f.updated_at)}
                </td>
                <td className="px-3 py-2">
                  <div className="flex items-center justify-end gap-1">
                    <Kebab cb={cb} tgt={tgt} />
                  </div>
                </td>
              </tr>
            );
          })}
          {listing.docs.map((d) => {
            const tgt: InfoTarget = { kind: "doc", doc: d };
            return (
              <tr
                key={d.document_id}
                className={`group cursor-pointer border-b border-[var(--color-base-300)]/60 ${
                  cb.isSelected(tgt) ? "bg-primary/10" : "hover:bg-[var(--color-base-200)]/60"
                } ${cb.isDragging(tgt) ? "opacity-40" : ""}`}
                draggable={cb.dndEnabled}
                onDragStart={(e) => cb.startDrag(e, tgt)}
                onDragEnd={cb.endDrag}
                onClick={(e) => {
                  e.stopPropagation();
                  cb.select(tgt);
                }}
                onDoubleClick={() => cb.openTarget(tgt)}
                onContextMenu={(e) => cb.onItemContextMenu(e, tgt)}
              >
                <td className="px-3 py-2">
                  <div className="flex min-w-0 items-center gap-3">
                    <DocIcon className="h-5 w-5 shrink-0 text-primary" />
                    <span className="truncate font-medium">{cb.docName(d)}</span>
                    {/* Starred indicator (migration 0011) */}
                    {d.starred && <StarBadge className="h-3.5 w-3.5" label={t("home.starred")} />}
                    <span className="hidden shrink-0 font-mono text-[11px] opacity-30 lg:inline">
                      {d.slug}.md
                    </span>
                  </div>
                </td>
                <td
                  className="px-3 py-2 text-sm tabular-nums opacity-70"
                  title={fullDateTime(d.updated_at)}
                >
                  {driveDate(d.updated_at)}
                </td>
                <td className="px-3 py-2">
                  <div className="flex items-center justify-end gap-1">
                    <Kebab cb={cb} tgt={tgt} />
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Grid view (cards)
// ---------------------------------------------------------------------------

export function GridView({ cb, listing }: { cb: BrowserCallbacks; listing: Listing }) {
  const t = useT();
  return (
    <div
      className="min-h-0 flex-1 overflow-y-auto px-6 pb-6"
      onClick={(e) => {
        if (e.target === e.currentTarget) cb.clearSelection();
      }}
      onContextMenu={cb.onEmptyContextMenu}
    >
      {listing.folders.length > 0 && (
        <>
          <h2 className="pt-1 pb-2 text-sm font-medium opacity-60">{t("home.foldersHeading")}</h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
            {listing.folders.map((f) => {
              const tgt: InfoTarget = { kind: "folder", folder: f };
              return (
                <div
                  key={f.id}
                  className={`group flex cursor-pointer items-center gap-2.5 rounded-xl px-3.5 py-3 ${
                    cb.dropKey === "folder:" + f.id
                      ? "bg-primary/15 ring-2 ring-primary"
                      : cb.isSelected(tgt)
                        ? "bg-primary/10"
                        : "bg-[var(--color-base-300)]/40 hover:bg-[var(--color-base-300)]/60"
                  } ${cb.isDragging(tgt) ? "opacity-40" : ""}`}
                  draggable={cb.dndEnabled}
                  onDragStart={(e) => cb.startDrag(e, tgt)}
                  onDragEnd={cb.endDrag}
                  onDragOver={(e) => cb.onDragOver(e, f.id, "folder:" + f.id)}
                  onDragLeave={() => cb.onDragLeave("folder:" + f.id)}
                  onDrop={(e) => cb.onDrop(e, f.id)}
                  onClick={(e) => {
                    e.stopPropagation();
                    cb.select(tgt);
                  }}
                  onDoubleClick={() => cb.openTarget(tgt)}
                  onContextMenu={(e) => cb.onItemContextMenu(e, tgt)}
                >
                  <FolderIcon className="h-5 w-5 shrink-0 opacity-60" />
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">{f.name}</span>
                  <Kebab cb={cb} tgt={tgt} />
                </div>
              );
            })}
          </div>
        </>
      )}
      {listing.docs.length > 0 && (
        <>
          <h2 className="pt-4 pb-2 text-sm font-medium opacity-60">{t("home.documentsHeading")}</h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
            {listing.docs.map((d) => {
              const tgt: InfoTarget = { kind: "doc", doc: d };
              return (
                <div
                  key={d.document_id}
                  className={`group cursor-pointer overflow-hidden rounded-xl border border-[var(--color-base-300)] shadow-sm transition-shadow hover:shadow ${
                    cb.isSelected(tgt) ? "bg-primary/10" : "bg-[var(--color-base-100)]"
                  } ${cb.isDragging(tgt) ? "opacity-40" : ""}`}
                  draggable={cb.dndEnabled}
                  onDragStart={(e) => cb.startDrag(e, tgt)}
                  onDragEnd={cb.endDrag}
                  onClick={(e) => {
                    e.stopPropagation();
                    cb.select(tgt);
                  }}
                  onDoubleClick={() => cb.openTarget(tgt)}
                  onContextMenu={(e) => cb.onItemContextMenu(e, tgt)}
                >
                  {/* preview well stays quiet (neutral glyph); the small type
                      icon by the name is the colored one, like Drive */}
                  <div className="flex h-24 items-center justify-center bg-[var(--color-base-200)]">
                    <DocIcon className="h-9 w-9 text-foreground/20" />
                  </div>
                  <div className="flex items-center gap-2 px-3 pt-2.5">
                    <DocIcon className="h-4 w-4 shrink-0 text-primary" />
                    <span
                      className="min-w-0 flex-1 truncate text-sm font-medium"
                      title={cb.docName(d)}
                    >
                      {cb.docName(d)}
                    </span>
                    {/* Starred indicator (migration 0011) */}
                    {d.starred && <StarBadge className="h-3.5 w-3.5" label={t("home.starred")} />}
                    <Kebab cb={cb} tgt={tgt} />
                  </div>
                  <p
                    className="px-3 pt-0.5 pb-2.5 text-xs opacity-50"
                    title={fullDateTime(d.updated_at)}
                  >
                    {driveDate(d.updated_at)}
                  </p>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tree view (Arc-depth rows; opt-in, never the default)
// ---------------------------------------------------------------------------

export function TreeView({
  cb,
  treeRootFolders,
  treeRootDocs,
  treeChildFolders,
  treeFolderDocs,
  expanded,
  toggle,
  selectedRef,
}: {
  cb: BrowserCallbacks;
  treeRootFolders: FolderSummary[];
  treeRootDocs: DocumentSummary[];
  treeChildFolders: (id: string) => FolderSummary[];
  treeFolderDocs: (id: string) => DocumentSummary[];
  expanded: Record<string, boolean>;
  toggle: (id: string) => void;
  selectedRef: { kind: "doc" | "folder"; id: string } | null;
}) {
  const t = useT();
  return (
    // No horizontal padding here — indentation and the pane's side gutter are
    // each row's own padding, so the hover/active highlight spans the width of
    // the pane.
    <div
      className="min-h-0 flex-1 overflow-y-auto pb-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) cb.clearSelection();
      }}
      onContextMenu={cb.onEmptyContextMenu}
    >
      {treeRootFolders.length === 0 && treeRootDocs.length === 0 ? (
        <p className="px-3 pt-6 text-sm opacity-60">{t("home.treeEmpty")}</p>
      ) : (
        <>
          {treeRootFolders.map((f) => (
            <HomeTreeNode
              key={f.id}
              folder={f}
              depth={0}
              childFolders={treeChildFolders}
              folderDocs={treeFolderDocs}
              expanded={expanded}
              toggle={toggle}
              selectedRef={selectedRef}
              activeSlug={null}
              dndEnabled={cb.dndEnabled}
              dropKey={cb.dropKey}
              docName={cb.docName}
              onSelect={cb.select}
              onOpen={cb.openTarget}
              onContextMenu={cb.onItemContextMenu}
              onDragStart={cb.startDrag}
              onDragEnd={cb.endDrag}
              onDragOver={cb.onDragOver}
              onDragLeave={cb.onDragLeave}
              onDrop={cb.onDrop}
            />
          ))}
          {treeRootDocs.map((d) => {
            const docTgt: InfoTarget = { kind: "doc", doc: d };
            return (
              <div
                key={d.document_id}
                className={`tree-row-wrap flex cursor-pointer items-center select-none ${
                  cb.isSelected(docTgt) ? "active" : ""
                }`}
                style={{ paddingLeft: 12, paddingTop: 2, paddingBottom: 2, paddingRight: 12 }}
                draggable={cb.dndEnabled}
                onDragStart={(e) => cb.startDrag(e, docTgt)}
                onDragEnd={cb.endDrag}
                onClick={(e) => {
                  e.stopPropagation();
                  cb.select(docTgt);
                }}
                onDoubleClick={() => cb.openTarget(docTgt)}
                onContextMenu={(e) => cb.onItemContextMenu(e, docTgt)}
                role="treeitem"
                aria-selected={cb.isSelected(docTgt)}
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    cb.openTarget(docTgt);
                  }
                }}
              >
                <span className="shrink-0" style={{ width: 15 }} />
                <div
                  className="tree-row-label min-w-0 items-center gap-1.5"
                  style={{ padding: "1px 7px" }}
                >
                  <DocIcon className="h-[15px] w-[15px] shrink-0 text-primary" />
                  <span className="truncate text-sm">{cb.docName(d)}</span>
                  {d.starred && <StarBadge className="h-3 w-3" label={t("home.starred")} />}
                </div>
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}
