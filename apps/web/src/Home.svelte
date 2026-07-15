<script lang="ts">
  // Home screen (hash route kind "home"): a workspaces sidebar (spec §2), a
  // controls toolbar (New file · New folder · Sort · Collapse-all · Search,
  // spec §4) atop a main space with list / grid / tree views (spec §3), plus
  // right-click context menus and a details side panel. Imports only
  // identity.ts/api modules — no yjs, no doc room, no websocket.
  import ArrowDown from "@lucide/svelte/icons/arrow-down";
  import ArrowUp from "@lucide/svelte/icons/arrow-up";
  import Check from "@lucide/svelte/icons/check";
  import ChevronDown from "@lucide/svelte/icons/chevron-down";
  import ChevronUp from "@lucide/svelte/icons/chevron-up";
  import ChevronsDownUp from "@lucide/svelte/icons/chevrons-down-up";
  import EllipsisVertical from "@lucide/svelte/icons/ellipsis-vertical";
  import FileText from "@lucide/svelte/icons/file-text";
  import Folder from "@lucide/svelte/icons/folder";
  import Grid2x2 from "@lucide/svelte/icons/grid-2x2";
  import Info from "@lucide/svelte/icons/info";
  import List from "@lucide/svelte/icons/list";
  import ListTree from "@lucide/svelte/icons/list-tree";
  import Network from "@lucide/svelte/icons/network";
  import Plus from "@lucide/svelte/icons/plus";
  import Search from "@lucide/svelte/icons/search";
  import Star from "@lucide/svelte/icons/star";
  import { onMount } from "svelte";
  import ContextMenu, { type MenuItem } from "./ContextMenu.svelte";
  import GraphView from "./GraphView.svelte";
  import HomeTreeNode from "./HomeTreeNode.svelte";
  import InfoPanel, { type InfoTarget } from "./InfoPanel.svelte";
  import { openSearchPalette, searchPaletteOpen, searchShortcutHint } from "./SearchPalette.svelte";
  import WorkspaceMenu from "./WorkspaceMenu.svelte";
  import { errMsg } from "./apiError";
  import { t } from "./i18n/index.svelte";
  import { compareBy, homeMainPanel, inWorkspace } from "./homeWorkspace";
  import { avatarLetter } from "./workspaceMenu";
  import { authSession } from "./authSession.svelte";
  import { fetchMe, httpBase, logout, type AuthInfo } from "./identity";
  import { prefs } from "./prefs.svelte";
  import { gotoDoc, gotoFolder, gotoHome, route } from "./route.svelte";
  import { driveDate, fullDateTime } from "./time";
  import {
    createWorkspaceApi,
    slugify,
    WorkspaceApiError,
    type DocumentSummary,
    type FolderSummary,
    type WorkspaceSummary,
  } from "./workspaceApi";
  import WorkspaceWizard from "@muesli/workspace-setup/WorkspaceWizard.svelte";
  import type { WizardHost } from "@muesli/workspace-setup/host";
  import { parseStorageCapabilities } from "@muesli/workspace-setup/capabilities";
  import OnboardingFlow from "@muesli/workspace-setup/OnboardingFlow.svelte";
  import type {
    OnboardingAction,
    OnboardingContext,
    OnboardingHost,
  } from "@muesli/workspace-setup/onboarding";
  import { createAccountApi } from "./accountApi";
  import { markLocalOnboarded, shouldShowOnboarding } from "./onboardingGate";
  import type { MessageKey } from "./i18n/index.svelte";

  const api = createWorkspaceApi({ httpBase });

  // --- data -----------------------------------------------------------------------
  let auth: AuthInfo = $state({ mode: "open", user: null });
  let docs: DocumentSummary[] = $state([]);
  let folders: FolderSummary[] = $state([]);
  // Raw workspace list; the display-name map is derived so the personal
  // workspace's label re-translates when the locale switches.
  let workspaces: WorkspaceSummary[] = $state([]);
  // Every workspace shows the name its creator gave it; the localized
  // "My workspace" label is only the fallback for an unnamed personal one
  // (same rule as workspaceMenuRows).
  const workspaceLabel = (w: WorkspaceSummary): string =>
    w.name.trim() || (w.is_personal ? t("home.myWorkspace") : w.name);
  const workspaceNames: Record<string, string> = $derived(
    Object.fromEntries(workspaces.map((w) => [w.id, workspaceLabel(w)])),
  );
  // Sidebar selection (spec §2): the active workspace whose contents the main
  // space shows. Defaults to the personal workspace once the list loads.
  let selectedWorkspaceId: string | null = $state(null);
  let loading = $state(true);
  let needsLogin = $state(false);
  let error = $state("");
  // listWorkspaces failing is swallowed below (cosmetic — the sidebar just
  // stays empty), but the onboarding gate must know: in OIDC mode an invited
  // user whose fetch failed would otherwise get the wrong "create" fork over
  // their (unrelated) error banner. Only the gate's oidc branch consumes this
  // — on an open-mode server GET /api/workspaces answers 503 by design, so
  // the flag is true on every open-mode load and must not veto the
  // localStorage trigger there (see shouldShowOnboarding).
  let workspacesLoadFailed = $state(false);
  // Grandfathered-workspace banner (plan 1b): an admin whose active workspace has no
  // storage bound yet gets nudged to Settings → Connections. Home only loads the
  // workspace LIST (WorkspaceSummary carries no storage_conn_id), so the selected
  // workspace's detail is fetched lazily below whenever the selection changes.
  let selectedWsUnbound = $state(false);

  // --- ui state --------------------------------------------------------------------
  let graphOpen = $state(false);
  let sortKey: "name" | "modified" = $state("modified");
  let sortAsc = $state(false);
  // view mode lives in prefs.svelte.ts ("muesli:home-view") — shared with Settings → Appearance

  let selectedRef: { kind: "doc" | "folder"; id: string } | null = $state(null);
  let infoOpen = $state(false);
  let menu: { x: number; y: number; items: MenuItem[] } | null = $state(null);
  let expanded: Record<string, boolean> = $state({}); // tree-view folder expansion

  type Modal =
    | { kind: "newDoc" }
    | { kind: "newFolder" }
    | { kind: "newWorkspace" }
    | { kind: "onboarding" }
    | { kind: "rename"; target: InfoTarget }
    | { kind: "move"; target: InfoTarget };
  let modal: Modal | null = $state(null);
  let modalName = $state("");
  let modalError = $state("");
  let modalBusy = $state(false);
  /** Move picker: null = nothing chosen, "" = root ("My documents"), else folder id. */
  let moveDest: string | null = $state(null);

  // --- workspace creation wizard (@muesli/workspace-setup) --------------------------
  // Set when the page loads on a Drive-OAuth return for the wizard (see onMount
  // below); reopens the "newWorkspace" modal straight into the resumed step.
  let wizardResume: { workspaceId: string; outcome: "connected" | "error" } | null = $state(null);

  let toast = $state("");
  let toastKind: "info" | "warning" = $state("info");
  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  function showToast(msg: string, kind: "info" | "warning" = "info") {
    toast = msg;
    toastKind = kind;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toast = ""), 4000);
  }
  const docCount = (n: number) =>
    t(n === 1 ? "common.documentCount.one" : "common.documentCount.other", { count: n });

  // --- route ------------------------------------------------------------------------
  const view = $derived(route.current.kind === "home" ? route.current.view : "root");
  const folderId = $derived(route.current.kind === "home" ? route.current.folderId : null);
  // When the route is #~settings/<section>, the main panel renders the embedded
  // Settings view in place of the document browser; the workspaces sidebar stays.
  const settingsSection = $derived(
    route.current.kind === "settings" ? route.current.section : null,
  );
  // What the main panel shows: settings (deep-link wins) · graph · documents.
  const mainPanel = $derived(homeMainPanel(route.current, graphOpen));

  let lastRouteKey: string | null = null;
  $effect(() => {
    if (route.current.kind !== "home") return;
    const key = `${route.current.view}:${route.current.folderId ?? ""}`;
    if (key === lastRouteKey) return;
    lastRouteKey = key;
    selectedRef = null;
    menu = null;
  });

  // --- derived ------------------------------------------------------------------------
  const docName = (d: DocumentSummary) => d.title?.trim() || d.slug;
  const itemName = (tgt: InfoTarget) => (tgt.kind === "doc" ? docName(tgt.doc) : tgt.folder.name);

  // The selected workspace (sidebar §2). The personal workspace also owns the
  // ownerless/open-mode rows whose workspace_id is null, so those count as "in"
  // it; every other workspace matches strictly on workspace_id.
  const personalWorkspaceId = $derived(workspaces.find((w) => w.is_personal)?.id ?? null);
  const selectedWorkspace = $derived(workspaces.find((w) => w.id === selectedWorkspaceId) ?? null);
  const inSelectedWorkspace = (wsId: string | null | undefined): boolean =>
    inWorkspace(wsId, selectedWorkspaceId, personalWorkspaceId);

  // Rows scoped to the selected workspace — every other derived list reads these.
  const wsFolders = $derived(folders.filter((f) => inSelectedWorkspace(f.workspace_id)));
  const wsDocs = $derived(docs.filter((d) => inSelectedWorkspace(d.workspace_id)));

  const folderById = $derived(new Map(wsFolders.map((f) => [f.id, f])));
  const rootFolders = $derived(
    wsFolders.filter((f) => !f.parent_id).sort((a, b) => a.name.localeCompare(b.name)),
  );
  const childFolders = (id: string) =>
    wsFolders.filter((f) => f.parent_id === id).sort((a, b) => a.name.localeCompare(b.name));

  /** Breadcrumb chain (root-first) for the current folder view. */
  const crumbs = $derived.by(() => {
    if (view !== "folder" || !folderId) return [] as FolderSummary[];
    const chain: FolderSummary[] = [];
    let cur = folderById.get(folderId);
    let guard = 0;
    while (cur && guard++ < 100) {
      chain.unshift(cur);
      cur = cur.parent_id ? folderById.get(cur.parent_id) : undefined;
    }
    return chain;
  });

  // Auto-expand the main-pane tree view down to the folder being viewed.
  $effect(() => {
    if (view !== "folder" || !folderId) return;
    let cur = folderById.get(folderId);
    let guard = 0;
    while (cur && guard++ < 100) {
      expanded[cur.id] = true;
      cur = cur.parent_id ? folderById.get(cur.parent_id) : undefined;
    }
  });

  // When the route is a folder, keep the sidebar selection in sync with the
  // workspace that owns it (so deep-links land on the right workspace).
  $effect(() => {
    if (view !== "folder" || !folderId) return;
    const f = folders.find((x) => x.id === folderId);
    if (f && f.workspace_id && f.workspace_id !== selectedWorkspaceId) {
      selectedWorkspaceId = f.workspace_id;
    }
  });

  // Fetch the selected workspace's detail whenever the selection changes, to
  // drive the grandfathered-storage banner: admin + active + no storage bound.
  $effect(() => {
    const id = selectedWorkspaceId;
    if (!id) {
      selectedWsUnbound = false;
      return;
    }
    let cancelled = false;
    api
      .getWorkspace(id)
      .then((detail) => {
        if (cancelled) return;
        selectedWsUnbound =
          detail.role === "admin" && detail.status === "active" && !detail.storage_conn_id;
      })
      .catch(() => {
        if (!cancelled) selectedWsUnbound = false;
      });
    return () => {
      cancelled = true;
    };
  });

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
  const treeRootFolders = $derived(sortFolders(rootFolders));
  const treeRootDocs = $derived(sortDocs(wsDocs.filter((d) => !d.folder_id)));

  /** What the list/grid area shows: folders first, then documents (within the
   *  current folder of the selected workspace). */
  const listing = $derived.by(() => {
    const fs =
      view === "folder"
        ? wsFolders.filter((f) => f.parent_id === folderId)
        : wsFolders.filter((f) => !f.parent_id);
    const ds =
      view === "folder"
        ? wsDocs.filter((d) => d.folder_id === folderId)
        : wsDocs.filter((d) => !d.folder_id);
    return { folders: sortFolders(fs), docs: sortDocs(ds) };
  });

  const selectedTarget: InfoTarget | null = $derived.by(() => {
    const ref = selectedRef;
    if (!ref) return null;
    if (ref.kind === "doc") {
      const d = docs.find((d) => d.document_id === ref.id);
      return d ? { kind: "doc", doc: d } : null;
    }
    const f = folders.find((f) => f.id === ref.id);
    return f ? { kind: "folder", folder: f } : null;
  });

  const viewLabel = $derived(
    selectedWorkspace ? workspaceLabel(selectedWorkspace) : t("home.myDocuments"),
  );

  // --- loading ------------------------------------------------------------------------
  async function load() {
    error = "";
    needsLogin = false;
    try {
      const r = await api.listDocuments();
      docs = r.documents;
      folders = r.folders ?? []; // pre-0008 servers have no folders array
    } catch (e) {
      if (e instanceof WorkspaceApiError && e.status === 401) {
        // The session lapsed (cookie expired mid-visit). Re-probe auth so the
        // top-level gate (App.svelte) flips this whole view to the dedicated
        // AuthPage — signed-out users no longer see the app shell at all.
        needsLogin = true;
        authSession.refresh();
      } else {
        error = errMsg(e);
      }
    } finally {
      loading = false;
    }
    // The sidebar lists the user's workspaces (spec §2); open mode (503) or
    // signed out (401) just leaves it empty.
    workspacesLoadFailed = false;
    try {
      workspaces = (await api.listWorkspaces()).workspaces;
      // Default the sidebar selection to the personal workspace once known,
      // unless the user already picked one (or a folder deep-link set it).
      if (selectedWorkspaceId === null && workspaces.length > 0) {
        selectedWorkspaceId = workspaces.find((w) => w.is_personal)?.id ?? workspaces[0].id;
      }
    } catch {
      // cosmetic only for the sidebar, but the onboarding gate must know the
      // list is unreliable (see workspacesLoadFailed's declaration).
      workspacesLoadFailed = true;
    }
  }

  function selectWorkspace(id: string) {
    selectedWorkspaceId = id;
    selectedRef = null;
    graphOpen = false;
    if (view !== "root") gotoHome();
  }

  function refresh() {
    void load();
  }

  function setSort(key: "name" | "modified") {
    if (sortKey === key) {
      sortAsc = !sortAsc;
    } else {
      sortKey = key;
      sortAsc = key === "name"; // names A→Z, dates newest-first
    }
  }

  /** Sort-menu helpers: choose the key and direction independently. Picking a
   *  new key resets to its natural direction (names A→Z, dates newest-first). */
  function setSortKey(key: "name" | "modified") {
    if (sortKey === key) return;
    sortKey = key;
    sortAsc = key === "name";
  }
  function setSortDir(asc: boolean) {
    sortAsc = asc;
  }

  /** Collapse every expanded folder in the tree view (spec §4 toolbar). */
  function collapseAll() {
    expanded = {};
  }

  // --- selection / opening ---------------------------------------------------------------
  function select(tgt: InfoTarget) {
    selectedRef =
      tgt.kind === "doc"
        ? { kind: "doc", id: tgt.doc.document_id }
        : { kind: "folder", id: tgt.folder.id };
  }
  const isSelected = (tgt: InfoTarget) =>
    selectedRef !== null &&
    selectedRef.kind === tgt.kind &&
    selectedRef.id === (tgt.kind === "doc" ? tgt.doc.document_id : tgt.folder.id);

  function openTarget(tgt: InfoTarget) {
    if (tgt.kind === "doc") gotoDoc(tgt.doc.slug);
    else gotoFolder(tgt.folder.id);
  }

  function onWindowKeydown(e: KeyboardEvent) {
    if (modal || menu || graphOpen || searchPaletteOpen()) return;
    const tgt = e.target as HTMLElement | null;
    if (tgt && (tgt.tagName === "INPUT" || tgt.tagName === "TEXTAREA" || tgt.isContentEditable))
      return;
    if (e.key === "Enter" && selectedTarget) {
      e.preventDefault();
      openTarget(selectedTarget);
    } else if (e.key === "Escape") {
      selectedRef = null;
    }
  }

  // --- context menus ------------------------------------------------------------------
  function openMenuAt(x: number, y: number, items: MenuItem[]) {
    menu = { x, y, items };
  }
  function onItemContextMenu(e: MouseEvent, tgt: InfoTarget) {
    e.preventDefault();
    e.stopPropagation();
    select(tgt);
    openMenuAt(e.clientX, e.clientY, itemMenuItems(tgt));
  }
  function onKebab(e: MouseEvent, tgt: InfoTarget) {
    e.stopPropagation();
    select(tgt);
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    openMenuAt(r.left, r.bottom + 4, itemMenuItems(tgt));
  }
  function onEmptyContextMenu(e: MouseEvent) {
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
    infoOpen = true;
  }

  // --- actions ---------------------------------------------------------------------------
  // Star / unstar a document (migration 0011). Optimistic: flip the local flag, then
  // PATCH; on failure revert and toast. Lives in the live `docs` array only (trashed
  // docs can't be starred from the UI).
  async function toggleStar(d: DocumentSummary) {
    const next = !d.starred;
    const i = docs.findIndex((x) => x.document_id === d.document_id);
    if (i >= 0) docs[i] = { ...docs[i], starred: next };
    try {
      await api.updateDocument(d.slug, { starred: next });
    } catch (e) {
      if (i >= 0) docs[i] = { ...docs[i], starred: !next };
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
      if (isSelected(tgt)) selectedRef = null;
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
    modal = m;
    modalError = "";
    modalBusy = false;
    modalName = m.kind === "rename" ? itemName(m.target) : "";
    if (m.kind === "move") {
      const cur = m.target.kind === "doc" ? m.target.doc.folder_id : m.target.folder.parent_id;
      moveDest = cur ?? "";
    }
    (document.activeElement as HTMLElement | null)?.blur(); // close any open dropdown
  }
  function openRename(tgt: InfoTarget) {
    openModal({ kind: "rename", target: tgt });
  }
  function openMove(tgt: InfoTarget) {
    openModal({ kind: "move", target: tgt });
  }

  function focusSelect(node: HTMLInputElement) {
    node.focus();
    node.select();
  }

  function submitNewDoc(e: SubmitEvent) {
    e.preventDefault();
    const name = modalName.trim();
    const slug = slugify(name);
    if (!slug) {
      modalError = t("modal.docNameFirst");
      return;
    }
    // The document itself is created server-side on first ws connect; only
    // brand-new slugs get the deferred title/folder placement.
    if (!docs.some((d) => d.slug === slug)) {
      placeNewDoc(slug, name, view === "folder" ? folderId : null);
    }
    modal = null;
    gotoDoc(slug);
  }

  async function submitNewFolder(e: SubmitEvent) {
    e.preventDefault();
    const name = modalName.trim();
    if (!name) {
      modalError = t("modal.folderNameFirst");
      return;
    }
    modalBusy = true;
    modalError = "";
    try {
      // Create in the current folder if we're in one; otherwise at the root of
      // the selected workspace (a non-personal workspace needs its id passed
      // explicitly — the personal one is the server default).
      const parentId = view === "folder" ? folderId : undefined;
      const wsId =
        !parentId && selectedWorkspaceId && selectedWorkspaceId !== personalWorkspaceId
          ? selectedWorkspaceId
          : undefined;
      const f = await api.createFolder(name, parentId, wsId);
      modal = null;
      showToast(t("toast.folderCreated", { name: f.name }));
      void load();
    } catch (e) {
      modalError =
        e instanceof WorkspaceApiError && e.status === 409 ? t("modal.folderExists") : errMsg(e);
    } finally {
      modalBusy = false;
    }
  }

  // Workspace creation now runs the full setup wizard (name → storage → connect
  // → done, plan 1b) instead of a one-field modal; see the `wizardHost` object
  // and the "newWorkspace" modal branch below. `t`'s param type is narrower
  // (MessageKey) than the host's plain-string signature, hence the cast.
  const wizardHost: WizardHost = {
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
      return parseStorageCapabilities(auth.storage);
    },
    onDone: async (workspaceId) => {
      modal = null;
      wizardResume = null;
      showToast(t("toast.workspaceReady"));
      await load();
      selectedWorkspaceId = workspaceId;
      if (view !== "root") gotoHome();
    },
    onCancel: () => {
      modal = null;
      wizardResume = null;
    },
    t: (k, p) => t(k as MessageKey, p),
    driveFlow: "redirect",
  };

  // --- first-login onboarding (BYO storage phase 3, spec §4) -------------------------
  const accountApi = createAccountApi({ httpBase });
  let onboardingHost: OnboardingHost | null = $state(null);

  /** Evaluate the trigger once BOTH /api/me and the workspace list are known.
   *  Context: memberships exist → the affirmative invitee screen (named after
   *  the default-selected workspace), else the create fork. Never over an
   *  OAuth wizard-resume already on screen. */
  function maybeStartOnboarding() {
    if (modal !== null) return;
    // The gate bails (oidc only) when listWorkspaces failed: we can't tell
    // "no workspaces" from "fetch broke", so never guess the fork over a
    // degraded load (fail-quiet, spec §5). This runs once per mount, so the
    // retry is the NEXT session/visit, not later in this one.
    if (!shouldShowOnboarding(auth, undefined, workspacesLoadFailed)) return;
    const context: OnboardingContext =
      workspaces.length > 0
        ? {
            kind: "invited",
            workspaceName:
              (selectedWorkspaceId && workspaceNames[selectedWorkspaceId]) || workspaces[0].name,
          }
        : { kind: "create" };
    onboardingHost = {
      context,
      finish: finishOnboarding,
      primaryAction: onboardingAction,
      t: (k, p) => t(k as MessageKey, p),
    };
    modal = { kind: "onboarding" };
  }

  /** Stamp + close. Closing NEVER waits on the network (spec §5): a failed
   *  stamp is a console.warn — worst case onboarding shows once more next
   *  session, never a blocking dialog. */
  async function finishOnboarding(_skipped: boolean): Promise<void> {
    modal = null;
    if (auth.mode === "oidc" && auth.user) {
      // Optimistic local stamp so this session can't re-trigger.
      auth = { ...auth, user: { ...auth.user, onboarded_at: new Date().toISOString() } };
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
   *  closed the onboarding modal synchronously. */
  function onboardingAction(action: OnboardingAction): void {
    if (action === "create") openModal({ kind: "newWorkspace" });
    // "open-invited": nothing to do — Home already selected the workspace.
  }

  async function submitRename(e: SubmitEvent) {
    e.preventDefault();
    if (modal?.kind !== "rename") return;
    const tgt = modal.target;
    const name = modalName.trim();
    if (!name) {
      modalError = t("modal.nameEmpty");
      return;
    }
    modalBusy = true;
    modalError = "";
    try {
      if (tgt.kind === "doc") {
        await api.updateDocument(tgt.doc.slug, { title: name });
      } else {
        await api.updateFolder(tgt.folder.id, { name });
      }
      modal = null;
      showToast(t("toast.renamed"));
      void load();
    } catch (e) {
      if (e instanceof WorkspaceApiError && e.status === 502) {
        // the rename stands; storage relocation self-heals on next materialize
        modal = null;
        showToast(t("toast.renamedStorageLag"));
        void load();
      } else {
        modalError =
          e instanceof WorkspaceApiError && e.status === 409 ? t("modal.nameInUse") : errMsg(e);
      }
    } finally {
      modalBusy = false;
    }
  }

  /** Folder ids the move picker must disable: the moved folder + its subtree. */
  const moveDisabled = $derived.by(() => {
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
  });

  async function submitMove() {
    if (modal?.kind !== "move" || moveDest === null) return;
    const tgt = modal.target;
    const dest = moveDest === "" ? null : moveDest;
    modalBusy = true;
    modalError = "";
    try {
      if (tgt.kind === "doc") {
        await api.updateDocument(tgt.doc.slug, { folder_id: dest });
      } else {
        await api.updateFolder(tgt.folder.id, { parent_id: dest });
      }
      modal = null;
      showToast(t("toast.moved", { name: itemName(tgt) }));
      void load();
    } catch (e) {
      if (e instanceof WorkspaceApiError && e.status === 502) {
        modal = null;
        showToast(t("toast.movedStorageLag"));
        void load();
      } else {
        modalError =
          e instanceof WorkspaceApiError && e.status === 409 ? t("modal.destExists") : errMsg(e);
      }
    } finally {
      modalBusy = false;
    }
  }

  // --- drag & drop (move into folders / out via breadcrumb) -----------------------------
  // HTML5 DnD: files and folders are draggable; folders and breadcrumb segments
  // (incl. the "My documents" root) are drop targets. Pure relocation — never
  // reordering, so the alphabetic/date sort is untouched. The keyboard-accessible
  // path stays the "Move to…" modal. Only enabled in the editable root/folder
  // views (not trash/recent/shared).
  const dndEnabled = $derived(view === "root" || view === "folder");
  let drag: { target: InfoTarget; forbidden: Set<string> } | null = $state(null);
  /** Which drop target is currently highlighted, e.g. "folder:<id>" / "crumb:<id>" / "root". */
  let dropKey: string | null = $state(null);

  /** A folder plus all its descendants — the set it can never be dropped into. */
  function subtreeOf(folderId: string): Set<string> {
    const out = new Set([folderId]);
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
    if (!drag) return false;
    const tgt = drag.target;
    if (tgt.kind === "folder") {
      if (destId !== null && drag.forbidden.has(destId)) return false;
      return (tgt.folder.parent_id ?? null) !== destId;
    }
    return (tgt.doc.folder_id ?? null) !== destId;
  }

  function startDrag(e: DragEvent, tgt: InfoTarget) {
    if (!dndEnabled) return;
    drag = {
      target: tgt,
      forbidden: tgt.kind === "folder" ? subtreeOf(tgt.folder.id) : new Set<string>(),
    };
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", itemName(tgt)); // Firefox needs data to start a drag
    }
  }

  function onDragOver(e: DragEvent, destId: string | null, key: string) {
    if (!canDropInto(destId)) return;
    e.preventDefault(); // permits the drop
    if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
    dropKey = key;
  }

  function onDragLeaveKey(key: string) {
    if (dropKey === key) dropKey = null;
  }

  async function onDrop(e: DragEvent, destId: string | null) {
    e.preventDefault();
    const d = drag;
    const allowed = canDropInto(destId);
    dropKey = null;
    drag = null;
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
    auth = { ...auth, user: null };
    void load();
  }

  onMount(() => {
    const authReady = fetchMe().then((a) => (auth = a));
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
      wizardResume = { workspaceId: wsSetup, outcome: storageOutcome };
      openModal({ kind: "newWorkspace" });
    }

    // First-login onboarding (BYO storage phase 3): the trigger needs auth AND
    // the workspace list (create-vs-invited context), so it waits for both.
    void Promise.all([authReady, dataReady]).then(maybeStartOnboarding);
  });
