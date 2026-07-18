// Home screen (hash route kind "home"): a workspaces sidebar (spec §2), a
// controls toolbar (New file · New folder · Sort · Collapse-all · Search,
// spec §4) atop a main space with list / grid / tree views (spec §3), plus
// right-click context menus and a details side panel. Imports only
// identity/api service modules — no yjs, no doc room, no websocket.
// React decomposition of the old 1800-line Home.svelte: this shell owns ALL
// state; Sidebar/BrowserViews/InfoPanel/HomeTreeNode render from it.

import {
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type FormEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronsDownUp,
  FileText,
  Folder,
  Grid2x2,
  Info,
  List,
  ListTree,
  Star,
} from "lucide-react";
import { toast as sonnerToast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";

import { ContextMenu, type MenuItem } from "@/components/collab/ContextMenu";
import GraphView from "@/components/graph/GraphView";
import {
  OnboardingFlow,
  WorkspaceWizard,
  type OnboardingFlowHost,
} from "@muesli/workspace-setup/react";
import type { WizardHost } from "@muesli/workspace-setup/host";
import { parseStorageCapabilities } from "@muesli/workspace-setup/capabilities";
import type { OnboardingAction, OnboardingContext } from "@muesli/workspace-setup/onboarding";

import { useT, type MessageKey } from "@/state/i18n";
import { authSessionStore } from "@/state/authSession";
import { usePrefs, prefsStore } from "@/state/prefs";
import { gotoDoc, gotoFolder, gotoHome, routeStore, useRoute } from "@/state/route";
import { errMsg } from "@/services/apiError";
import { compareBy, homeMainPanel, inWorkspace } from "@/services/homeWorkspace";
import { fetchMe, httpBase, logout, type AuthInfo, type Me } from "@/services/identity";
import { createAccountApi } from "@/services/accountApi";
import { markLocalOnboarded, shouldShowOnboarding } from "@/services/onboardingGate";
import {
  createWorkspaceApi,
  slugify,
  WorkspaceApiError,
  type DocumentSummary,
  type FolderSummary,
  type WorkspaceSummary,
} from "@/services/workspaceApi";

import { searchPaletteOpen } from "@/components/search/SearchPalette";
import { GridView, ListView, TreeView, type BrowserCallbacks } from "./BrowserViews";
import { InfoPanel, type InfoTarget } from "./InfoPanel";
import { Sidebar } from "./Sidebar";

// SettingsPage is imported dynamically so the home screen never eagerly loads
// the settings sections.
const SettingsPage = lazy(() => import("@/components/settings/SettingsPage"));

const api = createWorkspaceApi({ httpBase });
const accountApi = createAccountApi({ httpBase });

type Modal =
  | { kind: "newDoc" }
  | { kind: "newFolder" }
  | { kind: "newWorkspace" }
  | { kind: "onboarding" }
  | { kind: "rename"; target: InfoTarget }
  | { kind: "move"; target: InfoTarget };

type LoadResult = {
  workspaces: WorkspaceSummary[];
  workspacesLoadFailed: boolean;
  selectedId: string | null;
};

function showToast(msg: string, kind: "info" | "warning" = "info") {
  if (kind === "warning") sonnerToast.warning(msg);
  else sonnerToast(msg);
}

function DocIcon({ className }: { className: string }) {
  return <FileText className={className} aria-hidden="true" />;
}
function FolderIcon({ className }: { className: string }) {
  return <Folder className={className} fill="currentColor" aria-hidden="true" />;
}

export function HomeShell() {
  const t = useT();
  const routeCurrent = useRoute((s) => s.current);
  const homeView = usePrefs((s) => s.homeView);

  // --- data -----------------------------------------------------------------------
  const [auth, setAuth] = useState<AuthInfo>({ mode: "open", user: null });
  const [docs, setDocs] = useState<DocumentSummary[]>([]);
  const [folders, setFolders] = useState<FolderSummary[]>([]);
  // Raw workspace list; the display-name map is derived so the personal
  // workspace's label re-translates when the locale switches.
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  // Sidebar selection (spec §2): the active workspace whose contents the main
  // space shows. Defaults to the personal workspace once the list loads.
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [needsLogin, setNeedsLogin] = useState(false);
  const [error, setError] = useState("");
  // Grandfathered-workspace banner (plan 1b): an admin whose active workspace
  // has no storage bound yet gets nudged to Settings → Connections.
  const [selectedWsUnbound, setSelectedWsUnbound] = useState(false);

  // --- ui state --------------------------------------------------------------------
  const [graphOpen, setGraphOpen] = useState(false);
  const [sortKey, setSortKey] = useState<"name" | "modified">("modified");
  const [sortAsc, setSortAsc] = useState(false);
  const [selectedRef, setSelectedRef] = useState<{ kind: "doc" | "folder"; id: string } | null>(
    null,
  );
  const [infoOpen, setInfoOpen] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({}); // tree-view folder expansion

  const [modal, setModal] = useState<Modal | null>(null);
  const [modalName, setModalName] = useState("");
  const [modalError, setModalError] = useState("");
  const [modalBusy, setModalBusy] = useState(false);
  /** Move picker: null = nothing chosen, "" = root ("My documents"), else folder id. */
  const [moveDest, setMoveDest] = useState<string | null>(null);

  // Set when the page loads on a Drive-OAuth return for the wizard (see the
  // mount effect); reopens the "newWorkspace" modal straight into the resumed step.
  const [wizardResume, setWizardResume] = useState<{
    workspaceId: string;
    outcome: "connected" | "error";
  } | null>(null);
  const [onboardingHost, setOnboardingHost] = useState<OnboardingFlowHost | null>(null);

  // Render-time ref mirrors, so async flows read the latest values.
  const authRef = useRef(auth);
  authRef.current = auth;
  const modalRef = useRef(modal);
  modalRef.current = modal;
  const selectedWorkspaceIdRef = useRef(selectedWorkspaceId);
  selectedWorkspaceIdRef.current = selectedWorkspaceId;

  const docCount = (n: number) =>
    t(n === 1 ? "common.documentCount.one" : "common.documentCount.other", { count: n });

  // --- route ------------------------------------------------------------------------
  const view = routeCurrent.kind === "home" ? routeCurrent.view : "root";
  const folderId = routeCurrent.kind === "home" ? routeCurrent.folderId : null;
  // When the route is #~settings/<section>, the main panel renders the embedded
  // Settings view in place of the document browser; the workspaces sidebar stays.
  const settingsSection = routeCurrent.kind === "settings" ? routeCurrent.section : null;
  // What the main panel shows: settings (deep-link wins) · graph · documents.
  const mainPanel = homeMainPanel(routeCurrent, graphOpen);

  const lastRouteKey = useRef<string | null>(null);
  useEffect(() => {
    if (routeCurrent.kind !== "home") return;
    const key = `${routeCurrent.view}:${routeCurrent.folderId ?? ""}`;
    if (key === lastRouteKey.current) return;
    lastRouteKey.current = key;
    setSelectedRef(null);
    setMenu(null);
  }, [routeCurrent]);

  // --- derived ------------------------------------------------------------------------
  const docName = (d: DocumentSummary) => d.title?.trim() || d.slug;
  const itemName = (tgt: InfoTarget) => (tgt.kind === "doc" ? docName(tgt.doc) : tgt.folder.name);

  // Every workspace shows the name its creator gave it; the localized
  // "My workspace" label is only the fallback for an unnamed personal one.
  const workspaceLabel = (w: WorkspaceSummary): string =>
    w.name.trim() || (w.is_personal ? t("home.myWorkspace") : w.name);
  const workspaceNames: Record<string, string> = useMemo(
    () => Object.fromEntries(workspaces.map((w) => [w.id, workspaceLabel(w)])),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [workspaces, t],
  );

  // The selected workspace (sidebar §2). The personal workspace also owns the
  // ownerless/open-mode rows whose workspace_id is null, so those count as "in"
  // it; every other workspace matches strictly on workspace_id.
  const personalWorkspaceId = useMemo(
    () => workspaces.find((w) => w.is_personal)?.id ?? null,
    [workspaces],
  );
  const selectedWorkspace = workspaces.find((w) => w.id === selectedWorkspaceId) ?? null;
  const inSelectedWorkspace = (wsId: string | null | undefined): boolean =>
    inWorkspace(wsId, selectedWorkspaceId, personalWorkspaceId);

  // Rows scoped to the selected workspace — every other derived list reads these.
  const wsFolders = useMemo(
    () => folders.filter((f) => inSelectedWorkspace(f.workspace_id)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [folders, selectedWorkspaceId, personalWorkspaceId],
  );
  const wsDocs = useMemo(
    () => docs.filter((d) => inSelectedWorkspace(d.workspace_id)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [docs, selectedWorkspaceId, personalWorkspaceId],
  );

  const folderById = useMemo(() => new Map(wsFolders.map((f) => [f.id, f])), [wsFolders]);
  const rootFolders = useMemo(
    () => wsFolders.filter((f) => !f.parent_id).sort((a, b) => a.name.localeCompare(b.name)),
    [wsFolders],
  );
  const childFolders = (id: string) =>
    wsFolders.filter((f) => f.parent_id === id).sort((a, b) => a.name.localeCompare(b.name));

  /** Breadcrumb chain (root-first) for the current folder view. */
  const crumbs = useMemo(() => {
    if (view !== "folder" || !folderId) return [] as FolderSummary[];
    const chain: FolderSummary[] = [];
    let cur = folderById.get(folderId);
    let guard = 0;
    while (cur && guard++ < 100) {
      chain.unshift(cur);
      cur = cur.parent_id ? folderById.get(cur.parent_id) : undefined;
    }
    return chain;
  }, [view, folderId, folderById]);

  // Auto-expand the main-pane tree view down to the folder being viewed.
  useEffect(() => {
    if (view !== "folder" || !folderId) return;
    setExpanded((prev) => {
      const next = { ...prev };
      let changed = false;
      let cur = folderById.get(folderId);
      let guard = 0;
      while (cur && guard++ < 100) {
        if (next[cur.id] !== true) {
          next[cur.id] = true;
          changed = true;
        }
        cur = cur.parent_id ? folderById.get(cur.parent_id) : undefined;
      }
      return changed ? next : prev;
    });
  }, [view, folderId, folderById]);

  // When the route is a folder, keep the sidebar selection in sync with the
  // workspace that owns it (so deep-links land on the right workspace).
  useEffect(() => {
    if (view !== "folder" || !folderId) return;
    const f = folders.find((x) => x.id === folderId);
    if (f && f.workspace_id && f.workspace_id !== selectedWorkspaceId) {
      setSelectedWorkspaceId(f.workspace_id);
    }
  }, [view, folderId, folders, selectedWorkspaceId]);

  // Fetch the selected workspace's detail whenever the selection changes, to
  // drive the grandfathered-storage banner: admin + active + no storage bound.
  useEffect(() => {
    const id = selectedWorkspaceId;
    if (!id) {
      setSelectedWsUnbound(false);
      return;
    }
    let cancelled = false;
    api
      .getWorkspace(id)
      .then((detail) => {
        if (cancelled) return;
        setSelectedWsUnbound(
          detail.role === "admin" && detail.status === "active" && !detail.storage_conn_id,
        );
      })
      .catch(() => {
        if (!cancelled) setSelectedWsUnbound(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedWorkspaceId]);

  // --- sort helper (shared by list/grid/tree) -------------------------------------
  const sortFolders = (fs: FolderSummary[]): FolderSummary[] =>
    [...fs].sort(
      compareBy(
        sortKey,
        sortAsc,
        (f) => f.name,
        (f) => f.updated_at,
      ),
    );
  const sortDocs = (ds: DocumentSummary[]): DocumentSummary[] =>
    [...ds].sort(compareBy(sortKey, sortAsc, docName, (d) => d.updated_at));

  /** Folders/docs for the tree view, scoped to a parent id and sorted. */
  const treeChildFolders = (id: string) => sortFolders(childFolders(id));
  const treeFolderDocs = (id: string) => sortDocs(wsDocs.filter((d) => d.folder_id === id));
  const treeRootFolders = sortFolders(rootFolders);
  const treeRootDocs = sortDocs(wsDocs.filter((d) => !d.folder_id));

  /** What the list/grid area shows: folders first, then documents (within the
   *  current folder of the selected workspace). */
  const listing = useMemo(() => {
    const fs =
      view === "folder"
        ? wsFolders.filter((f) => f.parent_id === folderId)
        : wsFolders.filter((f) => !f.parent_id);
    const ds =
      view === "folder"
        ? wsDocs.filter((d) => d.folder_id === folderId)
        : wsDocs.filter((d) => !d.folder_id);
    return { folders: sortFolders(fs), docs: sortDocs(ds) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, folderId, wsFolders, wsDocs, sortKey, sortAsc]);

  const selectedTarget: InfoTarget | null = useMemo(() => {
    const ref = selectedRef;
    if (!ref) return null;
    if (ref.kind === "doc") {
      const d = docs.find((x) => x.document_id === ref.id);
      return d ? { kind: "doc", doc: d } : null;
    }
    const f = folders.find((x) => x.id === ref.id);
    return f ? { kind: "folder", folder: f } : null;
  }, [selectedRef, docs, folders]);

  const viewLabel = selectedWorkspace ? workspaceLabel(selectedWorkspace) : t("home.myDocuments");

  // --- loading ------------------------------------------------------------------------
  async function load(): Promise<LoadResult> {
    setError("");
    setNeedsLogin(false);
    try {
      const r = await api.listDocuments();
      setDocs(r.documents);
      setFolders(r.folders ?? []); // pre-0008 servers have no folders array
    } catch (e) {
      if (e instanceof WorkspaceApiError && e.status === 401) {
        // The session lapsed (cookie expired mid-visit). Re-probe auth so the
        // top-level gate (App.tsx) flips this whole view to the dedicated
        // AuthPage — signed-out users no longer see the app shell at all.
        setNeedsLogin(true);
        authSessionStore.getState().refresh();
      } else {
        setError(errMsg(e));
      }
    } finally {
      setLoading(false);
    }
    // The sidebar lists the user's workspaces (spec §2); open mode (503) or
    // signed out (401) just leaves it empty. listWorkspaces failing is
    // cosmetic for the sidebar, but the onboarding gate must know the list is
    // unreliable (never guess the create-vs-invited fork over a degraded load).
    let ws: WorkspaceSummary[] = [];
    let failed = false;
    let selectedId = selectedWorkspaceIdRef.current;
    try {
      ws = (await api.listWorkspaces()).workspaces;
      setWorkspaces(ws);
      // Default the sidebar selection to the personal workspace once known,
      // unless the user already picked one (or a folder deep-link set it).
      if (selectedId === null && ws.length > 0) {
        selectedId = ws.find((w) => w.is_personal)?.id ?? ws[0].id;
        setSelectedWorkspaceId(selectedId);
      }
    } catch {
      failed = true;
    }
    return { workspaces: ws, workspacesLoadFailed: failed, selectedId };
  }

  function selectWorkspace(id: string) {
    setSelectedWorkspaceId(id);
    setSelectedRef(null);
    setGraphOpen(false);
    if (view !== "root") gotoHome();
  }

  function refresh() {
    void load();
  }

  function setSort(key: "name" | "modified") {
    if (sortKey === key) {
      setSortAsc((a) => !a);
    } else {
      setSortKey(key);
      setSortAsc(key === "name"); // names A→Z, dates newest-first
    }
  }

  /** Sort-menu helpers: choose the key and direction independently. Picking a
   *  new key resets to its natural direction (names A→Z, dates newest-first). */
  function pickSortKey(key: "name" | "modified") {
    if (sortKey === key) return;
    setSortKey(key);
    setSortAsc(key === "name");
  }

  /** Collapse every expanded folder in the tree view (spec §4 toolbar). */
  function collapseAll() {
    setExpanded({});
  }

  // --- selection / opening ---------------------------------------------------------------
  function select(tgt: InfoTarget) {
    setSelectedRef(
      tgt.kind === "doc"
        ? { kind: "doc", id: tgt.doc.document_id }
        : { kind: "folder", id: tgt.folder.id },
    );
  }
  const isSelected = (tgt: InfoTarget) =>
    selectedRef !== null &&
    selectedRef.kind === tgt.kind &&
    selectedRef.id === (tgt.kind === "doc" ? tgt.doc.document_id : tgt.folder.id);

  function openTarget(tgt: InfoTarget) {
    if (tgt.kind === "doc") gotoDoc(tgt.doc.slug);
    else gotoFolder(tgt.folder.id);
  }

  // Enter opens the selection, Escape clears it — skipped while a modal/menu/
  // graph/search-palette is up or focus sits in a typing surface.
  useEffect(() => {
    const onWindowKeydown = (e: KeyboardEvent) => {
      if (modal || menu || graphOpen || searchPaletteOpen()) return;
      const tgt = e.target as HTMLElement | null;
      if (tgt && (tgt.tagName === "INPUT" || tgt.tagName === "TEXTAREA" || tgt.isContentEditable))
        return;
      if (e.key === "Enter" && selectedTarget) {
        e.preventDefault();
        openTarget(selectedTarget);
      } else if (e.key === "Escape") {
        setSelectedRef(null);
      }
    };
    window.addEventListener("keydown", onWindowKeydown);
    return () => window.removeEventListener("keydown", onWindowKeydown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modal, menu, graphOpen, selectedTarget]);

  // --- context menus ------------------------------------------------------------------
  function openMenuAt(x: number, y: number, items: MenuItem[]) {
    setMenu({ x, y, items });
  }
  function onItemContextMenu(e: ReactMouseEvent, tgt: InfoTarget) {
    e.preventDefault();
    e.stopPropagation();
    select(tgt);
    openMenuAt(e.clientX, e.clientY, itemMenuItems(tgt));
  }
  function onKebab(e: ReactMouseEvent, tgt: InfoTarget) {
    e.stopPropagation();
    select(tgt);
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    openMenuAt(r.left, r.bottom + 4, itemMenuItems(tgt));
  }
  function onEmptyContextMenu(e: ReactMouseEvent) {
    e.preventDefault();
    openMenuAt(e.clientX, e.clientY, emptyMenuItems());
  }

  function itemMenuItems(tgt: InfoTarget): MenuItem[] {
    if (tgt.kind === "folder") {
      return [
        { label: t("ctx.open"), action: () => gotoFolder(tgt.folder.id) },
        "separator",
        { label: t("common.rename"), action: () => openRename(tgt) },
        { label: t("ctx.moveTo"), action: () => openMove(tgt) },
        "separator",
        { label: t("ctx.folderInfo"), action: () => showInfo(tgt) },
        "separator",
        { label: t("ctx.moveToTrash"), danger: true, action: () => void trashTarget(tgt) },
      ];
    }
    const d = tgt.doc;
    const items: MenuItem[] = [
      { label: t("ctx.open"), action: () => gotoDoc(d.slug) },
      {
        label: t("ctx.openNewTab"),
        action: () => void window.open(`#${encodeURIComponent(d.slug)}`, "_blank"),
      },
      "separator",
      { label: t("common.rename"), action: () => openRename(tgt) },
      { label: t("ctx.moveTo"), action: () => openMove(tgt) },
      // Starred / favourites (migration 0011): label + icon reflect current state.
      {
        label: d.starred ? t("ctx.removeFromStarred") : t("ctx.addToStarred"),
        icon: Star,
        action: () => void toggleStar(d),
      },
      "separator",
    ];
    if (auth.mode === "oidc" && auth.user) {
      items.push({ label: t("common.share"), action: () => showInfo(tgt) });
    }
    items.push(
      { label: t("ctx.download"), action: () => void downloadDoc(d) },
      "separator",
      { label: t("ctx.fileInfo"), action: () => showInfo(tgt) },
      { label: t("ctx.moveToTrash"), danger: true, action: () => void trashTarget(tgt) },
    );
    return items;
  }

  function emptyMenuItems(): MenuItem[] {
    return [
      { label: t("home.newFile"), action: () => openModal({ kind: "newDoc" }) },
      { label: t("home.newFolder"), action: () => openModal({ kind: "newFolder" }) },
      "separator",
      { label: t("common.refresh"), action: refresh },
    ];
  }

  function showInfo(tgt: InfoTarget) {
    select(tgt);
    setInfoOpen(true);
  }

  // --- actions ---------------------------------------------------------------------------
  // Star / unstar a document (migration 0011). Optimistic: flip the local flag,
  // then PATCH; on failure revert and toast.
  async function toggleStar(d: DocumentSummary) {
    const next = !d.starred;
    setDocs((prev) =>
      prev.map((x) => (x.document_id === d.document_id ? { ...x, starred: next } : x)),
    );
    try {
      await api.updateDocument(d.slug, { starred: next });
    } catch (e) {
      setDocs((prev) =>
        prev.map((x) => (x.document_id === d.document_id ? { ...x, starred: !next } : x)),
      );
      showToast(errMsg(e), "warning");
    }
  }

  async function trashTarget(tgt: InfoTarget) {
    try {
      if (tgt.kind === "doc") {
        await api.trashDocument(tgt.doc.slug);
        showToast(t("toast.movedToTrash", { name: docName(tgt.doc) }));
      } else {
        const r = await api.trashFolder(tgt.folder.id);
        showToast(
          r.documents
            ? t("toast.movedToTrashWithDocs", {
                name: tgt.folder.name,
                documents: docCount(r.documents),
              })
            : t("toast.movedToTrash", { name: tgt.folder.name }),
        );
      }
      if (isSelected(tgt)) setSelectedRef(null);
      void load();
    } catch (e) {
      showToast(
        e instanceof WorkspaceApiError && e.status === 403
          ? t("toast.noTrashPermission")
          : errMsg(e),
        "warning",
      );
    }
  }

  async function downloadDoc(d: DocumentSummary) {
    try {
      const { text } = await api.getDocumentText(d.slug);
      const url = URL.createObjectURL(new Blob([text], { type: "text/markdown" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `${d.slug}.md`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      showToast(errMsg(e), "warning");
    }
  }

  /** A new doc is minted server-side on first ws connect (the editor we navigate
   *  to), so Home can't PATCH title/folder yet — hand them to DocApp via
   *  sessionStorage; it applies them once the provider reports synced. */
  function placeNewDoc(slug: string, title: string, intoFolder: string | null) {
    sessionStorage.setItem(
      `muesli:pending-place:${slug}`,
      JSON.stringify({ title, ...(intoFolder ? { folder_id: intoFolder } : {}) }),
    );
  }

  // --- modals ------------------------------------------------------------------------------
  function openModal(m: Modal) {
    setModal(m);
    setModalError("");
    setModalBusy(false);
    setModalName(m.kind === "rename" ? itemName(m.target) : "");
    if (m.kind === "move") {
      const cur = m.target.kind === "doc" ? m.target.doc.folder_id : m.target.folder.parent_id;
      setMoveDest(cur ?? "");
    }
    (document.activeElement as HTMLElement | null)?.blur(); // close any open dropdown
  }
  function openRename(tgt: InfoTarget) {
    openModal({ kind: "rename", target: tgt });
  }
  function openMove(tgt: InfoTarget) {
    openModal({ kind: "move", target: tgt });
  }
  function closeModal() {
    setModal(null);
  }

  function submitNewDoc(e: FormEvent) {
    e.preventDefault();
    const name = modalName.trim();
    const slug = slugify(name);
    if (!slug) {
      setModalError(t("modal.docNameFirst"));
      return;
    }
    // The document itself is created server-side on first ws connect; only
    // brand-new slugs get the deferred title/folder placement.
    if (!docs.some((d) => d.slug === slug)) {
      placeNewDoc(slug, name, view === "folder" ? folderId : null);
    }
    setModal(null);
    gotoDoc(slug);
  }

  async function submitNewFolder(e: FormEvent) {
    e.preventDefault();
    const name = modalName.trim();
    if (!name) {
      setModalError(t("modal.folderNameFirst"));
      return;
    }
    setModalBusy(true);
    setModalError("");
    try {
      // Create in the current folder if we're in one; otherwise at the root of
      // the selected workspace (a non-personal workspace needs its id passed
      // explicitly — the personal one is the server default).
      const parentId = view === "folder" ? (folderId ?? undefined) : undefined;
      const wsId =
        !parentId && selectedWorkspaceId && selectedWorkspaceId !== personalWorkspaceId
          ? selectedWorkspaceId
          : undefined;
      const f = await api.createFolder(name, parentId, wsId);
      setModal(null);
      showToast(t("toast.folderCreated", { name: f.name }));
      void load();
    } catch (e) {
      setModalError(
        e instanceof WorkspaceApiError && e.status === 409 ? t("modal.folderExists") : errMsg(e),
      );
    } finally {
      setModalBusy(false);
    }
  }

  // Workspace creation runs the full setup wizard (name → storage → connect →
  // done, plan 1b); see the "newWorkspace" modal branch below. `t`'s param type
  // is narrower (MessageKey) than the host's plain-string signature, hence the
  // cast. Stable adapter (reads live values through refs/stores).
  const wizardHost: WizardHost = useMemo(
    () => ({
      createWorkspace: (name) => api.createWorkspace(name),
      createStorageConnection: (id, body) => api.createStorageConnection(id, body),
      getS3Policy: (bucket, prefix) => api.getS3Policy(bucket, prefix),
      getStorageStatus: (id) => api.getStorageStatus(id),
      getSharePointSetup: () => api.getSharePointSetup(),
      listSharePointLibraries: (id, body) => api.listSharePointLibraries(id, body),
      startDriveOAuth: (id) => {
        // Full-page navigation: the OAuth start is a session-cookie 302 chain
        // (fetch can't follow it) — same rule as ConnectionsSection.connectDrive.
        window.location.href = `${httpBase}/api/workspaces/${encodeURIComponent(id)}/storage/google/start?wizard=1`;
      },
      storageCapabilities: async () => {
        // /api/me reports which backends this server can serve (works before any
        // workspace exists — the first-workspace onboarding case). `auth` already
        // holds the boot probe's answer; missing/older-server data fails open.
        return parseStorageCapabilities(authRef.current.storage);
      },
      onDone: async (workspaceId) => {
        setModal(null);
        setWizardResume(null);
        showToast(t("toast.workspaceReady"));
        await load();
        setSelectedWorkspaceId(workspaceId);
        // Live view read (this host is memoized): same rule as the original —
        // a non-root HOME view returns to the root; settings/doc stay put.
        const r = routeStore.getState().current;
        const liveView = r.kind === "home" ? r.view : "root";
        if (liveView !== "root") gotoHome();
      },
      onCancel: () => {
        setModal(null);
        setWizardResume(null);
      },
      t: (k, p) => t(k as MessageKey, p),
      driveFlow: "redirect",
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [t],
  );

  // --- first-login onboarding (BYO storage phase 3, spec §4) -------------------------

  /** Evaluate the trigger once BOTH /api/me and the workspace list are known.
   *  Context: memberships exist → the affirmative invitee screen (named after
   *  the default-selected workspace), else the create fork. Never over an
   *  OAuth wizard-resume already on screen. */
  function maybeStartOnboarding(a: AuthInfo, d: LoadResult) {
    if (modalRef.current !== null) return;
    // The gate bails (oidc only) when listWorkspaces failed: we can't tell
    // "no workspaces" from "fetch broke", so never guess the fork over a
    // degraded load (fail-quiet, spec §5). This runs once per mount, so the
    // retry is the NEXT session/visit, not later in this one.
    if (!shouldShowOnboarding(a, undefined, d.workspacesLoadFailed)) return;
    const label = (w: WorkspaceSummary) =>
      w.name.trim() || (w.is_personal ? t("home.myWorkspace") : w.name);
    const context: OnboardingContext =
      d.workspaces.length > 0
        ? {
            kind: "invited",
            workspaceName:
              (d.selectedId && label(d.workspaces.find((w) => w.id === d.selectedId) ?? d.workspaces[0])) ||
              d.workspaces[0].name,
          }
        : { kind: "create" };
    setOnboardingHost({
      context,
      finish: finishOnboarding,
      primaryAction: onboardingAction,
      t: (k, p) => t(k as MessageKey, p),
    });
    setModal({ kind: "onboarding" });
  }

  /** Stamp only — closing is the overlay's onFinish callback and NEVER waits on
   *  the network (spec §5): a failed stamp is a console.warn — worst case
   *  onboarding shows once more next session, never a blocking dialog. */
  async function finishOnboarding(_skipped: boolean): Promise<void> {
    const a = authRef.current;
    if (a.mode === "oidc" && a.user) {
      // Optimistic local stamp so this session can't re-trigger.
      setAuth((prev) =>
        prev.user
          ? { ...prev, user: { ...prev.user, onboarded_at: new Date().toISOString() } }
          : prev,
      );
      try {
        await accountApi.patchMe({ onboarded: true });
      } catch (e) {
        console.warn("muesli: onboarding stamp failed — it may show once more next session", e);
      }
    } else {
      markLocalOnboarded();
    }
  }

  /** Screen-3 handover. finish(false) already ran (stamp-at-wizard-open) and
   *  the overlay closed synchronously via onFinish. */
  function onboardingAction(action: OnboardingAction): void {
    if (action === "create") openModal({ kind: "newWorkspace" });
    // "open-invited": nothing to do — Home already selected the workspace.
  }

  async function submitRename(e: FormEvent) {
    e.preventDefault();
    if (modal?.kind !== "rename") return;
    const tgt = modal.target;
    const name = modalName.trim();
    if (!name) {
      setModalError(t("modal.nameEmpty"));
      return;
    }
    setModalBusy(true);
    setModalError("");
    try {
      if (tgt.kind === "doc") {
        await api.updateDocument(tgt.doc.slug, { title: name });
      } else {
        await api.updateFolder(tgt.folder.id, { name });
      }
      setModal(null);
      showToast(t("toast.renamed"));
      void load();
    } catch (e) {
      if (e instanceof WorkspaceApiError && e.status === 502) {
        // the rename stands; storage relocation self-heals on next materialize
        setModal(null);
        showToast(t("toast.renamedStorageLag"));
        void load();
      } else {
        setModalError(
          e instanceof WorkspaceApiError && e.status === 409 ? t("modal.nameInUse") : errMsg(e),
        );
      }
    } finally {
      setModalBusy(false);
    }
  }

  /** Folder ids the move picker must disable: the moved folder + its subtree. */
  const moveDisabled = useMemo(() => {
    if (modal?.kind !== "move" || modal.target.kind !== "folder") return new Set<string>();
    const out = new Set([modal.target.folder.id]);
    let added = true;
    while (added) {
      added = false;
      for (const f of folders) {
        if (f.parent_id && out.has(f.parent_id) && !out.has(f.id)) {
          out.add(f.id);
          added = true;
        }
      }
    }
    return out;
  }, [modal, folders]);

  async function submitMove() {
    if (modal?.kind !== "move" || moveDest === null) return;
    const tgt = modal.target;
    const dest = moveDest === "" ? null : moveDest;
    setModalBusy(true);
    setModalError("");
    try {
      if (tgt.kind === "doc") {
        await api.updateDocument(tgt.doc.slug, { folder_id: dest });
      } else {
        await api.updateFolder(tgt.folder.id, { parent_id: dest });
      }
      setModal(null);
      showToast(t("toast.moved", { name: itemName(tgt) }));
      void load();
    } catch (e) {
      if (e instanceof WorkspaceApiError && e.status === 502) {
        setModal(null);
        showToast(t("toast.movedStorageLag"));
        void load();
      } else {
        setModalError(
          e instanceof WorkspaceApiError && e.status === 409 ? t("modal.destExists") : errMsg(e),
        );
      }
    } finally {
      setModalBusy(false);
    }
  }

  // --- drag & drop (move into folders / out via breadcrumb) -----------------------------
  // HTML5 DnD: files and folders are draggable; folders and breadcrumb segments
  // (incl. the "My documents" root) are drop targets. Pure relocation — never
  // reordering, so the alphabetic/date sort is untouched. The keyboard-accessible
  // path stays the "Move to…" modal. Only enabled in the editable root/folder
  // views (not trash/recent/shared).
  const dndEnabled = view === "root" || view === "folder";
  const [drag, setDrag] = useState<{ target: InfoTarget; forbidden: Set<string> } | null>(null);
  /** Which drop target is currently highlighted: "folder:<id>" / "crumb:<id>" / "root". */
  const [dropKey, setDropKey] = useState<string | null>(null);
  const dragRef = useRef(drag);
  dragRef.current = drag;

  /** A folder plus all its descendants — the set it can never be dropped into. */
  function subtreeOf(rootFolderId: string): Set<string> {
    const out = new Set([rootFolderId]);
    let added = true;
    while (added) {
      added = false;
      for (const f of folders) {
        if (f.parent_id && out.has(f.parent_id) && !out.has(f.id)) {
          out.add(f.id);
          added = true;
        }
      }
    }
    return out;
  }

  function isDragging(tgt: InfoTarget): boolean {
    if (!drag) return false;
    const a = drag.target;
    if (a.kind !== tgt.kind) return false;
    return a.kind === "doc"
      ? a.doc.document_id === (tgt as { doc: DocumentSummary }).doc.document_id
      : a.folder.id === (tgt as { folder: FolderSummary }).folder.id;
  }

  /** Can the item being dragged land in destId (null = root)? Forbids self/own
   * subtree for folders and no-op moves (already in that destination). */
  function canDropInto(destId: string | null): boolean {
    const d = dragRef.current;
    if (!d) return false;
    const tgt = d.target;
    if (tgt.kind === "folder") {
      if (destId !== null && d.forbidden.has(destId)) return false;
      return (tgt.folder.parent_id ?? null) !== destId;
    }
    return (tgt.doc.folder_id ?? null) !== destId;
  }

  function startDrag(e: ReactDragEvent, tgt: InfoTarget) {
    if (!dndEnabled) return;
    setDrag({
      target: tgt,
      forbidden: tgt.kind === "folder" ? subtreeOf(tgt.folder.id) : new Set<string>(),
    });
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", itemName(tgt)); // Firefox needs data to start a drag
    }
  }

  function onDragOver(e: ReactDragEvent, destId: string | null, key: string) {
    if (!canDropInto(destId)) return;
    e.preventDefault(); // permits the drop
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    setDropKey(key);
  }

  function onDragLeaveKey(key: string) {
    setDropKey((cur) => (cur === key ? null : cur));
  }

  function endDrag() {
    setDrag(null);
    setDropKey(null);
  }

  async function onDrop(e: ReactDragEvent, destId: string | null) {
    e.preventDefault();
    const d = dragRef.current;
    const allowed = canDropInto(destId);
    setDropKey(null);
    setDrag(null);
    if (d && allowed) await moveTarget(d.target, destId);
  }

  /** Relocate (drag-drop) — toast-based sibling of submitMove's modal flow. */
  async function moveTarget(tgt: InfoTarget, destId: string | null): Promise<void> {
    try {
      if (tgt.kind === "doc") {
        await api.updateDocument(tgt.doc.slug, { folder_id: destId });
      } else {
        await api.updateFolder(tgt.folder.id, { parent_id: destId });
      }
      showToast(t("toast.moved", { name: itemName(tgt) }));
      void load();
    } catch (e) {
      if (e instanceof WorkspaceApiError && e.status === 502) {
        showToast(t("toast.movedStorageLag"));
        void load();
      } else if (e instanceof WorkspaceApiError && e.status === 409) {
        showToast(t("modal.destExists"), "warning");
      } else {
        showToast(errMsg(e), "warning");
      }
    }
  }

  // --- auth ------------------------------------------------------------------------------
  async function signOut() {
    // true = the browser is off to the IdP's end_session URL (RP-initiated logout).
    if (await logout()) return;
    // No reload: drop the user locally and re-list (a 401 flips to the sign-in state).
    setAuth((a) => ({ ...a, user: null }));
    void load();
  }

  // --- mount ------------------------------------------------------------------------------
  const mountedRef = useRef(false);
  useEffect(() => {
    if (mountedRef.current) return;
    mountedRef.current = true;

    const authReady = fetchMe().then((a) => {
      setAuth(a);
      return a;
    });
    const dataReady = load();

    // Drive OAuth return for the creation wizard (plan 1a: gdrive callback with
    // ?wizard=1 redirects to /?workspace_setup=<id>&storage=connected|error).
    const params = new URLSearchParams(location.search);
    const wsSetup = params.get("workspace_setup");
    const storageOutcome = params.get("storage");
    if (wsSetup && (storageOutcome === "connected" || storageOutcome === "error")) {
      params.delete("workspace_setup");
      params.delete("storage");
      const qs = params.toString();
      history.replaceState(null, "", `${location.pathname}${qs ? `?${qs}` : ""}${location.hash}`);
      setWizardResume({ workspaceId: wsSetup, outcome: storageOutcome });
      openModal({ kind: "newWorkspace" });
    }

    // First-login onboarding (BYO storage phase 3): the trigger needs auth AND
    // the workspace list (create-vs-invited context), so it waits for both.
    void Promise.all([authReady, dataReady]).then(([a, d]) => maybeStartOnboarding(a, d));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- view-callback bundle for the browser views -----------------------------------------
  const browserCb: BrowserCallbacks = {
    docName,
    isSelected,
    isDragging,
    select,
    openTarget,
    onItemContextMenu,
    onKebab,
    onEmptyContextMenu,
    clearSelection: () => setSelectedRef(null),
    startDrag,
    endDrag,
    onDragOver,
    onDragLeave: onDragLeaveKey,
    onDrop: (e, destId) => void onDrop(e, destId),
    dndEnabled,
    dropKey,
  };

  /** Recursive rows of the move picker. */
  function pickerNodes(f: FolderSummary, depth: number): ReactNode {
    return (
      <div key={f.id} className="contents">
        <button
          type="button"
          className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-[var(--color-base-200)] disabled:opacity-40 disabled:hover:bg-transparent ${
            moveDest === f.id ? "bg-primary/10 font-medium" : ""
          }`}
          style={{ paddingLeft: `${depth * 16 + 12}px` }}
          disabled={moveDisabled.has(f.id)}
          onClick={() => setMoveDest(f.id)}
        >
          <FolderIcon className="h-4 w-4 shrink-0 opacity-60" />
          <span className="truncate">{f.name}</span>
        </button>
        {childFolders(f.id).map((k) => pickerNodes(k, depth + 1))}
      </div>
    );
  }

  const modalSpinner = modalBusy ? <Spinner className="size-3.5" /> : null;

  return (
    <div className="flex h-screen flex-col bg-[var(--floor)]">
      <div className="flex min-h-0 flex-1">
        {/* left sidebar (Multica/Linear): workspace selector · search · the
            user's workspaces · Graph pinned at the bottom. The sidebar carries
            identity + nav, so there's no separate top app header. */}
        <Sidebar
          auth={auth}
          workspaces={workspaces}
          selectedWorkspaceId={selectedWorkspaceId}
          graphOpen={graphOpen}
          workspaceLabel={workspaceLabel}
          onSelectWorkspace={selectWorkspace}
          onNewWorkspace={() => openModal({ kind: "newWorkspace" })}
          onOpenGraph={() => setGraphOpen(true)}
          onSignOut={signOut}
        />

        {/* content pane */}
        <main className="min-h-0 min-w-0 flex-1 pr-3 pt-3 pb-3">
          {/* Arc-style lift: the main file-viewer pane floats a little above the
              floor with the layered card shadow, rather than sitting flush. */}
          <div className="flex h-full flex-col overflow-hidden rounded-2xl bg-[var(--color-base-100)] shadow-[var(--shadow-card)]">
            {mainPanel === "settings" && settingsSection ? (
              // Settings renders inside the main panel (the workspaces sidebar
              // to the left stays put). onUserChanged: profile edits (avatar/
              // display name) update Home's auth copy too, so the sidebar chip
              // follows live instead of showing the stale mount-time fetch.
              <Suspense fallback={null}>
                <SettingsPage
                  section={settingsSection}
                  embedded
                  onUserChanged={(user: Me) => setAuth((a) => ({ ...a, user }))}
                />
              </Suspense>
            ) : mainPanel === "graph" ? (
              <GraphView
                root={selectedWorkspaceId}
                activePath={null}
                onOpen={(slug) => gotoDoc(slug)}
                personalWorkspaceId={personalWorkspaceId}
              />
            ) : (
              <>
                {/* Breadcrumb row: the selected workspace is the clickable,
                    drop-target base of the path. At the root the chain is empty,
                    so only the workspace name shows; inside a folder the folder
                    chain follows it. */}
                {(view === "root" || view === "folder") && (
                  <div className="flex items-center justify-between gap-3 px-6 pt-5 pb-2">
                    <h1
                      className="flex min-w-0 items-center gap-1 text-xl"
                      style={{ textWrap: "balance" }}
                    >
                      <button
                        type="button"
                        className={`arc-tap rounded-lg px-2 py-0.5 hover:bg-[var(--color-base-200)] ${
                          dropKey === "root" ? "bg-primary/15 ring-2 ring-primary" : ""
                        }`}
                        onClick={() => gotoHome()}
                        onDragOver={(e) => onDragOver(e, null, "root")}
                        onDragLeave={() => onDragLeaveKey("root")}
                        onDrop={(e) => void onDrop(e, null)}
                      >
                        {viewLabel}
                      </button>
                      {crumbs.map((c, i) => (
                        <span key={c.id} className="contents">
                          <span className="opacity-40" aria-hidden="true">
                            ›
                          </span>
                          {i === crumbs.length - 1 ? (
                            <span className="truncate px-2 py-0.5 font-medium">{c.name}</span>
                          ) : (
                            <button
                              type="button"
                              className={`arc-tap truncate rounded-lg px-2 py-0.5 hover:bg-[var(--color-base-200)] ${
                                dropKey === "crumb:" + c.id
                                  ? "bg-primary/15 ring-2 ring-primary"
                                  : ""
                              }`}
                              onClick={() => gotoFolder(c.id)}
                              onDragOver={(e) => onDragOver(e, c.id, "crumb:" + c.id)}
                              onDragLeave={() => onDragLeaveKey("crumb:" + c.id)}
                              onDrop={(e) => void onDrop(e, c.id)}
                            >
                              {c.name}
                            </button>
                          )}
                        </span>
                      ))}
                    </h1>
                  </div>
                )}

                {/* controls toolbar (§4): New file · New folder · Sort · Collapse-all · view/info */}
                <div className="flex items-center gap-2 px-6 pb-3">
                  <Button variant="outline" onClick={() => openModal({ kind: "newDoc" })}>
                    <DocIcon className="h-4 w-4" />
                    <span className="hidden sm:inline">{t("home.newFile")}</span>
                  </Button>
                  <Button variant="outline" onClick={() => openModal({ kind: "newFolder" })}>
                    <FolderIcon className="h-4 w-4 opacity-70" />
                    <span className="hidden sm:inline">{t("home.newFolder")}</span>
                  </Button>

                  <div
                    className="mx-1 h-5 w-px self-center bg-[var(--color-base-300)]/70"
                    aria-hidden="true"
                  />

                  {/* Sort menu */}
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      render={<Button variant="outline" title={t("home.sort")} />}
                    >
                      <span className="text-sm">
                        {sortKey === "name" ? t("home.colName") : t("home.colModified")}
                      </span>
                      {sortAsc ? (
                        <ArrowUp className="h-3.5 w-3.5 opacity-60" aria-hidden="true" />
                      ) : (
                        <ArrowDown className="h-3.5 w-3.5 opacity-60" aria-hidden="true" />
                      )}
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" className="w-56">
                      <DropdownMenuLabel className="text-xs">{t("home.sortBy")}</DropdownMenuLabel>
                      <DropdownMenuItem
                        className={sortKey === "name" ? "menu-item-selected" : ""}
                        onClick={() => pickSortKey("name")}
                      >
                        <span className="grow text-left">{t("home.colName")}</span>
                        {sortKey === "name" && (
                          <Check className="h-4 w-4 text-primary" aria-hidden="true" />
                        )}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        className={sortKey === "modified" ? "menu-item-selected" : ""}
                        onClick={() => pickSortKey("modified")}
                      >
                        <span className="grow text-left">{t("home.colModified")}</span>
                        {sortKey === "modified" && (
                          <Check className="h-4 w-4 text-primary" aria-hidden="true" />
                        )}
                      </DropdownMenuItem>
                      <DropdownMenuLabel className="text-xs">
                        {t("home.sortOrder")}
                      </DropdownMenuLabel>
                      <DropdownMenuItem
                        className={sortAsc ? "menu-item-selected" : ""}
                        onClick={() => setSortAsc(true)}
                      >
                        <ArrowUp className="h-4 w-4 opacity-70" aria-hidden="true" />
                        <span className="grow text-left">{t("home.sortAsc")}</span>
                        {sortAsc && <Check className="h-4 w-4 text-primary" aria-hidden="true" />}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        className={!sortAsc ? "menu-item-selected" : ""}
                        onClick={() => setSortAsc(false)}
                      >
                        <ArrowDown className="h-4 w-4 opacity-70" aria-hidden="true" />
                        <span className="grow text-left">{t("home.sortDesc")}</span>
                        {!sortAsc && <Check className="h-4 w-4 text-primary" aria-hidden="true" />}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>

                  {homeView === "tree" && (
                    <Button variant="ghost" title={t("home.collapseAll")} onClick={collapseAll}>
                      <ChevronsDownUp className="h-4 w-4" aria-hidden="true" />
                      <span className="hidden text-sm md:inline">{t("home.collapseAll")}</span>
                    </Button>
                  )}

                  {/* view / info switcher. The view picker gets a defined edge
                      (1px border + recessed track) so it reads as a segmented
                      control; the ⓘ info button stays a plain ghost circle. */}
                  <div className="ml-auto flex shrink-0 items-center gap-2">
                    <div className="flex rounded-lg border border-[var(--color-base-300)] bg-[var(--color-base-200)] p-0.5">
                      {(
                        [
                          { id: "list", icon: List, label: t("home.listView") },
                          { id: "grid", icon: Grid2x2, label: t("home.gridView") },
                          { id: "tree", icon: ListTree, label: t("home.treeView") },
                        ] as const
                      ).map(({ id, icon: Icon, label }) => (
                        <button
                          key={id}
                          type="button"
                          className={`arc-tap flex h-7 items-center justify-center rounded-md px-2 transition-colors ${
                            homeView === id
                              ? "bg-[var(--color-base-100)] shadow-[var(--shadow-lift)]"
                              : "text-muted-foreground hover:text-foreground"
                          }`}
                          title={label}
                          aria-label={label}
                          aria-pressed={homeView === id}
                          onClick={() => prefsStore.getState().setHomeView(id)}
                        >
                          <Icon className="h-4 w-4" aria-hidden="true" />
                        </button>
                      ))}
                    </div>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      className="rounded-full"
                      style={
                        infoOpen
                          ? { background: "var(--lift)", boxShadow: "var(--shadow-lift)" }
                          : undefined
                      }
                      title={infoOpen ? t("home.hideDetails") : t("home.viewDetails")}
                      aria-label={infoOpen ? t("home.hideDetails") : t("home.viewDetails")}
                      onClick={() => setInfoOpen((o) => !o)}
                    >
                      <Info className="h-5 w-5" aria-hidden="true" />
                    </Button>
                  </div>
                </div>

                {selectedWsUnbound && (
                  <div className="mx-4 mt-3 flex items-center justify-between rounded-lg border border-[var(--color-warning)]/40 bg-[var(--color-warning)]/10 px-4 py-2 text-sm">
                    <span>{t("home.connectStorageBanner")}</span>
                    <Button
                      variant="outline"
                      size="sm"
                      render={<a href="#~settings/connections" />}
                    >
                      {t("home.connectStorageCta")}
                    </Button>
                  </div>
                )}

                <div className="flex min-h-0 flex-1">
                  <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                    {loading ? (
                      <div className="flex flex-col gap-3 px-6">
                        {Array.from({ length: 5 }, (_, i) => (
                          <Skeleton key={i} className="h-9 w-full" />
                        ))}
                      </div>
                    ) : needsLogin ? (
                      // Session lapsed: the top-level gate is re-probing auth and
                      // will swap this whole view for the dedicated AuthPage.
                      // Hold a calm spinner rather than flashing a sign-in card.
                      <div className="flex flex-1 items-center justify-center pb-16">
                        <Spinner className="size-8 opacity-40" />
                      </div>
                    ) : error ? (
                      <div className="flex flex-1 items-center justify-center pb-16 text-sm opacity-60">
                        {error}
                      </div>
                    ) : listing.folders.length === 0 && listing.docs.length === 0 ? (
                      <div className="flex flex-1 flex-col items-center justify-center gap-3 pb-16">
                        {view === "folder" ? (
                          <>
                            <span className="text-4xl" aria-hidden="true">
                              📁
                            </span>
                            <p className="text-lg font-medium">{t("home.emptyFolderTitle")}</p>
                            <p className="text-sm opacity-60">{t("home.emptyFolderBody")}</p>
                          </>
                        ) : (
                          <>
                            <span className="text-4xl" aria-hidden="true">
                              📄
                            </span>
                            <p className="text-lg font-medium">{t("home.emptyRootTitle")}</p>
                            <p className="text-sm opacity-60">{t("home.emptyRootBody")}</p>
                            <Button size="sm" onClick={() => openModal({ kind: "newDoc" })}>
                              {t("home.newFile")}
                            </Button>
                          </>
                        )}
                      </div>
                    ) : homeView === "list" ? (
                      <ListView
                        cb={browserCb}
                        listing={listing}
                        sortKey={sortKey}
                        sortAsc={sortAsc}
                        setSort={setSort}
                      />
                    ) : homeView === "tree" ? (
                      <TreeView
                        cb={browserCb}
                        treeRootFolders={treeRootFolders}
                        treeRootDocs={treeRootDocs}
                        treeChildFolders={treeChildFolders}
                        treeFolderDocs={treeFolderDocs}
                        expanded={expanded}
                        toggle={(id) => setExpanded((prev) => ({ ...prev, [id]: !prev[id] }))}
                        selectedRef={selectedRef}
                      />
                    ) : (
                      <GridView cb={browserCb} listing={listing} />
                    )}
                  </div>

                  {infoOpen && (
                    <InfoPanel
                      target={selectedTarget}
                      docs={docs}
                      folders={folders}
                      workspaceNames={workspaceNames}
                      api={api}
                      auth={auth}
                      onStar={(d) => void toggleStar(d)}
                      onClose={() => setInfoOpen(false)}
                    />
                  )}
                </div>
              </>
            )}
          </div>
        </main>
      </div>

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />
      )}

      {/* modals */}
      {modal && (
        <Dialog open onOpenChange={(o) => !o && closeModal()}>
          <DialogContent
            className={
              modal.kind === "newWorkspace" || modal.kind === "onboarding"
                ? "sm:max-w-[34rem]"
                : "sm:max-w-[26rem]"
            }
            showCloseButton={false}
          >
            {modal.kind === "newDoc" ? (
              <>
                <h3 className="text-lg font-semibold">{t("home.newFile")}</h3>
                <form className="flex flex-col gap-2" onSubmit={submitNewDoc}>
                  <Input
                    placeholder={t("modal.fileNamePlaceholder")}
                    value={modalName}
                    onChange={(e) => {
                      setModalName(e.target.value);
                      setModalError("");
                    }}
                    autoFocus
                    onFocus={(e) => e.currentTarget.select()}
                  />
                  <p className="font-mono text-xs opacity-50">{slugify(modalName) || "…"}.md</p>
                  {view === "folder" && crumbs.length > 0 && (
                    <p className="text-xs opacity-50">
                      {t("modal.willBeCreatedIn", { folder: crumbs[crumbs.length - 1].name })}
                    </p>
                  )}
                  {modalError && <p className="text-xs text-destructive">{modalError}</p>}
                  <div className="mt-2 flex justify-end gap-2">
                    <Button variant="ghost" type="button" onClick={closeModal}>
                      {t("common.cancel")}
                    </Button>
                    <Button type="submit">{t("common.create")}</Button>
                  </div>
                </form>
              </>
            ) : modal.kind === "newFolder" ? (
              <>
                <h3 className="text-lg font-semibold">{t("home.newFolder")}</h3>
                <form className="flex flex-col gap-2" onSubmit={(e) => void submitNewFolder(e)}>
                  <Input
                    placeholder={t("modal.folderNamePlaceholder")}
                    value={modalName}
                    onChange={(e) => {
                      setModalName(e.target.value);
                      setModalError("");
                    }}
                    autoFocus
                    onFocus={(e) => e.currentTarget.select()}
                  />
                  {view === "folder" && crumbs.length > 0 && (
                    <p className="text-xs opacity-50">
                      {t("modal.willBeCreatedIn", { folder: crumbs[crumbs.length - 1].name })}
                    </p>
                  )}
                  {modalError && <p className="text-xs text-destructive">{modalError}</p>}
                  <div className="mt-2 flex justify-end gap-2">
                    <Button variant="ghost" type="button" onClick={closeModal}>
                      {t("common.cancel")}
                    </Button>
                    <Button type="submit" disabled={modalBusy}>
                      {modalSpinner}
                      {t("common.create")}
                    </Button>
                  </div>
                </form>
              </>
            ) : modal.kind === "newWorkspace" ? (
              <WorkspaceWizard host={wizardHost} resume={wizardResume ?? undefined} />
            ) : modal.kind === "onboarding" ? (
              // First-login onboarding: host.finish only stamps; closing the
              // dialog is the separate onFinish callback (never waits on IO).
              onboardingHost && <OnboardingFlow host={onboardingHost} onFinish={closeModal} />
            ) : modal.kind === "rename" ? (
              <>
                <h3 className="text-lg font-semibold">
                  {modal.target.kind === "doc"
                    ? t("modal.renameDocTitle")
                    : t("modal.renameFolderTitle")}
                </h3>
                <form className="flex flex-col gap-2" onSubmit={(e) => void submitRename(e)}>
                  <Input
                    value={modalName}
                    onChange={(e) => {
                      setModalName(e.target.value);
                      setModalError("");
                    }}
                    autoFocus
                    onFocus={(e) => e.currentTarget.select()}
                  />
                  {modal.target.kind === "doc" && (
                    <p className="font-mono text-xs opacity-50">
                      {t("modal.fileStays", { slug: modal.target.doc.slug })}
                    </p>
                  )}
                  {modalError && <p className="text-xs text-destructive">{modalError}</p>}
                  <div className="mt-2 flex justify-end gap-2">
                    <Button variant="ghost" type="button" onClick={closeModal}>
                      {t("common.cancel")}
                    </Button>
                    <Button type="submit" disabled={modalBusy}>
                      {modalSpinner}
                      {t("common.rename")}
                    </Button>
                  </div>
                </form>
              </>
            ) : (
              // move
              <>
                <h3 className="text-lg font-semibold">
                  {t("modal.moveTitle", { name: itemName(modal.target) })}
                </h3>
                <p className="text-sm opacity-60">{t("modal.chooseDestination")}</p>
                <div className="max-h-72 overflow-y-auto rounded-lg border border-[var(--color-base-300)] py-1">
                  <button
                    type="button"
                    className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-[var(--color-base-200)] ${
                      moveDest === "" ? "bg-primary/10 font-medium" : ""
                    }`}
                    onClick={() => setMoveDest("")}
                  >
                    <DocIcon className="h-4 w-4" />
                    {t("home.myDocuments")}
                  </button>
                  {rootFolders.map((f) => pickerNodes(f, 1))}
                </div>
                {modalError && <p className="mt-2 text-xs text-destructive">{modalError}</p>}
                <div className="flex justify-end gap-2">
                  <Button variant="ghost" type="button" onClick={closeModal}>
                    {t("common.cancel")}
                  </Button>
                  <Button
                    disabled={modalBusy || moveDest === null}
                    onClick={() => void submitMove()}
                  >
                    {modalSpinner}
                    {t("modal.moveHere")}
                  </Button>
                </div>
              </>
            )}
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

export default HomeShell;
