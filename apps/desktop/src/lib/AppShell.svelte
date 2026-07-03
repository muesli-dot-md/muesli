<script lang="ts">
  import { invoke } from '@tauri-apps/api/core';
  import { onMount, onDestroy } from 'svelte';
  import { PanelLeftOpen, PanelLeftClose, PanelRightOpen, PanelRightClose, Search, Mic, SquarePen, FolderPlus, ArrowUpDown, ChevronsDownUp, Network } from 'lucide-svelte';
  import TranscriptView from '$lib/TranscriptView.svelte';
  import WorkspacePicker from '$lib/WorkspacePicker.svelte';
  import WorkspaceMenu from '$lib/WorkspaceMenu.svelte';
  import FileTree from '$lib/FileTree.svelte';
  import TabStrip from '$lib/TabStrip.svelte';
  import EditorPane from '$lib/EditorPane.svelte';
  import GraphView from '$lib/GraphView.svelte';
  import CommandPalette from '$lib/CommandPalette.svelte';
  import QuickSwitcher from '$lib/QuickSwitcher.svelte';
  import SearchModal from '$lib/SearchModal.svelte';
  import SettingsPanel from '$lib/SettingsPanel.svelte';
  import RightSidebar from '$lib/RightSidebar.svelte';
  import ResizeHandle from '$lib/ResizeHandle.svelte';
  import { sidebars } from '$lib/sidebars.svelte';
  import { workspace } from '$lib/workspace.svelte';
  import { workspaces } from '$lib/workspaces.svelte';
  import { tabs } from '$lib/tabs.svelte';
  import { getLastWorkspace, createNote, createFolder } from '$lib/tauri';
  import { commands } from '$lib/commands/registry.svelte';
  import { installKeymap, escapeFallbackTarget } from '$lib/keymap';
  import { theme } from '$lib/theme.svelte';
  import { background } from '$lib/background.svelte';
  import { platform } from '$lib/platform.svelte';
  import { docCollab } from '$lib/collab/docCollab.svelte';
  import NotificationsBell from '$lib/notifications/NotificationsBell.svelte';
  import CreateWorkspaceModal from '$lib/CreateWorkspaceModal.svelte';
  import OnboardingFlow from '@muesli/workspace-setup/OnboardingFlow.svelte';
  import type { OnboardingAction, OnboardingHost } from '@muesli/workspace-setup/onboarding';
  import { apiRequest } from '$lib/collab/apiRequest';
  import { settings } from '$lib/settings.svelte';
  import { updates } from '$lib/updates.svelte';
  import UpdatePill from '$lib/UpdatePill.svelte';
  import { onboardingDecision } from '$lib/onboardingGate';
  import KeychainConsentModal from '$lib/KeychainConsentModal.svelte';
  import { keychainConsent } from '$lib/keychainConsent.svelte';
  import SignInModal from '$lib/SignInModal.svelte';

  let sidebarOpen = $state(true);
  let rightSidebarOpen = $state(false);

  // When the collab flow reveals a panel — creating a comment switches the store
  // tab to "comments", clicking a highlight bumps revealThreadId — make sure the
  // right sidebar is open so the panel is actually visible. We track the store
  // identity + a reveal signal (tab + revealThreadId): the FIRST observation of a
  // store establishes a baseline (so opening a synced doc never force-opens the
  // sidebar), and only later CHANGES to that signal force it open.
  let revealStore: unknown = null;
  let revealSignal: string | null = null;
  $effect(() => {
    const store = docCollab.store;
    const signal = store ? `${store.tab}|${store.revealThreadId ?? ''}` : null;
    if (store !== revealStore) {
      // New (or cleared) store: just record the baseline, don't force open.
      revealStore = store;
      revealSignal = signal;
      return;
    }
    if (signal !== revealSignal) {
      revealSignal = signal;
      rightSidebarOpen = true;
    }
  });
  let showTranscript = $state(false);
  let showPicker = $state(false);
  let showSignIn = $state(false);
  let showOnboarding = $state(false);
  let showCreateWorkspace = $state(false);
  let showPalette = $state(false);
  let showSwitcher = $state(false);
  let showSettings = $state(false);
  // Section SettingsPanel lands on when it next mounts; the onboarding server
  // fork deep-links to Sync, every other open path uses the default (Profile).
  let settingsSection = $state<'sync' | undefined>(undefined);
  let showSearch = $state(false);
  // Graph view replaces the editor pane in the main area when toggled on. Opening
  // a document (handleOpen) flips it back off so the editor returns to focus.
  let showGraph = $state(false);

  // --- sidebar-top scroll hairline (spec §1) -----------------------------------
  // A zero-height sentinel sits as the first child of the tree scroll container;
  // one IntersectionObserver (root = the container) flips `treeScrolled` when the
  // sentinel leaves view, i.e. when content is scrolled under the fixed header.
  // No scroll listeners. The $effect teardown disconnects the observer whenever
  // the sidebar collapses, the workspace tree unmounts, or the shell unmounts.
  let treeScrollEl = $state<HTMLDivElement | null>(null);
  let treeSentinelEl = $state<HTMLDivElement | null>(null);
  let treeScrolled = $state(false);

  $effect(() => {
    const root = treeScrollEl;
    const sentinel = treeSentinelEl;
    if (!root || !sentinel) {
      treeScrolled = false;
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        // Latest entry wins; sentinel out of view ⇒ scrolled under the header.
        treeScrolled = !entries[entries.length - 1].isIntersecting;
      },
      { root, threshold: 0 },
    );
    observer.observe(sentinel);
    return () => {
      observer.disconnect();
      treeScrolled = false;
    };
  });

  /**
   * Shared capture state bound to TranscriptView. These are the single source
   * of truth — TranscriptView mutates them via $bindable props so AppShell
   * always sees the correct running/path state regardless of which code path
   * started the capture (palette or in-panel Start button).
   */
  let captureStatus = $state<'idle' | 'running' | 'error'>('idle');
  let capturePath = $state<string | null>(null);
  /**
   * Flip to true to tell TranscriptView to call startCapture() internally.
   * TranscriptView resets it to false immediately after consuming it.
   */
  let triggerStart = $state(false);

  /**
   * Common teardown after a capture stops: hide the transcript panel, refresh
   * the workspace tree so the new meeting-*.md appears, and open it in a tab.
   */
  async function finishCapture(notePath: string) {
    capturePath = null;
    captureStatus = 'idle';
    showTranscript = false;
    await workspace.refresh();
    const basename = notePath.split('/').at(-1) ?? notePath;
    tabs.open(notePath, basename);
  }

  /**
   * Start capture from the command palette. Opens the TranscriptView panel and
   * delegates the actual invoke + state updates to TranscriptView's startCapture()
   * via the triggerStart flag so there is only one code path for state changes.
   */
  function startTranscription() {
    showTranscript = true;
    triggerStart = true;
  }

  /**
   * Stop capture from the command palette. Mirrors the in-panel Stop button
   * for users who prefer the palette. Uses capturePath which is the shared
   * binding from TranscriptView — correct whether capture started via palette
   * or in-panel Start.
   */
  async function stopTranscription() {
    try {
      await invoke('stop_capture');
      if (capturePath) {
        await finishCapture(capturePath);
      } else {
        captureStatus = 'idle';
        showTranscript = false;
      }
    } catch (e) {
      console.error('[transcription] stop_capture failed:', e);
    }
  }

  /**
   * Callback passed to TranscriptView. Called after the in-panel Stop button
   * completes stop_capture, with the finished note path.
   */
  async function handleTranscriptStop(notePath: string) {
    await finishCapture(notePath);
  }

  // activePath is derived from the tab store
  let activePath = $derived(tabs.active()?.path ?? null);

  let removeKeymap: (() => void) | null = null;

  onMount(async () => {
    // Apply theme early (loads persisted mode, sets data-theme, installs OS listener)
    theme.init();
    // Apply persisted background (translucency / hue / tint) CSS vars.
    background.init();

    // Seamless updates (spec 2026-07-02 §3): launch check after ~10s + every 4h.
    // Dev builds stay idle (one debug line inside the store).
    updates.start();

    // Populate the workspace picker list; once the (possibly logged-in)
    // identity is known, evaluate first-launch onboarding (BYO storage phase 3,
    // spec §2): local flag primary, server flag silences across devices.
    void workspaces.refresh().then(() => {
      const decision = onboardingDecision(settings.onboarded, workspaces.identity?.onboarded_at);
      if (decision === 'mark-silently') settings.setOnboarded(true);
      else if (decision === 'show') showOnboarding = true;
    });

    // Load workspace
    await workspace.loadRecents();
    const last = await getLastWorkspace();
    if (last) {
      try {
        // Resume through the daemon-aware path so a cloned workspace's Tier-1 sync
        // restarts on relaunch; fall back to a bare open for unregistered folders.
        const resumed = await workspaces.openByPath(last);
        if (!resumed) await workspace.openWorkspace(last);
      } catch {
        // Remembered workspace is gone/unreadable — fall back to the picker.
        showPicker = true;
      }
    } else {
      showPicker = true;
    }

    // Learn whether this platform supports transcription (macOS-only). Gates every
    // transcription affordance below; on Windows/Linux the feature is hidden.
    await platform.init();

    // Warm the speech models into memory in the background so the first recording
    // starts instantly (loading two ONNX engines otherwise costs ~3-4s on click).
    // Skipped entirely off macOS — no model is downloaded and recording is hidden.
    if (platform.transcription) {
      invoke('ensure_model')
        .then(() => invoke('warm_models'))
        .catch(() => { /* model not present yet / offline — recording will cold-load */ });
    }

    // Register core commands
    commands.registerAll([
      {
        id: 'new-note',
        title: 'New note',
        hotkey: '⌘N',
        run: () => handleNewNote(),
      },
      {
        id: 'new-folder',
        title: 'New folder',
        run: () => handleNewFolder(),
      },
      {
        id: 'open-workspace',
        title: 'Open / switch workspace',
        run: () => { showPicker = true; },
      },
      {
        id: 'toggle-sidebar',
        title: 'Toggle left sidebar',
        hotkey: '⌘\\',
        run: () => { sidebarOpen = !sidebarOpen; },
      },
      {
        id: 'toggle-right-sidebar',
        title: 'Toggle right sidebar',
        hotkey: '⌘⌥→',
        run: () => { rightSidebarOpen = !rightSidebarOpen; },
      },
      // Hooks for future tasks — registered but not yet functional
      {
        id: 'toggle-reading-view',
        title: 'Toggle reading view',
        hotkey: '⌘E',
        run: () => {
          const id = tabs.activeId;
          if (id) tabs.toggleMode(id);
        },
      },
      // Transcription palette commands are registered only on platforms that
      // support it (macOS) — see the conditional block right after this call.
      {
        id: 'refresh-tree',
        title: 'Refresh tree',
        run: () => { workspace.refresh(); },
      },
    ]);

    // Meeting-transcription palette commands: macOS-only.
    if (platform.transcription) {
      commands.registerAll([
        {
          id: 'start-transcription',
          title: 'Start meeting transcription',
          run: () => { startTranscription(); },
        },
        {
          id: 'stop-transcription',
          title: 'Stop meeting transcription',
          run: () => { stopTranscription(); },
        },
      ]);
    }

    // Install global keymap
    removeKeymap = installKeymap({
      openPalette: () => { showSwitcher = false; showPalette = true; },
      openSwitcher: () => { showPalette = false; showSwitcher = true; },
      openSearch: () => { if (workspace.root) showSearch = !showSearch; },
      newNote: () => handleNewNote(),
      toggleReading: () => {
        const id = tabs.activeId;
        if (id) tabs.toggleMode(id);
      },
      toggleRightSidebar: () => { rightSidebarOpen = !rightSidebarOpen; },
      closeModal: () => {
        // escapeFallbackTarget owns the layer order AND the onboarding state
        // guard: while the onboarding overlay is up it returns null so the
        // fallback touches nothing — OnboardingFlow's own Escape handler
        // performs the skip (see the function's doc comment for why we can't
        // rely on defaultPrevented / listener order for that).
        const target = escapeFallbackTarget({
          signIn: showSignIn,
          keychainConsent: keychainConsent.asking,
          onboarding: showOnboarding,
          search: showSearch,
          palette: showPalette,
          switcher: showSwitcher,
          settings: showSettings,
          picker: showPicker,
        });
        if (target === 'search') showSearch = false;
        else if (target === 'palette') showPalette = false;
        else if (target === 'switcher') showSwitcher = false;
        else if (target === 'settings') closeSettings();
        else if (target === 'picker') showPicker = false;
      },
    });
  });

  onDestroy(() => {
    removeKeymap?.();
    updates.stop();
  });

  /** Close Settings and reset its deep-link section — the ONLY way Settings
   *  should be closed. The server-fork onboarding deep-links to Sync
   *  (settingsSection = 'sync'); every other Settings close must clear that
   *  so a later, unrelated Settings open doesn't land back on Sync. */
  function closeSettings() {
    showSettings = false;
    settingsSection = undefined;
  }

  function handleOpen(path: string) {
    const name = path.split('/').at(-1) ?? path;
    // Opening a document always returns from the graph/settings views to the editor.
    showGraph = false;
    closeSettings();
    tabs.open(path, name);
  }

  async function handleNewNote() {
    if (!workspace.root) return;
    const newPath = await createNote(workspace.root, 'Untitled.md');
    await workspace.refresh();
    handleOpen(newPath);
  }

  async function handleNewFolder() {
    const name = window.prompt('Folder name:');
    if (!name?.trim()) return;
    if (!workspace.root) return;
    await createFolder(workspace.root, name.trim());
    await workspace.refresh();
  }

  // --- first-launch onboarding (BYO storage phase 3) --------------------------------

  /** Stamp the server-side onboarded flag for the current identity. Rides the
   *  delegated bearer token (PATCH /api/me accepts agents for exactly this
   *  body); a failure is a console.warn, never a dialog (spec §5). No-op when
   *  there is no logged-in identity to stamp. */
  async function stampServerOnboarded() {
    if (!workspaces.identity?.id) return;
    try {
      await apiRequest(workspaces.activeServer, {
        method: 'PATCH',
        path: '/api/me',
        body: { onboarded: true },
      });
    } catch (e) {
      console.warn('[onboarding] server stamp failed:', e);
    }
  }

  const onboardingHost: OnboardingHost = {
    context: { kind: 'desktop' },
    // Stamp the LOCAL flag always; the server flag too when logged in (spec §2).
    finish: async (_skipped: boolean) => {
      showOnboarding = false;
      settings.setOnboarded(true);
      await stampServerOnboarded();
    },
    primaryAction: (action: OnboardingAction) => {
      if (action === 'local') showPicker = true;
      else if (action === 'server') {
        // The no-last-workspace fallback may have opened the picker beneath the
        // onboarding overlay; the server fork must not leave it queued to pop
        // open after CreateWorkspaceModal closes.
        showPicker = false;
        void connectToServer();
      }
    },
  };

  /** Whether the open sign-in dialog was reached via onboarding's "Connect to
   *  a server" fork — its confirm path then runs the fork's post-login logic. */
  let signInFromOnboarding = $state(false);

  /** Open the sign-in dialog (spec 2026-07-02). Every entry point goes through
   *  here so the from-onboarding continuation flag can never go stale. */
  function openSignIn(fromOnboarding: boolean) {
    signInFromOnboarding = fromOnboarding;
    showSignIn = true;
  }

  /** Sign-in dialog "Not now": close only; nothing else happens (spec §2) —
   *  in particular the onboarding fork does NOT fall through to Settings →
   *  Sync on a cancel; that fallback is reserved for a login that RAN and
   *  produced no identity. */
  function cancelSignIn() {
    showSignIn = false;
    signInFromOnboarding = false;
  }

  /** Sign-in dialog confirm: close it FIRST (so it can never stack with the
   *  keychain explainer login() may raise), then run the login flow — consent
   *  + device flow live inside workspaces.login(), unchanged. Logged in while
   *  onboarding's server fork opened this dialog → finish with the fork's
   *  post-login logic, verbatim from the pre-dialog connectToServer(): stamp
   *  the server onboarded flag (finish(false) ran BEFORE login, when no
   *  identity existed yet, so a brand-new user only got the local flag —
   *  re-stamp so their first web login doesn't show onboarding again) and open
   *  the shared create-workspace wizard. No identity (login failed — wrong
   *  server, network error — or the keychain consent was declined = quiet
   *  abort) → Settings → Sync REGARDLESS of entry point, the existing surface
   *  where the server address, login button, and error message live. Every
   *  sign-in entry point funnels through here, so this is the only place a
   *  failure needs handling — without it, non-onboarding sign-ins (the
   *  sidebar dropdown, Settings → Profile) failed completely silently. */
  async function confirmSignIn() {
    showSignIn = false;
    const fromOnboarding = signInFromOnboarding;
    signInFromOnboarding = false;
    await workspaces.login();
    if (workspaces.identity) {
      if (fromOnboarding) {
        await stampServerOnboarded();
        showCreateWorkspace = true;
      }
      return;
    }
    settingsSection = 'sync';
    showSettings = true;
    showGraph = false;
  }

  /** The "Connect to a server" fork: already signed in → straight to the
   *  post-login logic (stamp + wizard, same as before the dialog existed);
   *  no identity yet → the sign-in dialog, whose confirm path runs login()
   *  and then that same post-login logic (see confirmSignIn). */
  async function connectToServer() {
    if (workspaces.identity) {
      await stampServerOnboarded();
      showCreateWorkspace = true;
      return;
    }
    openSignIn(true);
  }