</script>

<svelte:window onkeydown={onWindowKeydown} />

{#snippet sortArrow(key: "name" | "modified")}
  {#if sortKey === key}
    {#if sortAsc}
      <ChevronUp class="inline h-3 w-3" aria-hidden="true" />
    {:else}
      <ChevronDown class="inline h-3 w-3" aria-hidden="true" />
    {/if}
  {/if}
{/snippet}

{#snippet docIcon(cls: string)}
  <FileText class={cls} aria-hidden="true" />
{/snippet}

{#snippet folderIcon(cls: string)}
  <!-- filled, Drive-style -->
  <Folder class={cls} fill="currentColor" aria-hidden="true" />
{/snippet}

{#snippet kebab(tgt: InfoTarget)}
  <button
    class="btn btn-circle btn-ghost btn-xs opacity-0 group-hover:opacity-100 focus:opacity-100"
    title={t("home.moreActions")}
    onclick={(e) => onKebab(e, tgt)}
  >
    <EllipsisVertical class="h-4 w-4" aria-hidden="true" />
  </button>
{/snippet}

<div class="flex h-screen flex-col bg-[var(--floor)]">
  <div class="flex min-h-0 flex-1">
    <!-- left sidebar (Multica/Linear): workspace selector · search · the active
         workspace's files/folders · Graph pinned at the bottom. The sidebar now
         carries identity + nav, so there's no separate top app header. -->
    <aside class="flex w-64 shrink-0 flex-col gap-1 px-2 pt-2 pb-2">
      <!-- workspace selector + account dropdown (§1) -->
      <WorkspaceMenu {auth} onsignout={signOut} />

      <!-- search row (§2): opens the ⌘K / `/` palette; darkens on hover to the
           same neutral veil as the nav rows. Mirrors Multica's search trigger —
           a muted-foreground row with a size-4 icon and a light ⌘K kbd chip. -->
      <button
        class="arc-tap flex h-10 w-full items-center gap-2.5 rounded-lg px-2 text-left text-base-content/60 hover:bg-base-200 hover:text-base-content"
        onclick={() => openSearchPalette()}
        title={t("home.search")}
      >
        <span class="flex h-6 w-6 shrink-0 items-center justify-center" aria-hidden="true">
          <Search class="h-[18px] w-[18px]" />
        </span>
        <span class="min-w-0 flex-1 truncate text-sm">{t("search.placeholder")}</span>
        <kbd
          class="pointer-events-none inline-flex h-5 shrink-0 items-center rounded border border-base-300 bg-base-200 px-1.5 font-mono text-[10px] font-medium tabular-nums text-base-content/60 select-none"
          >{searchShortcutHint}</kbd
        >
      </button>

      <!-- workspaces list (§2): the user's workspaces. Clicking one selects it as
           the active workspace, loading its docs into the main pane. The active
           row takes the neutral-gray lifted pill (.ws-row → --lift / --row-hover,
           gray, NOT the accent). A "Workspaces" header carries the (+) New
           workspace affordance (file/folder creation stays in the main toolbar). -->
      <nav
        class="mt-1 flex min-h-0 flex-1 flex-col overflow-y-auto"
        aria-label={t("home.workspaces")}
      >
        <div class="mb-1 flex items-center justify-between gap-1 px-2 pt-1">
          <p
            class="truncate text-xs font-semibold uppercase tracking-wide text-[var(--text-muted)]"
          >
            {t("home.workspaces")}
          </p>
          <button
            class="arc-tap flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-base-content/60 hover:bg-base-200 hover:text-base-content"
            title={t("home.newWorkspace")}
            aria-label={t("home.newWorkspace")}
            onclick={() => openModal({ kind: "newWorkspace" })}
          >
            <Plus class="h-4 w-4" strokeWidth={2.25} aria-hidden="true" />
          </button>
        </div>
        {#if workspaces.length === 0}
          <p class="px-2 pt-2 text-xs opacity-50">{t("home.treeEmpty")}</p>
        {:else}
          {#each workspaces as w (w.id)}
            {@const wsLabel = workspaceLabel(w)}
            <button
              class="ws-row arc-tap mb-0.5 flex h-10 w-full cursor-pointer items-center gap-2.5 px-2 text-left"
              class:active={!graphOpen && selectedWorkspaceId === w.id}
              onclick={() => selectWorkspace(w.id)}
            >
              <span
                class="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-base-300 text-xs font-medium text-base-content/80"
                aria-hidden="true"
              >
                {avatarLetter(wsLabel)}
              </span>
              <span class="min-w-0 flex-1 truncate text-sm">{wsLabel}</span>
            </button>
          {/each}
        {/if}
      </nav>

      <!-- Graph pinned at the bottom (§3), same row styling -->
      <div class="mt-1 border-t border-base-300/60 pt-1.5">
        <button
          class="tree-row arc-tap flex w-full cursor-pointer items-center gap-1.5"
          class:active={graphOpen}
          style="padding: 3px 7px 3px 22px;"
          onclick={() => (graphOpen = true)}
        >
          <Network class="h-[15px] w-[15px] shrink-0 opacity-60" aria-hidden="true" />
          <span class="truncate text-sm">{t("home.graph")}</span>
        </button>
      </div>
    </aside>

    <!-- content pane -->
    <main class="min-h-0 min-w-0 flex-1 pr-3 pt-3 pb-3">
      <!-- Arc-style lift: the main file-viewer pane floats a little above the
           floor with the layered card shadow, rather than sitting flush. -->
      <div
        class="flex h-full flex-col overflow-hidden rounded-2xl bg-base-100 shadow-[var(--shadow-card)]"
      >
        {#if mainPanel === "settings" && settingsSection}
          <!-- Settings renders inside the main panel (the workspaces sidebar to
               the left stays put). SettingsPage is imported dynamically so the
               home screen never eagerly loads the settings sections. -->
          {#await import("./SettingsPage.svelte") then { default: SettingsPage }}
            <SettingsPage section={settingsSection} embedded />
          {/await}
        {:else if mainPanel === "graph"}
          <GraphView embedded {selectedWorkspaceId} {personalWorkspaceId} />
        {:else}
          <!-- Breadcrumb row: the selected workspace is the clickable, drop-target
               base of the path. At the root the chain is empty, so only the
               workspace name shows; inside a folder the folder chain follows it. -->
          {#if view === "root" || view === "folder"}
            <div class="flex items-center justify-between gap-3 px-6 pt-5 pb-2">
              <h1 class="flex min-w-0 items-center gap-1 text-xl" style="text-wrap: balance;">
                <button
                  class="arc-tap rounded-lg px-2 py-0.5 hover:bg-base-200 {dropKey === 'root'
                    ? 'bg-primary/15 ring-2 ring-primary'
                    : ''}"
                  onclick={() => gotoHome()}
                  ondragover={(e) => onDragOver(e, null, "root")}
                  ondragleave={() => onDragLeaveKey("root")}
                  ondrop={(e) => onDrop(e, null)}
                >
                  {viewLabel}
                </button>
                {#each crumbs as c, i (c.id)}
                  <span class="opacity-40" aria-hidden="true">›</span>
                  {#if i === crumbs.length - 1}
                    <span class="truncate px-2 py-0.5 font-medium">{c.name}</span>
                  {:else}
                    <button
                      class="arc-tap truncate rounded-lg px-2 py-0.5 hover:bg-base-200 {dropKey ===
                      'crumb:' + c.id
                        ? 'bg-primary/15 ring-2 ring-primary'
                        : ''}"
                      onclick={() => gotoFolder(c.id)}
                      ondragover={(e) => onDragOver(e, c.id, "crumb:" + c.id)}
                      ondragleave={() => onDragLeaveKey("crumb:" + c.id)}
                      ondrop={(e) => onDrop(e, c.id)}
                    >
                      {c.name}
                    </button>
                  {/if}
                {/each}
              </h1>
            </div>
          {/if}

          <!-- controls toolbar (§4): New file · New folder · Sort · Collapse-all · Search -->
          <div class="flex items-center gap-2 px-6 pb-3">
            <button class="btn btn-sm gap-1.5" onclick={() => openModal({ kind: "newDoc" })}>
              {@render docIcon("h-4 w-4")}
              <span class="hidden sm:inline">{t("home.newFile")}</span>
            </button>
            <button class="btn btn-sm gap-1.5" onclick={() => openModal({ kind: "newFolder" })}>
              {@render folderIcon("h-4 w-4 opacity-70")}
              <span class="hidden sm:inline">{t("home.newFolder")}</span>
            </button>

            <div class="mx-1 h-5 w-px self-center bg-base-300/70" aria-hidden="true"></div>

            <!-- Sort menu (daisyUI dropdown + menu) -->
            <div class="dropdown">
              <div tabindex="0" role="button" class="btn btn-sm gap-1.5" title={t("home.sort")}>
                <span class="text-sm">
                  {sortKey === "name" ? t("home.colName") : t("home.colModified")}
                </span>
                {#if sortAsc}
                  <ArrowUp class="h-3.5 w-3.5 opacity-60" aria-hidden="true" />
                {:else}
                  <ArrowDown class="h-3.5 w-3.5 opacity-60" aria-hidden="true" />
                {/if}
              </div>
              <ul
                class="dropdown-content menu z-20 mt-1.5 w-56 gap-0.5 rounded-box border border-base-300 bg-base-100 p-2 shadow-[var(--shadow-overlay)]"
              >
                <li class="menu-title text-xs">{t("home.sortBy")}</li>
                <li>
                  <button
                    class={sortKey === "name" ? "menu-item-selected" : ""}
                    onclick={() => setSortKey("name")}
                  >
                    <span class="grow text-left">{t("home.colName")}</span>
                    {#if sortKey === "name"}
                      <Check class="h-4 w-4 text-primary" aria-hidden="true" />
                    {/if}
                  </button>
                </li>
                <li>
                  <button
                    class={sortKey === "modified" ? "menu-item-selected" : ""}
                    onclick={() => setSortKey("modified")}
                  >
                    <span class="grow text-left">{t("home.colModified")}</span>
                    {#if sortKey === "modified"}
                      <Check class="h-4 w-4 text-primary" aria-hidden="true" />
                    {/if}
                  </button>
                </li>
                <li class="menu-title text-xs">{t("home.sortOrder")}</li>
                <li>
                  <button
                    class={sortAsc ? "menu-item-selected" : ""}
                    onclick={() => setSortDir(true)}
                  >
                    <ArrowUp class="h-4 w-4 opacity-70" aria-hidden="true" />
                    <span class="grow text-left">{t("home.sortAsc")}</span>
                    {#if sortAsc}
                      <Check class="h-4 w-4 text-primary" aria-hidden="true" />
                    {/if}
                  </button>
                </li>
                <li>
                  <button
                    class={!sortAsc ? "menu-item-selected" : ""}
                    onclick={() => setSortDir(false)}
                  >
                    <ArrowDown class="h-4 w-4 opacity-70" aria-hidden="true" />
                    <span class="grow text-left">{t("home.sortDesc")}</span>
                    {#if !sortAsc}
                      <Check class="h-4 w-4 text-primary" aria-hidden="true" />
                    {/if}
                  </button>
                </li>
              </ul>
            </div>

            {#if prefs.homeView === "tree"}
              <button
                class="btn btn-sm btn-ghost gap-1.5"
                title={t("home.collapseAll")}
                onclick={collapseAll}
              >
                <ChevronsDownUp class="h-4 w-4" aria-hidden="true" />
                <span class="hidden text-sm md:inline">{t("home.collapseAll")}</span>
              </button>
            {/if}

            <!-- view / info switcher (moved here from the card header). The
                 view picker gets a defined edge (1px border + recessed track)
                 so it reads as a segmented control instead of vanishing into
                 the white card; the ⓘ info button stays a plain ghost circle. -->
            <div class="ml-auto flex shrink-0 items-center gap-2">
              <div class="join rounded-lg border border-base-300 bg-base-200 p-0.5">
                <button
                  class="btn join-item btn-sm border-0 {prefs.homeView === 'list'
                    ? 'btn-active bg-base-100 shadow-[var(--shadow-lift)]'
                    : 'btn-ghost'}"
                  title={t("home.listView")}
                  aria-label={t("home.listView")}
                  onclick={() => (prefs.homeView = "list")}
                >
                  <List class="h-4 w-4" aria-hidden="true" />
                </button>
                <button
                  class="btn join-item btn-sm border-0 {prefs.homeView === 'grid'
                    ? 'btn-active bg-base-100 shadow-[var(--shadow-lift)]'
                    : 'btn-ghost'}"
                  title={t("home.gridView")}
                  aria-label={t("home.gridView")}
                  onclick={() => (prefs.homeView = "grid")}
                >
                  <Grid2x2 class="h-4 w-4" aria-hidden="true" />
                </button>
                <button
                  class="btn join-item btn-sm border-0 {prefs.homeView === 'tree'
                    ? 'btn-active bg-base-100 shadow-[var(--shadow-lift)]'
                    : 'btn-ghost'}"
                  title={t("home.treeView")}
                  aria-label={t("home.treeView")}
                  onclick={() => (prefs.homeView = "tree")}
                >
                  <ListTree class="h-4 w-4" aria-hidden="true" />
                </button>
              </div>
              <button
                class="btn btn-circle btn-ghost btn-sm {infoOpen ? 'btn-active' : ''}"
                title={infoOpen ? t("home.hideDetails") : t("home.viewDetails")}
                aria-label={infoOpen ? t("home.hideDetails") : t("home.viewDetails")}
                onclick={() => (infoOpen = !infoOpen)}
              >
                <Info class="h-5 w-5" aria-hidden="true" />
              </button>
            </div>
          </div>

          {#if selectedWsUnbound}
            <div
              class="alert alert-warning mx-4 mt-3 flex items-center justify-between py-2 text-sm"
            >
              <span>{t("home.connectStorageBanner")}</span>
              <a class="btn btn-sm" href="#~settings/connections">{t("home.connectStorageCta")}</a>
            </div>
          {/if}

          <div class="flex min-h-0 flex-1">
            <div class="flex min-h-0 min-w-0 flex-1 flex-col">
              {#if loading}
                <div class="flex flex-col gap-3 px-6">
                  {#each Array(5) as _, i (i)}
                    <div class="skeleton h-9 w-full"></div>
                  {/each}
                </div>
              {:else if needsLogin}
                <!-- Session lapsed: the top-level gate is re-probing auth and will
                     swap this whole view for the dedicated AuthPage. Hold a calm
                     spinner rather than flashing the old inline sign-in card. -->
                <div class="flex flex-1 items-center justify-center pb-16">
                  <span class="loading loading-spinner loading-lg opacity-40"></span>
                </div>
              {:else if error}
                <div class="flex flex-1 items-center justify-center pb-16 text-sm opacity-60">
                  {error}
                </div>
              {:else if listing.folders.length === 0 && listing.docs.length === 0}
                <div class="flex flex-1 flex-col items-center justify-center gap-3 pb-16">
                  {#if view === "folder"}
                    <span class="text-4xl" aria-hidden="true">📁</span>
                    <p class="text-lg font-medium">{t("home.emptyFolderTitle")}</p>
                    <p class="text-sm opacity-60">
                      {t("home.emptyFolderBody")}
                    </p>
                  {:else}
                    <span class="text-4xl" aria-hidden="true">📄</span>
                    <p class="text-lg font-medium">{t("home.emptyRootTitle")}</p>
                    <p class="text-sm opacity-60">{t("home.emptyRootBody")}</p>
                    <button
                      class="btn btn-primary btn-sm"
                      onclick={() => openModal({ kind: "newDoc" })}
                    >
                      {t("home.newFile")}
                    </button>
                  {/if}
                </div>
              {:else if prefs.homeView === "list"}
                <!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
                <div
                  class="min-h-0 flex-1 overflow-y-auto px-3"
                  onclick={(e) => {
                    if (e.target === e.currentTarget) selectedRef = null;
                  }}
                  oncontextmenu={onEmptyContextMenu}
                >
                  <table class="table-pin-rows table">
                    <thead>
                      <tr class="border-base-300/60 text-xs">
                        <th>
                          <button class="cursor-pointer" onclick={() => setSort("name")}>
                            {t("home.colName")}
                            {@render sortArrow("name")}
                          </button>
                        </th>
                        <th class="w-36">
                          <button class="cursor-pointer" onclick={() => setSort("modified")}>
                            {t("home.colModified")}
                            {@render sortArrow("modified")}
                          </button>
                        </th>
                        <th class="w-20"><span class="sr-only">{t("home.colActions")}</span></th>
                      </tr>
                    </thead>
                    <tbody>
                      {#each listing.folders as f (f.id)}
                        {@const tgt = { kind: "folder", folder: f } as InfoTarget}
                        <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
                        <tr
                          class="group cursor-pointer border-base-300/60 {dropKey ===
                          'folder:' + f.id
                            ? 'bg-primary/15 ring-2 ring-inset ring-primary'
                            : isSelected(tgt)
                              ? 'bg-primary/10'
                              : 'hover:bg-base-200/60'} {isDragging(tgt) ? 'opacity-40' : ''}"
                          draggable={dndEnabled}
                          ondragstart={(e) => startDrag(e, tgt)}
                          ondragend={() => {
                            drag = null;
                            dropKey = null;
                          }}
                          ondragover={(e) => onDragOver(e, f.id, "folder:" + f.id)}
                          ondragleave={() => onDragLeaveKey("folder:" + f.id)}
                          ondrop={(e) => onDrop(e, f.id)}
                          onclick={(e) => {
                            e.stopPropagation();
                            select(tgt);
                          }}
                          ondblclick={() => openTarget(tgt)}
                          oncontextmenu={(e) => onItemContextMenu(e, tgt)}
                        >
                          <td>
                            <div class="flex min-w-0 items-center gap-3">
                              {@render folderIcon("h-5 w-5 shrink-0 opacity-60")}
                              <span class="truncate font-medium">{f.name}</span>
                            </div>
                          </td>
                          <td
                            class="text-sm tabular-nums opacity-70"
                            title={fullDateTime(f.updated_at)}
                          >
                            {driveDate(f.updated_at)}
                          </td>
                          <td>
                            <div class="flex items-center justify-end gap-1">
                              {@render kebab(tgt)}
                            </div>
                          </td>
                        </tr>
                      {/each}
                      {#each listing.docs as d (d.document_id)}
                        {@const tgt = { kind: "doc", doc: d } as InfoTarget}
                        <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
                        <tr
                          class="group cursor-pointer border-base-300/60 {isSelected(tgt)
                            ? 'bg-primary/10'
                            : 'hover:bg-base-200/60'} {isDragging(tgt) ? 'opacity-40' : ''}"
                          draggable={dndEnabled}
                          ondragstart={(e) => startDrag(e, tgt)}
                          ondragend={() => {
                            drag = null;
                            dropKey = null;
                          }}
                          onclick={(e) => {
                            e.stopPropagation();
                            select(tgt);
                          }}
                          ondblclick={() => openTarget(tgt)}
                          oncontextmenu={(e) => onItemContextMenu(e, tgt)}
                        >
                          <td>
                            <div class="flex min-w-0 items-center gap-3">
                              {@render docIcon("h-5 w-5 shrink-0 text-primary")}
                              <span class="truncate font-medium">{docName(d)}</span>
                              <!-- Starred indicator (migration 0011) -->
                              {#if d.starred}
                                <Star
                                  class="h-3.5 w-3.5 shrink-0 text-warning"
                                  fill="currentColor"
                                  aria-label={t("home.starred")}
                                />
                              {/if}
                              <span
                                class="hidden shrink-0 font-mono text-[11px] opacity-30 lg:inline"
                                >{d.slug}.md</span
                              >
                            </div>
                          </td>
                          <td
                            class="text-sm tabular-nums opacity-70"
                            title={fullDateTime(d.updated_at)}
                          >
                            {driveDate(d.updated_at)}
                          </td>
                          <td>
                            <div class="flex items-center justify-end gap-1">
                              {@render kebab(tgt)}
                            </div>
                          </td>
                        </tr>
                      {/each}
                    </tbody>
                  </table>
                </div>
              {:else if prefs.homeView === "tree"}
                <!-- tree view (§3): recursive folders + docs of the selected
                     workspace, Arc-depth rows; opt-in, never the default. No
                     horizontal padding here — indentation and the pane's side
                     gutter are each row's own padding, so the hover/active
                     highlight spans the width of the pane. -->
                <!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
                <div
                  class="min-h-0 flex-1 overflow-y-auto pb-4"
                  onclick={(e) => {
                    if (e.target === e.currentTarget) selectedRef = null;
                  }}
                  oncontextmenu={onEmptyContextMenu}
                >
                  {#if treeRootFolders.length === 0 && treeRootDocs.length === 0}
                    <p class="px-3 pt-6 text-sm opacity-60">{t("home.treeEmpty")}</p>
                  {:else}
                    {#each treeRootFolders as f (f.id)}
                      <HomeTreeNode
                        folder={f}
                        depth={0}
                        childFolders={treeChildFolders}
                        folderDocs={treeFolderDocs}
                        {expanded}
                        toggle={(id) => (expanded[id] = !expanded[id])}
                        {selectedRef}
                        activeSlug={null}
                        {dndEnabled}
                        {dropKey}
                        {docName}
                        onSelect={select}
                        onOpen={openTarget}
                        onContextMenu={onItemContextMenu}
                        onDragStart={startDrag}
                        onDragEnd={() => {
                          drag = null;
                          dropKey = null;
                        }}
                        {onDragOver}
                        onDragLeave={onDragLeaveKey}
                        {onDrop}
                      />
                    {/each}
                    {#each treeRootDocs as d (d.document_id)}
                      {@const docTgt = { kind: "doc", doc: d } as InfoTarget}
                      <!-- svelte-ignore a11y_click_events_have_key_events -->
                      <div
                        class="tree-row-wrap flex cursor-pointer items-center select-none"
                        class:active={isSelected(docTgt)}
                        style="padding-left: 12px; padding-top: 2px; padding-bottom: 2px; padding-right: 12px;"
                        draggable={dndEnabled}
                        ondragstart={(e) => startDrag(e, docTgt)}
                        ondragend={() => {
                          drag = null;
                          dropKey = null;
                        }}
                        onclick={(e) => {
                          e.stopPropagation();
                          select(docTgt);
                        }}
                        ondblclick={() => openTarget(docTgt)}
                        oncontextmenu={(e) => onItemContextMenu(e, docTgt)}
                        role="treeitem"
                        aria-selected={isSelected(docTgt)}
                        tabindex="0"
                        onkeydown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            openTarget(docTgt);
                          }
                        }}
                      >
                        <span class="shrink-0" style="width: 15px;"></span>
                        <div
                          class="tree-row-label items-center gap-1.5 min-w-0"
                          style="padding: 1px 7px;"
                        >
                          {@render docIcon("h-[15px] w-[15px] shrink-0 text-primary")}
                          <span class="truncate text-sm">{docName(d)}</span>
                          {#if d.starred}
                            <Star
                              class="h-3 w-3 shrink-0 text-warning"
                              fill="currentColor"
                              aria-label={t("home.starred")}
                            />
                          {/if}
                        </div>
                      </div>
                    {/each}
                  {/if}
                </div>
              {:else}
                <!-- grid view -->
                <!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
                <div
                  class="min-h-0 flex-1 overflow-y-auto px-6 pb-6"
                  onclick={(e) => {
                    if (e.target === e.currentTarget) selectedRef = null;
                  }}
                  oncontextmenu={onEmptyContextMenu}
                >
                  {#if listing.folders.length > 0}
                    <h2 class="pt-1 pb-2 text-sm font-medium opacity-60">
                      {t("home.foldersHeading")}
                    </h2>
                    <div
                      class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5"
                    >
                      {#each listing.folders as f (f.id)}
                        {@const tgt = { kind: "folder", folder: f } as InfoTarget}
                        <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
                        <div
                          class="group flex cursor-pointer items-center gap-2.5 rounded-xl px-3.5 py-3 {dropKey ===
                          'folder:' + f.id
                            ? 'bg-primary/15 ring-2 ring-primary'
                            : isSelected(tgt)
                              ? 'bg-primary/10'
                              : 'bg-base-300/40 hover:bg-base-300/60'} {isDragging(tgt)
                            ? 'opacity-40'
                            : ''}"
                          draggable={dndEnabled}
                          ondragstart={(e) => startDrag(e, tgt)}
                          ondragend={() => {
                            drag = null;
                            dropKey = null;
                          }}
                          ondragover={(e) => onDragOver(e, f.id, "folder:" + f.id)}
                          ondragleave={() => onDragLeaveKey("folder:" + f.id)}
                          ondrop={(e) => onDrop(e, f.id)}
                          onclick={(e) => {
                            e.stopPropagation();
                            select(tgt);
                          }}
                          ondblclick={() => openTarget(tgt)}
                          oncontextmenu={(e) => onItemContextMenu(e, tgt)}
                        >
                          {@render folderIcon("h-5 w-5 shrink-0 opacity-60")}
                          <span class="min-w-0 flex-1 truncate text-sm font-medium">{f.name}</span>
                          {@render kebab(tgt)}
                        </div>
                      {/each}
                    </div>
                  {/if}
                  {#if listing.docs.length > 0}
                    <h2 class="pt-4 pb-2 text-sm font-medium opacity-60">
                      {t("home.documentsHeading")}
                    </h2>
                    <div
                      class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5"
                    >
                      {#each listing.docs as d (d.document_id)}
                        {@const tgt = { kind: "doc", doc: d } as InfoTarget}
                        <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
                        <div
                          class="group cursor-pointer overflow-hidden rounded-xl border border-base-300 shadow-sm transition-shadow hover:shadow {isSelected(
                            tgt,
                          )
                            ? 'bg-primary/10'
                            : 'bg-base-100'} {isDragging(tgt) ? 'opacity-40' : ''}"
                          draggable={dndEnabled}
                          ondragstart={(e) => startDrag(e, tgt)}
                          ondragend={() => {
                            drag = null;
                            dropKey = null;
                          }}
                          onclick={(e) => {
                            e.stopPropagation();
                            select(tgt);
                          }}
                          ondblclick={() => openTarget(tgt)}
                          oncontextmenu={(e) => onItemContextMenu(e, tgt)}
                        >
                          <!-- preview well stays quiet (neutral glyph); the small
                               type icon by the name is the colored one, like Drive -->
                          <div class="flex h-24 items-center justify-center bg-base-200">
                            {@render docIcon("h-9 w-9 text-base-content/20")}
                          </div>
                          <div class="flex items-center gap-2 px-3 pt-2.5">
                            {@render docIcon("h-4 w-4 shrink-0 text-primary")}
                            <span
                              class="min-w-0 flex-1 truncate text-sm font-medium"
                              title={docName(d)}
                            >
                              {docName(d)}
                            </span>
                            <!-- Starred indicator (migration 0011) -->
                            {#if d.starred}
                              <Star
                                class="h-3.5 w-3.5 shrink-0 text-warning"
                                fill="currentColor"
                                aria-label={t("home.starred")}
                              />
                            {/if}
                            {@render kebab(tgt)}
                          </div>
                          <p
                            class="px-3 pt-0.5 pb-2.5 text-xs opacity-50"
                            title={fullDateTime(d.updated_at)}
                          >
                            {driveDate(d.updated_at)}
                          </p>
                        </div>
                      {/each}
                    </div>
                  {/if}
                </div>
              {/if}
            </div>

            {#if infoOpen}
              <InfoPanel
                target={selectedTarget}
                {docs}
                {folders}
                {workspaceNames}
                {api}
                {auth}
                onstar={(d) => void toggleStar(d)}
                onclose={() => (infoOpen = false)}
              />
            {/if}
          </div>
        {/if}
      </div>
    </main>
  </div>

  {#if menu}
    <ContextMenu x={menu.x} y={menu.y} items={menu.items} onclose={() => (menu = null)} />
  {/if}

  <!-- modals -->
  {#if modal}
    <div class="modal modal-open" role="dialog">
      <div
        class="modal-box {modal.kind === 'newWorkspace' || modal.kind === 'onboarding'
          ? 'w-[34rem]'
          : 'w-[26rem]'} max-w-[92vw]"
      >
        {#if modal.kind === "newDoc"}
          <h3 class="mb-3 text-lg font-semibold">{t("home.newFile")}</h3>
          <form class="flex flex-col gap-2" onsubmit={submitNewDoc}>
            <input
              class="input w-full"
              placeholder={t("modal.fileNamePlaceholder")}
              bind:value={modalName}
              oninput={() => (modalError = "")}
              use:focusSelect
            />
            <p class="font-mono text-xs opacity-50">{slugify(modalName) || "…"}.md</p>
            {#if view === "folder" && crumbs.length > 0}
              <p class="text-xs opacity-50">
                {t("modal.willBeCreatedIn", { folder: crumbs[crumbs.length - 1].name })}
              </p>
            {/if}
            {#if modalError}
              <p class="text-xs text-error">{modalError}</p>
            {/if}
            <div class="modal-action mt-2">
              <button class="btn btn-ghost" type="button" onclick={() => (modal = null)}>
                {t("common.cancel")}
              </button>
              <button class="btn btn-primary" type="submit">{t("common.create")}</button>
            </div>
          </form>
        {:else if modal.kind === "newFolder"}
          <h3 class="mb-3 text-lg font-semibold">{t("home.newFolder")}</h3>
          <form class="flex flex-col gap-2" onsubmit={submitNewFolder}>
            <input
              class="input w-full"
              placeholder={t("modal.folderNamePlaceholder")}
              bind:value={modalName}
              oninput={() => (modalError = "")}
              use:focusSelect
            />
            {#if view === "folder" && crumbs.length > 0}
              <p class="text-xs opacity-50">
                {t("modal.willBeCreatedIn", { folder: crumbs[crumbs.length - 1].name })}
              </p>
            {/if}
            {#if modalError}
              <p class="text-xs text-error">{modalError}</p>
            {/if}
            <div class="modal-action mt-2">
              <button class="btn btn-ghost" type="button" onclick={() => (modal = null)}>
                {t("common.cancel")}
              </button>
              <button class="btn btn-primary" type="submit" disabled={modalBusy}>
                {#if modalBusy}<span class="loading loading-spinner loading-xs"></span>{/if}
                {t("common.create")}
              </button>
            </div>
          </form>
        {:else if modal.kind === "newWorkspace"}
          <WorkspaceWizard host={wizardHost} resume={wizardResume ?? undefined} />
        {:else if modal.kind === "onboarding"}
          {#if onboardingHost}
            <OnboardingFlow host={onboardingHost} />
          {/if}
        {:else if modal.kind === "rename"}
          <h3 class="mb-3 text-lg font-semibold">
            {modal.target.kind === "doc" ? t("modal.renameDocTitle") : t("modal.renameFolderTitle")}
          </h3>
          <form class="flex flex-col gap-2" onsubmit={submitRename}>
            <input
              class="input w-full"
              bind:value={modalName}
              oninput={() => (modalError = "")}
              use:focusSelect
            />
            {#if modal.target.kind === "doc"}
              <p class="font-mono text-xs opacity-50">
                {t("modal.fileStays", { slug: modal.target.doc.slug })}
              </p>
            {/if}
            {#if modalError}
              <p class="text-xs text-error">{modalError}</p>
            {/if}
            <div class="modal-action mt-2">
              <button class="btn btn-ghost" type="button" onclick={() => (modal = null)}>
                {t("common.cancel")}
              </button>
              <button class="btn btn-primary" type="submit" disabled={modalBusy}>
                {#if modalBusy}<span class="loading loading-spinner loading-xs"></span>{/if}
                {t("common.rename")}
              </button>
            </div>
          </form>
        {:else if modal.kind === "move"}
          {@const target = modal.target}
          <h3 class="mb-1 text-lg font-semibold">
            {t("modal.moveTitle", { name: itemName(target) })}
          </h3>
          <p class="mb-3 text-sm opacity-60">{t("modal.chooseDestination")}</p>
          <div class="max-h-72 overflow-y-auto rounded-box border border-base-300 py-1">
            <button
              class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-base-200 {moveDest ===
              ''
                ? 'bg-primary/10 font-medium'
                : ''}"
              onclick={() => (moveDest = "")}
            >
              {@render docIcon("h-4 w-4")}
              {t("home.myDocuments")}
            </button>
            {#snippet pickerNode(f: FolderSummary, depth: number)}
              <button
                class="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-base-200 disabled:opacity-40 disabled:hover:bg-transparent {moveDest ===
                f.id
                  ? 'bg-primary/10 font-medium'
                  : ''}"
                style:padding-left="{depth * 16 + 12}px"
                disabled={moveDisabled.has(f.id)}
                onclick={() => (moveDest = f.id)}
              >
                {@render folderIcon("h-4 w-4 shrink-0 opacity-60")}
                <span class="truncate">{f.name}</span>
              </button>
              {#each childFolders(f.id) as k (k.id)}
                {@render pickerNode(k, depth + 1)}
              {/each}
            {/snippet}
            {#each rootFolders as f (f.id)}
              {@render pickerNode(f, 1)}
            {/each}
          </div>
          {#if modalError}
            <p class="mt-2 text-xs text-error">{modalError}</p>
          {/if}
          <div class="modal-action">
            <button class="btn btn-ghost" type="button" onclick={() => (modal = null)}>
              {t("common.cancel")}
            </button>
            <button
              class="btn btn-primary"
              disabled={modalBusy || moveDest === null}
              onclick={() => void submitMove()}
            >
              {#if modalBusy}<span class="loading loading-spinner loading-xs"></span>{/if}
              {t("modal.moveHere")}
            </button>
          </div>
        {/if}
      </div>
      <button class="modal-backdrop" aria-label={t("common.close")} onclick={() => (modal = null)}
      ></button>
    </div>
  {/if}

  {#if toast}
    <div class="toast toast-end z-50">
      <div class="alert {toastKind === 'warning' ? 'alert-warning' : ''} py-2 text-sm shadow">
        {toast}
      </div>
    </div>
  {/if}
</div>
