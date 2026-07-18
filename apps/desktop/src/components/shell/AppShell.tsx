import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  ArrowUpDown,
  ChevronsDownUp,
  FolderPlus,
  Mic,
  Network,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Search,
  SquarePen,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { IconButton } from "./IconButton";
import TabStrip from "./TabStrip";
import ResizeHandle from "./ResizeHandle";
import RightSidebar from "./RightSidebar";
import UpdatePill from "./UpdatePill";

import { FileTree, type FileTreeHandle } from "@/components/tree/FileTree";
import { WorkspaceMenu } from "@/components/tree/WorkspaceMenu";
import { NotificationsBell } from "@/components/tree/NotificationsBell";
import EditorPane from "@/components/editor/EditorPane";
import { GraphView } from "@/components/graph/GraphView";
import { SettingsPanel } from "@/components/overlays/SettingsPanel";
import { CommandPalette } from "@/components/overlays/CommandPalette";
import { QuickSwitcher } from "@/components/overlays/QuickSwitcher";
import { SearchModal } from "@/components/overlays/SearchModal";
import { SignInModal } from "@/components/overlays/SignInModal";
import { KeychainConsentModal } from "@/components/overlays/KeychainConsentModal";
import { CreateWorkspaceModal } from "@/components/setup/CreateWorkspaceModal";
import { OnboardingOverlay } from "@/components/setup/OnboardingOverlay";
import TranscriptView from "@/components/transcript/TranscriptView";

import { workspaceStore, useWorkspace } from "@/state/workspace";
import { workspacesStore, useWorkspaces } from "@/state/workspaces";
import { tabsStore, useTabs } from "@/state/tabs";
import { sidebarsStore, useSidebars } from "@/state/sidebars";
import { settingsStore } from "@/state/settings";
import { themeStore } from "@/state/theme";
import { accentStore } from "@/state/accent";
import { backgroundStore } from "@/state/background";
import { folderColorStore } from "@/state/folderColor";
import { prefsSync } from "@/state/prefsSync";
import { platformStore, usePlatform } from "@/state/platform";
import { updatesStore, useUpdates } from "@/state/updates";
import { keychainConsentStore, useKeychainConsent } from "@/state/keychainConsent";
import { commandsStore } from "@/state/commands";
import { useDocCollab } from "@/state/docCollab";
import { useCollabSnapshot } from "@/state/collabStore";
import { captureUiStore, useCaptureUi } from "@/state/captureUi";

import { createFolder, createNote, getLastWorkspace } from "@/services/tauri";
import { escapeFallbackTarget, installKeymap } from "@/services/keymap";
import { onboardingDecision } from "@/services/onboardingGate";
import { apiRequest } from "@/services/collab/apiRequest";

// Sidebar width bounds — mirror state/sidebars.ts (the store clamps on commit;
// these keep the LIVE drag from over/under-shooting before the commit lands).
const LEFT_MIN = 200;
const LEFT_MAX = 480;
const RIGHT_MIN = 220;
const RIGHT_MAX = 540;

function clamp(px: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(px)));
}

// Tauri's native drag-drop interception is disabled (tauri.conf.json
// dragDropEnabled: false) so the tree's HTML5 drag-and-drop works — the native
// handler swallows dragover/drop inside the WKWebView. With it off, a file
// dragged in from Finder would hit the webview's default behavior (navigating
// away from the app), so cancel any drag the tree's own handlers didn't take.
function cancelWindowDnd(e: DragEvent) {
  e.preventDefault();
}

