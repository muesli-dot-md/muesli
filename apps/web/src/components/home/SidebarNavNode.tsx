// Recursive sidebar navigation row for the active workspace's files/folders
// (the Linear/Multica left-rail tree). Mirrors the Arc-depth pattern: a
// full-width row whose inner pill (.tree-row) carries the neutral-gray hover /
// active highlight, with a disclosure chevron outside the pill. Folders
// expand/collapse AND navigate into the main pane (gotoFolder); docs open
// (gotoDoc). The active row is whatever the current route points at — so the
// open document / current folder shows the gray selected background.
// (Faithful port of SidebarNavNode.svelte; not currently mounted by the Home
// shell — kept for the sidebar-tree direction, same as the Svelte original.)

import { ChevronRight, FileText, Folder, FolderOpen, Star } from "lucide-react";

import { useT } from "@/state/i18n";
import type { DocumentSummary, FolderSummary } from "@/services/workspaceApi";

export interface SidebarNavNodeProps {
  folder: FolderSummary;
  depth: number;
  childFolders: (id: string) => FolderSummary[];
  folderDocs: (id: string) => DocumentSummary[];
  expanded: Record<string, boolean>;
  toggle: (id: string) => void;
  /** route-derived active markers */
  activeFolderId: string | null;
  activeSlug: string | null;
  docName: (d: DocumentSummary) => string;
  onOpenFolder: (id: string) => void;
  onOpenDoc: (slug: string) => void;
}

export function SidebarNavNode(props: SidebarNavNodeProps) {
  const {
    folder,
    depth,
    childFolders,
    folderDocs,
    expanded,
    toggle,
    activeFolderId,
    activeSlug,
    docName,
    onOpenFolder,
    onOpenDoc,
  } = props;
  const t = useT();

  const isOpen = expanded[folder.id] === true;
  const kids = childFolders(folder.id);
  const docs = folderDocs(folder.id);
  const isFolderActive = activeFolderId === folder.id;

  return (
    <>
      {/* Folder row: chevron toggles expansion; the label navigates into the folder. */}
      <div
        className="tree-row-wrap flex items-center select-none"
        style={{
          paddingLeft: `${depth * 14 + 4}px`,
          paddingTop: 1,
          paddingBottom: 1,
          paddingRight: 4,
        }}
      >
        <button
          type="button"
          className="arc-tap flex shrink-0 items-center justify-center rounded text-foreground/45 hover:text-foreground"
          style={{ width: 15, height: 18 }}
          title={isOpen ? t("home.collapse") : t("home.expand")}
          aria-label={isOpen ? t("home.collapse") : t("home.expand")}
          onClick={() => toggle(folder.id)}
        >
          <span
            className="transition-transform duration-150"
            style={isOpen ? { transform: "rotate(90deg)" } : undefined}
          >
            <ChevronRight size={15} aria-hidden="true" />
          </span>
        </button>
        <button
          type="button"
          className={`tree-row flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 ${
            isFolderActive ? "active" : ""
          }`}
          style={{ padding: "2px 7px" }}
          onClick={() => onOpenFolder(folder.id)}
        >
          {isOpen ? (
            <FolderOpen size={17} className="shrink-0 text-foreground/60" aria-hidden="true" />
          ) : (
            <Folder size={17} className="shrink-0 text-foreground/60" aria-hidden="true" />
          )}
          <span className="truncate text-sm">{folder.name}</span>
        </button>
      </div>

      {isOpen && (
        <>
          {kids.map((k) => (
            <SidebarNavNode key={k.id} {...props} folder={k} depth={depth + 1} />
          ))}
          {docs.map((d) => (
            <div
              key={d.document_id}
              className="tree-row-wrap flex items-center select-none"
              style={{
                paddingLeft: `${(depth + 1) * 14 + 4}px`,
                paddingTop: 1,
                paddingBottom: 1,
                paddingRight: 4,
              }}
            >
              <span className="shrink-0" style={{ width: 15 }} />
              <button
                type="button"
                className={`tree-row flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 ${
                  activeSlug === d.slug ? "active" : ""
                }`}
                style={{ padding: "2px 7px" }}
                onClick={() => onOpenDoc(d.slug)}
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
              </button>
            </div>
          ))}
        </>
      )}
    </>
  );
}

export default SidebarNavNode;