</script>

<div
  class="flex flex-col h-screen text-base-content"
  style="background: var(--floor-tint);"
>
  <!-- Title strip: window controls sit in a left zone whose width matches the
       sidebar when open, so the tab strip aligns to the editor card's left edge. -->
  <div
    class="flex items-stretch h-[48px] bg-transparent shrink-0"
    data-tauri-drag-region
  >
    <!-- Left zone: traffic-light inset, sidebar tools, and the sidebar toggle.
         When open, the toggle sits at the sidebar's right edge (Obsidian-style)
         and the freed space holds new-note + search; when closed it collapses to
         the far left. Width tracks the resizable sidebar so the tab strip stays
         aligned to the card. -->
    <div
      class="flex items-center pl-[72px] pr-1 shrink-0 gap-0.5"
      style={sidebarOpen ? `width: ${sidebars.left}px` : ''}
      data-tauri-drag-region
    >
      {#if sidebarOpen}
        <div class="flex-1" data-tauri-drag-region></div>
        <button
          class="btn btn-ghost btn-xs btn-square"
          onclick={() => (sidebarOpen = false)}
          title="Collapse sidebar"
        >
          <PanelLeftClose size={16} />
        </button>
      {:else}
        <button
          class="btn btn-ghost btn-xs btn-square"
          onclick={() => (sidebarOpen = true)}
          title="Open sidebar"
        >
          <PanelLeftOpen size={16} />
        </button>
      {/if}
    </div>
    <!-- Tab strip: aligned to the editor card (padding-left matches the card inset) -->
    {#if !showTranscript}
      <div
        class="tab-scroll flex-1 min-w-0 flex items-center overflow-x-auto"
        style="padding-left: var(--inset-card);"
        data-tauri-drag-region
      >
        <TabStrip />
      </div>
    {:else}
      <div class="flex-1 min-w-0" data-tauri-drag-region></div>
    {/if}
    <!-- Right sidebar toggle: state-dependent open/close icons, mirroring the left -->
    <div class="flex items-center pr-2 shrink-0" data-tauri-drag-region>
      {#if rightSidebarOpen}
        <button
          class="btn btn-ghost btn-xs btn-square"
          onclick={() => (rightSidebarOpen = false)}
          title="Collapse right sidebar"
        >
          <PanelRightClose size={16} />
        </button>
      {:else}
        <button
          class="btn btn-ghost btn-xs btn-square"
          onclick={() => (rightSidebarOpen = true)}
          title="Open right sidebar"
        >
          <PanelRightOpen size={16} />
        </button>
      {/if}
    </div>
  </div>

  <!-- Body -->
  <div class="flex flex-1 min-h-0">
    <!-- Left sidebar -->
    {#if sidebarOpen}
      <aside class="shrink-0 bg-transparent flex flex-col" style="width: {sidebars.left}px">
        <!-- Workspace header: a Multica-style workspace + account switcher is the
             click-to-switch surface (identity, workspace list, Open workspace…,
             Settings, Sign in/out, and Theme folded into its dropdown);
             notifications sit at the right. The rich add/clone/promote picker is
             rendered triggerless and opened from the switcher's "Open workspace…". -->
        <div class="flex items-center gap-1 px-2 pt-2 pb-1">
          <WorkspaceMenu
            onopenpicker={() => (showPicker = true)}
            onsettings={() => { showSettings = true; showGraph = false; }}
            onsignin={() => openSignIn(false)}
          />
          {#if workspaces.identity}
            <NotificationsBell server={workspaces.activeServer} />
          {/if}
        </div>
        <!-- Picker dropdown (no face of its own) for the open-local / clone /
             promote / create-remote flows, anchored under the header. -->
        <div class="relative px-2">
          <WorkspacePicker bind:open={showPicker} triggerless />
        </div>

        <!-- Explorer icon row: new note / new folder / sort / collapse-all / graph / search -->
        <div class="flex items-center gap-0.5 px-2 pt-0 pb-1.5">
          <button
            class="btn btn-ghost btn-xs btn-square"
            onclick={handleNewNote}
            title="New note"
            disabled={!workspace.root}
          >
            <SquarePen size={16} />
          </button>
          <button
            class="btn btn-ghost btn-xs btn-square"
            onclick={handleNewFolder}
            title="New folder"
            disabled={!workspace.root}
          >
            <FolderPlus size={16} />
          </button>
          <button
            class="btn btn-ghost btn-xs btn-square"
            onclick={() => workspace.cycleSort()}
            title={workspace.sortMode === 'name-asc' ? 'Sort: A→Z' : 'Sort: Z→A'}
            disabled={!workspace.root}
          >
            <ArrowUpDown size={16} />
          </button>
          <button
            class="btn btn-ghost btn-xs btn-square"
            onclick={() => workspace.collapseAll()}
            title="Collapse all"
            disabled={!workspace.root}
          >
            <ChevronsDownUp size={16} />
          </button>
          <button
            class="btn btn-ghost btn-xs btn-square"
            style={showGraph ? 'background: var(--lift); box-shadow: var(--shadow-lift);' : ''}
            onclick={() => { showGraph = !showGraph; if (showGraph) closeSettings(); }}
            title="Graph view"
            aria-pressed={showGraph}
            disabled={!workspace.root}
          >
            <Network size={16} />
          </button>
          <button
            class="btn btn-ghost btn-xs btn-square"
            onclick={() => (showSearch = true)}
            title="Search files & content (⌘K)"
            disabled={!workspace.root}
          >
            <Search size={16} />
          </button>
        </div>

        <!-- Hairline at the bottom edge of the fixed header stack: fades in only
             while the tree is scrolled (see the sentinel observer in the script). -->
        <div class="sidebar-hairline" class:visible={treeScrolled} aria-hidden="true"></div>

        {#if workspace.tree}
          <div class="tree-scroll flex-1 text-sm overflow-y-auto" bind:this={treeScrollEl}>
            <div bind:this={treeSentinelEl} aria-hidden="true"></div>
            <FileTree tree={workspace.tree} {activePath} onOpen={handleOpen} />
          </div>
        {:else}
          <div class="flex-1 px-2 text-sm text-base-content/40 italic py-4">
            No workspace open
          </div>
        {/if}

        {#if updates.pillVisible}
          <UpdatePill />
        {/if}
      </aside>
      <!-- Drag the floor gap to resize the left sidebar. The indicator shifts
           right by the editor card's inset so the blue line hugs the card's
           visible edge instead of floating in the gap. -->
      <ResizeHandle shift="var(--inset-card)" onResize={(x) => sidebars.setLeft(x)} />
    {/if}

    <!-- Main area -->
    <main class="flex-1 flex flex-col min-w-0">
      {#if showTranscript && platform.transcription}
        <TranscriptView
          workspaceDir={workspace.root}
          onStop={handleTranscriptStop}
          bind:captureStatus
          bind:capturePath
          bind:triggerStart
        />
      {:else}
        <!-- Floating card: base-100 surface lifted off the translucent floor.
             Rounded on all four corners and inset on all sides so it reads as a
             pane floating concentrically inside the window; the pill tabs above
             float in the strip and align to this card's left edge. The graph view
             replaces the editor inside the same card when toggled on. -->
        <div
          style="background: var(--color-base-100); border-radius: var(--radius-box); box-shadow: var(--shadow-card); margin: 0 var(--inset-card) var(--inset-card); overflow: hidden;"
          class="flex-1 flex flex-col min-h-0"
        >
          {#if showSettings}
            <!-- Settings renders inside the main panel (the file-tree sidebar to
                 the left stays put). Closing returns to the editor/graph. -->
            <SettingsPanel
              initialSection={settingsSection}
              onclose={closeSettings}
            />
          {:else if showGraph}
            <GraphView root={workspace.root} {activePath} onOpen={handleOpen} />
          {:else}
            <EditorPane />
          {/if}
        </div>
      {/if}
    </main>

    <!-- Right sidebar (Outline / Comments; hidden during transcript view) -->
    {#if rightSidebarOpen && !showTranscript}
      <ResizeHandle onResize={(x) => sidebars.setRight(window.innerWidth - x)} />
      <RightSidebar />
    {/if}
  </div>

  <!-- Recording status footer (only while capturing a transcript) -->
  {#if showTranscript}
    <footer class="shrink-0 flex items-center px-3 py-0.5 border-t border-base-300 bg-transparent text-xs text-base-content/60">
      <Mic size={12} class="mr-1 text-error" />
      <span class="mr-2">Recording…</span>
      <button
        class="hover:text-base-content transition-colors"
        onclick={stopTranscription}
      >
        Close transcript
      </button>
    </footer>
  {/if}
</div>

<CommandPalette open={showPalette} onclose={() => (showPalette = false)} />
<QuickSwitcher open={showSwitcher} onclose={() => (showSwitcher = false)} />
<SearchModal open={showSearch} onclose={() => (showSearch = false)} />
{#if showOnboarding}
  <!-- Same overlay chrome as CreateWorkspaceModal, but vertically centered
       (user preference — the keychain consent modal matches). Deliberately NO
       backdrop close: dismissing IS skipping (Escape or Skip), which stamps. -->
  <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
    <div
      class="mx-4 flex max-h-[78vh] w-full max-w-xl flex-col overflow-y-auto p-5"
      style="background: var(--overlay); box-shadow: var(--shadow-overlay); border-radius: var(--radius-overlay, 0.875rem);"
      role="dialog"
      aria-modal="true"
      aria-label="Welcome to Muesli"
    >
      <OnboardingFlow host={onboardingHost} />
    </div>
  </div>
{/if}
{#if keychainConsent.asking}
  <!-- macOS keychain-consent explainer (spec 2026-07-02). Rendered from the
       chokepoint store's state so any ensureKeychainConsent() caller raises
       exactly one dialog; the answers settle every waiter. This modal cannot
       stack with the onboarding overlay above: onboarding's server fork
       stamps and closes onboarding (finish runs synchronously before
       primaryAction) before any sign-in flow that could set
       keychainConsent.asking runs, so a single Escape can never reach two
       svelte:window dismissal handlers. -->
  <KeychainConsentModal
    ongrant={() => void keychainConsent.grant()}
    ondecline={() => keychainConsent.decline()}
  />
{/if}
{#if showSignIn}
  <!-- Sign-in server picker (spec 2026-07-02): shows WHICH server before the
       login flow runs. Cannot stack with the keychain explainer: confirmSignIn
       closes this dialog BEFORE workspaces.login() can raise
       keychainConsent.asking; and onboarding's finish() closes the onboarding
       overlay before its server fork can open this one. Escape routing: the
       modal's own svelte:window handler dismisses (editing-first), while the
       signIn layer keeps the keymap fallback silent (state guard, never
       listener order). -->
  <SignInModal onconfirm={() => void confirmSignIn()} oncancel={cancelSignIn} />
{/if}
{#if showCreateWorkspace}
  <CreateWorkspaceModal onclose={() => (showCreateWorkspace = false)} />
{/if}