export default function AppShell() {
  // ── shell state ─────────────────────────────────────────────────────────────
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [rightSidebarOpen, setRightSidebarOpen] = useState(false);
  const [showTranscript, setShowTranscript] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  const [showSignIn, setShowSignIn] = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [showCreateWorkspace, setShowCreateWorkspace] = useState(false);
  const [showPalette, setShowPalette] = useState(false);
  const [showSwitcher, setShowSwitcher] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  // Section SettingsPanel lands on when it next mounts. A failed sign-in
  // (confirmSignIn below) deep-links to Profile — the one surface that shows
  // BOTH the retry control and the error message together; every other open
  // path uses the default (also Profile).
  const [settingsSection, setSettingsSection] = useState<"profile" | undefined>(undefined);
  const [showSearch, setShowSearch] = useState(false);
  // Graph view replaces the editor pane in the main area when toggled on.
  // Opening a document (handleOpen) flips it back off.
  const [showGraph, setShowGraph] = useState(false);
  const [treeScrolled, setTreeScrolled] = useState(false);

  // ── store reads ─────────────────────────────────────────────────────────────
  const sidebarLeft = useSidebars((s) => s.left);
  const root = useWorkspace((s) => s.root);
  const tree = useWorkspace((s) => s.tree);
  const sortMode = useWorkspace((s) => s.sortMode);
  const identity = useWorkspaces((s) => s.identity);
  const activeServer = useWorkspaces((s) => s.activeServer);
  const activePath = useTabs((s) => s.active()?.path ?? null);
  const transcription = usePlatform((s) => s.transcription);
  const pillVisible = useUpdates((s) => s.pillVisible);
  const keychainAsking = useKeychainConsent((s) => s.asking);
  const captureStatus = useCaptureUi((s) => s.captureStatus);

  // ── refs ────────────────────────────────────────────────────────────────────
  // FileTree handle — the toolbar's "new folder" hands the freshly-created path
  // to the tree's inline-rename flow (see handleNewFolder).
  const fileTreeRef = useRef<FileTreeHandle | null>(null);
  const leftAsideRef = useRef<HTMLElement | null>(null);
  const titleLeftZoneRef = useRef<HTMLDivElement | null>(null);
  const rightAsideRef = useRef<HTMLElement | null>(null);
  /** Whether the open sign-in dialog was reached via onboarding's "Connect to
   *  a server" fork — its confirm path then runs the fork's post-login logic. */
  const signInFromOnboardingRef = useRef(false);

  // Escape-layer snapshot for the keymap's closeModal fallback. The keymap is
  // installed ONCE in the mount effect, so its callbacks must never read state
  // from a render closure — this ref is refreshed every render instead.
  const layersRef = useRef({
    signIn: false,
    keychainConsent: false,
    onboarding: false,
    search: false,
    palette: false,
    switcher: false,
    settings: false,
    picker: false,
  });
  layersRef.current = {
    signIn: showSignIn,
    keychainConsent: keychainAsking,
    onboarding: showOnboarding,
    search: showSearch,
    palette: showPalette,
    switcher: showSwitcher,
    settings: showSettings,
    picker: showPicker,
  };

  // ── settings / open helpers ─────────────────────────────────────────────────

  /** Close Settings and reset its deep-link section — the ONLY way Settings
   *  should be closed, so a later, unrelated Settings open doesn't land back on
   *  a stale deep-linked section. */
  const closeSettings = useCallback(() => {
    setShowSettings(false);
    setSettingsSection(undefined);
  }, []);

  const handleOpen = useCallback(
    (path: string) => {
      const name = path.split("/").at(-1) ?? path;
      // Opening a document always returns from the graph/settings views.
      setShowGraph(false);
      closeSettings();
      tabsStore.getState().open(path, name);
    },
    [closeSettings],
  );

  const handleNewNote = useCallback(async () => {
    const ws = workspaceStore.getState();
    if (!ws.root) return;
    const newPath = await createNote(ws.root, "Untitled.md");
    await workspaceStore.getState().refresh();
    handleOpen(newPath);
  }, [handleOpen]);

  const handleNewFolder = useCallback(async () => {
    const ws = workspaceStore.getState();
    if (!ws.root) return;
    // Finder-style: create with a default name, then let the tree's inline
    // rename take over (window.prompt is a silent no-op in the WKWebView).
    try {
      const newPath = await createFolder(ws.root, "New folder");
      await workspaceStore.getState().refresh();
      fileTreeRef.current?.startRename(newPath);
    } catch (err) {
      console.error("[create] new folder failed", err);
    }
  }, []);

  // ── transcription (macOS-only) ──────────────────────────────────────────────
  // Capture state lives in the captureUi store (owned by the transcript
  // feature); the shell only shows/hides the panel and reacts to results.

  /** Common teardown after a capture stops: hide the transcript panel, refresh
   *  the workspace tree so the new meeting-*.md appears, and open it in a tab. */
  const finishCapture = useCallback(async (notePath: string) => {
    captureUiStore.getState().reset();
    setShowTranscript(false);
    await workspaceStore.getState().refresh();
    const basename = notePath.split("/").at(-1) ?? notePath;
    tabsStore.getState().open(notePath, basename);
  }, []);

  /** Start capture from the command palette. Opens the TranscriptView panel and
   *  delegates the actual invoke + state updates to TranscriptView via the
   *  captureUi store's triggerStart so there is only one code path. */
  const startTranscription = useCallback(() => {
    setShowTranscript(true);
    captureUiStore.getState().triggerStart();
  }, []);

  /** Stop capture from the command palette / footer. Mirrors the in-panel Stop
   *  button; capturePath comes from the shared captureUi store — correct
   *  whether capture started via palette or in-panel Start. */
  const stopTranscription = useCallback(async () => {
    try {
      await invoke("stop_capture");
      const path = captureUiStore.getState().capturePath;
      if (path) {
        await finishCapture(path);
      } else {
        captureUiStore.getState().reset();
        setShowTranscript(false);
      }
    } catch (e) {
      console.error("[transcription] stop_capture failed:", e);
    }
  }, [finishCapture]);

  // ── first-launch onboarding (BYO storage phase 3) ───────────────────────────

  /** Stamp the server-side onboarded flag for the current identity. A failure
   *  is a console.warn, never a dialog. No-op when there is no identity. */
  const stampServerOnboarded = useCallback(async () => {
    const ws = workspacesStore.getState();
    if (!ws.identity?.id) return;
    try {
      await apiRequest(ws.activeServer, {
        method: "PATCH",
        path: "/api/me",
        body: { onboarded: true },
      });
    } catch (e) {
      console.warn("[onboarding] server stamp failed:", e);
    }
  }, []);

  /** Open the sign-in dialog. Every entry point goes through here so the
   *  from-onboarding continuation flag can never go stale. */
  const openSignIn = useCallback((fromOnboarding: boolean) => {
    signInFromOnboardingRef.current = fromOnboarding;
    setShowSignIn(true);
  }, []);

  /** Sign-in dialog "Not now": close only; the onboarding fork does NOT fall
   *  through to Settings → Profile on a cancel — that fallback is reserved for
   *  a login that RAN and produced no identity. */
  const cancelSignIn = useCallback(() => {
    setShowSignIn(false);
    signInFromOnboardingRef.current = false;
  }, []);

  /** Sign-in dialog confirm: close it FIRST (so it can never stack with the
   *  keychain explainer login() may raise), then run the login flow. Logged in
   *  while onboarding's server fork opened this dialog → stamp the server
   *  onboarded flag and open the shared create-workspace wizard. No identity
   *  (login failed or keychain consent declined) → Settings → Profile
   *  REGARDLESS of entry point: the primary account surface, which renders both
   *  the Sign in retry button AND workspaces.error right below it. */
  const confirmSignIn = useCallback(async () => {
    setShowSignIn(false);
    const fromOnboarding = signInFromOnboardingRef.current;
    signInFromOnboardingRef.current = false;
    await workspacesStore.getState().login();
    if (workspacesStore.getState().identity) {
      if (fromOnboarding) {
        await stampServerOnboarded();
        setShowCreateWorkspace(true);
      }
      return;
    }
    setSettingsSection("profile");
    setShowSettings(true);
    setShowGraph(false);
  }, [stampServerOnboarded]);

  /** The "Connect to a server" fork: already signed in → straight to the
   *  post-login logic (stamp + wizard); no identity yet → the sign-in dialog,
   *  whose confirm path runs login() and then that same post-login logic. */
  const connectToServer = useCallback(async () => {
    if (workspacesStore.getState().identity) {
      await stampServerOnboarded();
      setShowCreateWorkspace(true);
      return;
    }
    openSignIn(true);
  }, [openSignIn, stampServerOnboarded]);

  const onboardingHost = useMemo(
    () => ({
      context: { kind: "desktop" as const },
      // Stamp the LOCAL flag always; the server flag too when logged in.
      finish: async (_skipped: boolean) => {
        setShowOnboarding(false);
        settingsStore.getState().setOnboarded(true);
        await stampServerOnboarded();
      },
      primaryAction: (action: string) => {
        if (action === "local") setShowPicker(true);
        else if (action === "server") {
          // The no-last-workspace fallback may have opened the picker beneath
          // the onboarding overlay; the server fork must not leave it queued to
          // pop open after CreateWorkspaceModal closes.
          setShowPicker(false);
          void connectToServer();
        }
      },
    }),
    [connectToServer, stampServerOnboarded],
  );

  // ── right-sidebar auto-open on collab reveal ────────────────────────────────
  // When the collab flow reveals a panel — creating a comment switches the
  // store tab to "comments", clicking a highlight bumps revealThreadId — make
  // sure the right sidebar is open so the panel is actually visible. The FIRST
  // observation of a store establishes a baseline (so opening a synced doc
  // never force-opens the sidebar); only later CHANGES force it open.
  const collabStore = useDocCollab((s) => s.store);
  useCollabSnapshot(collabStore);
  const revealSignal = collabStore
    ? `${collabStore.tab}|${collabStore.revealThreadId ?? ""}`
    : null;
  const revealStoreRef = useRef<unknown>(null);
  const revealSignalRef = useRef<string | null>(null);
  useEffect(() => {
    if (collabStore !== revealStoreRef.current) {
      revealStoreRef.current = collabStore;
      revealSignalRef.current = revealSignal;
      return;
    }
    if (revealSignal !== revealSignalRef.current) {
      revealSignalRef.current = revealSignal;
      setRightSidebarOpen(true);
    }
  });

  // ── sidebar-top scroll hairline ─────────────────────────────────────────────
  // A zero-height sentinel sits as the first child of the tree scroll
  // container; one IntersectionObserver (root = the container) flips
  // `treeScrolled` when the sentinel leaves view, i.e. when content is scrolled
  // under the fixed header. No scroll listeners. Callback refs (useState) so
  // the observer rewires across conditional mounts (sidebar collapse, no tree).
  const [treeScrollEl, setTreeScrollEl] = useState<HTMLDivElement | null>(null);
  const [treeSentinelEl, setTreeSentinelEl] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!treeScrollEl || !treeSentinelEl) {
      setTreeScrolled(false);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        // Latest entry wins; sentinel out of view ⇒ scrolled under the header.
        setTreeScrolled(!entries[entries.length - 1].isIntersecting);
      },
      { root: treeScrollEl, threshold: 0 },
    );
    observer.observe(treeSentinelEl);
    return () => {
      observer.disconnect();
      setTreeScrolled(false);
    };
  }, [treeScrollEl, treeSentinelEl]);

  // ── sidebar resize (live DOM writes, commit on release) ─────────────────────
  const handleLeftDrag = useCallback((clientX: number) => {
    const w = clamp(clientX, LEFT_MIN, LEFT_MAX);
    if (leftAsideRef.current) leftAsideRef.current.style.width = `${w}px`;
    if (titleLeftZoneRef.current) titleLeftZoneRef.current.style.width = `${w}px`;
  }, []);
  const handleLeftEnd = useCallback((clientX: number) => {
    sidebarsStore.getState().setLeft(clamp(clientX, LEFT_MIN, LEFT_MAX));
  }, []);
  const handleRightDrag = useCallback((clientX: number) => {
    const w = clamp(window.innerWidth - clientX, RIGHT_MIN, RIGHT_MAX);
    if (rightAsideRef.current) rightAsideRef.current.style.width = `${w}px`;
  }, []);
  const handleRightEnd = useCallback((clientX: number) => {
    sidebarsStore.getState().setRight(clamp(window.innerWidth - clientX, RIGHT_MIN, RIGHT_MAX));
  }, []);

  // ── startup sequence (ONE mount effect, Svelte AppShell onMount order) ──────
  const initRan = useRef(false);
  useEffect(() => {
    // Belt-and-braces double-run guard (no StrictMode, but the editor-IPC
    // hazard makes accidental double-init unacceptable).
    if (initRan.current) return;
    initRan.current = true;

    window.addEventListener("dragover", cancelWindowDnd);
    window.addEventListener("drop", cancelWindowDnd);

    // Apply theme early (loads persisted mode, sets data-theme + .dark class,
    // installs the OS listener, syncs native window appearance).
    themeStore.getState().init();
    // Apply the persisted accent (--accent-primary* CSS vars).
    accentStore.getState().init();
    // Apply persisted background (translucency / hue / tint) CSS vars.
    backgroundStore.getState().init();
    // Apply the persisted folder-icon color CSS var.
    folderColorStore.getState().init();
    // Sync theme/accent/tint/folder-color per-user through the server once a
    // signed-in identity exists (after the local applies above, so a stored
    // server value wins over the machine-local one at boot).
    prefsSync.start();

    // Seamless updates: launch check after ~10s + every 4h. Dev builds idle.
    updatesStore.getState().start();

    // Populate the workspace picker list; once the (possibly logged-in)
    // identity is known, evaluate first-launch onboarding: local flag primary,
    // server flag silences across devices.
    void workspacesStore
      .getState()
      .refresh()
      .then(() => {
        const settings = settingsStore.getState();
        const decision = onboardingDecision(
          settings.onboarded,
          workspacesStore.getState().identity?.onboarded_at,
        );
        if (decision === "mark-silently") settings.setOnboarded(true);
        else if (decision === "show") setShowOnboarding(true);
      });

    void (async () => {
      // Load workspace
      await workspaceStore.getState().loadRecents();
      const last = await getLastWorkspace();
      if (last) {
        try {
          // Resume through the daemon-aware path so a cloned workspace's Tier-1
          // sync restarts on relaunch; fall back to a bare open for
          // unregistered folders.
          const resumed = await workspacesStore.getState().openByPath(last);
          if (!resumed) await workspaceStore.getState().openWorkspace(last);
        } catch {
          // Remembered workspace is gone/unreadable — fall back to the picker.
          setShowPicker(true);
        }
      } else {
        setShowPicker(true);
      }

      // Learn whether this platform supports transcription (macOS-only). Gates
      // every transcription affordance; on Windows/Linux the feature is hidden.
      await platformStore.getState().init();

      // Warm the speech models into memory in the background so the first
      // recording starts instantly (loading two ONNX engines otherwise costs
      // ~3-4s on click). Skipped entirely off macOS.
      if (platformStore.getState().transcription) {
        invoke("ensure_model")
          .then(() => invoke("warm_models"))
          .catch(() => {
            /* model not present yet / offline — recording will cold-load */
          });

        // Meeting-transcription palette commands: macOS-only.
        commandsStore.getState().registerAll([
          {
            id: "start-transcription",
            title: "Start meeting transcription",
            run: () => startTranscription(),
          },
          {
            id: "stop-transcription",
            title: "Stop meeting transcription",
            run: () => void stopTranscription(),
          },
        ]);
      }
    })();

    // Register core commands
    commandsStore.getState().registerAll([
      { id: "new-note", title: "New note", hotkey: "⌘N", run: () => void handleNewNote() },
      { id: "new-folder", title: "New folder", run: () => void handleNewFolder() },
      { id: "open-workspace", title: "Open / switch workspace", run: () => setShowPicker(true) },
      {
        id: "toggle-sidebar",
        title: "Toggle left sidebar",
        hotkey: "⌘\\",
        run: () => setSidebarOpen((v) => !v),
      },
      {
        id: "toggle-right-sidebar",
        title: "Toggle right sidebar",
        hotkey: "⌘⌥→",
        run: () => setRightSidebarOpen((v) => !v),
      },
      {
        id: "toggle-reading-view",
        title: "Toggle reading view",
        hotkey: "⌘E",
        run: () => {
          const t = tabsStore.getState();
          if (t.activeId) t.toggleMode(t.activeId);
        },
      },
      { id: "refresh-tree", title: "Refresh tree", run: () => void workspaceStore.getState().refresh() },
    ]);

    // Install the global keymap. Callbacks read live state via getState()/refs
    // — they outlive every render closure.
    const removeKeymap = installKeymap({
      openPalette: () => {
        setShowSwitcher(false);
        setShowPalette(true);
      },
      openSwitcher: () => {
        setShowPalette(false);
        setShowSwitcher(true);
      },
      openSearch: () => {
        if (workspaceStore.getState().root) setShowSearch((v) => !v);
      },
      newNote: () => void handleNewNote(),
      toggleReading: () => {
        const t = tabsStore.getState();
        if (t.activeId) t.toggleMode(t.activeId);
      },
      toggleRightSidebar: () => setRightSidebarOpen((v) => !v),
      closeModal: () => {
        // escapeFallbackTarget owns the layer order AND the state guards:
        // signIn/keychainConsent/onboarding return null so the fallback touches
        // nothing — those modals handle their own Escape (with preventDefault).
        const target = escapeFallbackTarget(layersRef.current);
        if (target === "search") setShowSearch(false);
        else if (target === "palette") setShowPalette(false);
        else if (target === "switcher") setShowSwitcher(false);
        else if (target === "settings") closeSettings();
        else if (target === "picker") setShowPicker(false);
      },
    });

    return () => {
      window.removeEventListener("dragover", cancelWindowDnd);
      window.removeEventListener("drop", cancelWindowDnd);
      removeKeymap();
      updatesStore.getState().stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── render ──────────────────────────────────────────────────────────────────
  return (
    <>
      <div
        className="bg-app-shell text-foreground flex h-screen flex-col overflow-hidden"
        style={{ background: "var(--floor-tint)" }}
      >
        {/* Title strip: window controls sit in a left zone whose width matches
            the sidebar when open, so the tab strip aligns to the editor card's
            left edge. Every non-interactive surface is a Tauri drag region. */}
        <div className="flex h-12 shrink-0 items-stretch bg-transparent" data-tauri-drag-region="">
          {/* Left zone: traffic-light inset (pl-[72px]), sidebar toggle. When
              open, the toggle sits at the sidebar's right edge (Obsidian-style);
              when closed it collapses to the far left. */}
          <div
            ref={titleLeftZoneRef}
            className="flex shrink-0 items-center gap-0.5 pr-1 pl-[72px]"
            style={sidebarOpen ? { width: sidebarLeft } : undefined}
            data-tauri-drag-region=""
          >
            {sidebarOpen ? (
              <>
                <div className="flex-1" data-tauri-drag-region="" />
                <IconButton label="Collapse sidebar" onClick={() => setSidebarOpen(false)}>
                  <PanelLeftClose size={16} />
                </IconButton>
              </>
            ) : (
              <IconButton label="Open sidebar" onClick={() => setSidebarOpen(true)}>
                <PanelLeftOpen size={16} />
              </IconButton>
            )}
          </div>
          {/* Tab strip: aligned to the editor card (padding-left = card inset) */}
          {!showTranscript ? (
            <div
              className="flex min-w-0 flex-1 items-center"
              style={{ paddingLeft: "var(--inset-card)" }}
              data-tauri-drag-region=""
            >
              <TabStrip />
            </div>
          ) : (
            <div className="min-w-0 flex-1" data-tauri-drag-region="" />
          )}
          {/* Right sidebar toggle: state-dependent open/close icons */}
          <div className="flex shrink-0 items-center pr-2" data-tauri-drag-region="">
            {rightSidebarOpen ? (
              <IconButton label="Collapse right sidebar" onClick={() => setRightSidebarOpen(false)}>
                <PanelRightClose size={16} />
              </IconButton>
            ) : (
              <IconButton label="Open right sidebar" onClick={() => setRightSidebarOpen(true)}>
                <PanelRightOpen size={16} />
              </IconButton>
            )}
          </div>
        </div>

        {/* Body */}
        <div className="flex min-h-0 flex-1">
          {/* Left sidebar */}
          {sidebarOpen && (
            <>
              <aside
                ref={leftAsideRef}
                className="flex shrink-0 flex-col bg-transparent"
                style={{ width: sidebarLeft }}
              >
                {/* Workspace header: identity, workspace list, Open local
                    folder…, Create remote workspace…, Settings, Sign in/out all
                    in ONE dropdown; notifications sit at the right. showPicker
                    drives its open state so the palette command and the
                    no-workspace fallback can pop it. */}
                <div className="flex items-center gap-1 px-2 pt-2 pb-1">
                  <WorkspaceMenu
                    open={showPicker}
                    onOpenChange={setShowPicker}
                    onSettings={() => {
                      setShowSettings(true);
                      setShowGraph(false);
                    }}
                    onSignIn={() => openSignIn(false)}
                  />
                  {identity && (
                    <NotificationsBell server={activeServer} onSignIn={() => openSignIn(false)} />
                  )}
                </div>

                {/* Explorer icon row */}
                <div className="flex items-center gap-0.5 px-2 pt-0 pb-1.5">
                  <IconButton label="New note" onClick={() => void handleNewNote()} disabled={!root}>
                    <SquarePen size={16} />
                  </IconButton>
                  <IconButton
                    label="New folder"
                    onClick={() => void handleNewFolder()}
                    disabled={!root}
                  >
                    <FolderPlus size={16} />
                  </IconButton>
                  <IconButton
                    label={sortMode === "name-asc" ? "Sort: A→Z" : "Sort: Z→A"}
                    onClick={() => workspaceStore.getState().cycleSort()}
                    disabled={!root}
                  >
                    <ArrowUpDown size={16} />
                  </IconButton>
                  <IconButton
                    label="Collapse all"
                    onClick={() => workspaceStore.getState().collapseAll()}
                    disabled={!root}
                  >
                    <ChevronsDownUp size={16} />
                  </IconButton>
                  <IconButton
                    label="Graph view"
                    active={showGraph}
                    onClick={() => {
                      const next = !showGraph;
                      setShowGraph(next);
                      if (next) closeSettings();
                    }}
                    disabled={!root}
                  >
                    <Network size={16} />
                  </IconButton>
                  <IconButton
                    label="Search files & content (⌘K)"
                    onClick={() => setShowSearch(true)}
                    disabled={!root}
                  >
                    <Search size={16} />
                  </IconButton>
                </div>

                {/* Hairline at the bottom edge of the fixed header stack: fades
                    in only while the tree is scrolled (sentinel observer). */}
                <div className={cn("sidebar-hairline", treeScrolled && "visible")} aria-hidden="true" />

                {tree ? (
                  <div className="tree-scroll flex-1 overflow-y-auto text-sm" ref={setTreeScrollEl}>
                    <div ref={setTreeSentinelEl} aria-hidden="true" />
                    <FileTree
                      ref={fileTreeRef}
                      tree={tree}
                      activePath={activePath}
                      onOpen={handleOpen}
                    />
                  </div>
                ) : (
                  <div className="text-muted-foreground flex-1 px-2 py-4 text-sm italic">
                    No workspace open
                  </div>
                )}

                {pillVisible && <UpdatePill />}
              </aside>
              {/* Drag the floor gap to resize the left sidebar. The indicator
                  shifts right by the editor card's inset so the blue line hugs
                  the card's visible edge instead of floating in the gap. */}
              <ResizeHandle
                shift="var(--inset-card)"
                onDrag={handleLeftDrag}
                onEnd={handleLeftEnd}
                label="Resize left sidebar"
              />
            </>
          )}

          {/* Main area */}
          <main className="flex min-w-0 flex-1 flex-col">
            {showTranscript && transcription ? (
              <TranscriptView
                workspaceDir={root ?? ""}
                onStop={() => {
                  setShowTranscript(false);
                  void workspaceStore.getState().refresh();
                }}
                onSaved={(notePath: string) => void finishCapture(notePath)}
              />
            ) : (
              /* Floating canvas card: page-canvas surface lifted off the
                 translucent floor. Rounded + hairline ring + whisper shadow,
                 inset on all sides so it reads as a pane floating
                 concentrically inside the window; the pill tabs above float in
                 the strip and align to this card's left edge. */
              <div
                className="bg-page-canvas ring-surface-border flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl shadow-[var(--surface-shadow)] ring-1"
                style={{ margin: "0 var(--inset-card) var(--inset-card)" }}
              >
                {showSettings ? (
                  <SettingsPanel initialSection={settingsSection} onClose={closeSettings} />
                ) : showGraph ? (
                  <GraphView root={root ?? ""} activePath={activePath} onOpen={handleOpen} />
                ) : (
                  <EditorPane />
                )}
              </div>
            )}
          </main>

          {/* Right sidebar (Outline / collab panels; hidden during transcript) */}
          {rightSidebarOpen && !showTranscript && (
            <>
              <ResizeHandle
                onDrag={handleRightDrag}
                onEnd={handleRightEnd}
                label="Resize right sidebar"
              />
              <RightSidebar ref={rightAsideRef} />
            </>
          )}
        </div>

        {/* Recording status footer (only while the transcript panel is open) */}
        {showTranscript && (
          <footer className="border-border text-muted-foreground flex shrink-0 items-center border-t bg-transparent px-3 py-0.5 text-xs">
            <Mic size={12} className="text-destructive mr-1" />
            <span className="mr-2">{captureStatus === "error" ? "Recording error" : "Recording…"}</span>
            <button
              type="button"
              className="hover:text-foreground transition-colors"
              onClick={() => void stopTranscription()}
            >
              Close transcript
            </button>
          </footer>
        )}
      </div>

      {/* Modal layer — Escape routing lives in services/keymap.ts: each modal
          handles its own Escape with preventDefault; escapeFallbackTarget
          provides the window-level fallback in the documented priority order. */}
      <CommandPalette open={showPalette} onClose={() => setShowPalette(false)} />
      <QuickSwitcher open={showSwitcher} onClose={() => setShowSwitcher(false)} />
      <SearchModal open={showSearch} onClose={() => setShowSearch(false)} />
      {showOnboarding && (
        <OnboardingOverlay host={onboardingHost} onFinish={() => setShowOnboarding(false)} />
      )}
      {keychainAsking && (
        /* macOS keychain-consent explainer, rendered from the chokepoint
           store's state so any ensureKeychainConsent() caller raises exactly
           one dialog; the answers settle every waiter. */
        <KeychainConsentModal
          onGrant={() => void keychainConsentStore.getState().grant()}
          onDecline={() => keychainConsentStore.getState().decline()}
        />
      )}
      {showSignIn && (
        /* Sign-in server picker: shows WHICH server before the login flow runs.
           Cannot stack with the keychain explainer — confirmSignIn closes this
           dialog BEFORE workspaces.login() can raise keychainConsent.asking. */
        <SignInModal onConfirm={() => void confirmSignIn()} onCancel={cancelSignIn} />
      )}
      {showCreateWorkspace && (
        <CreateWorkspaceModal onClose={() => setShowCreateWorkspace(false)} />
      )}
    </>
  );
}
