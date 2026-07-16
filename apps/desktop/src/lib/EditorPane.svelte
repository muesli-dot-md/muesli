<script lang="ts">
  import { tick } from "svelte";
  import { EditorView } from "@codemirror/view";
  import * as Y from "yjs";
  import { yCollab } from "y-codemirror.next";
  import { MessageSquarePlus } from "lucide-svelte";
  import { tabs } from "$lib/tabs.svelte";
  import { editorState } from "$lib/editorState.svelte";
  import Toolbar from "$lib/Toolbar.svelte";
  import { readNote, writeNote } from "$lib/tauri";
  import { createEditor } from "$lib/editor/createEditor";
  import { makeDebouncedSaver } from "$lib/editor/save";
  import { settings } from "$lib/settings.svelte";
  import { daemon } from "$lib/sync/daemon.svelte";
  import { workspace } from "$lib/workspace.svelte";
  import { deriveSlug } from "$lib/sync/slug";
  import { createSession, type Session } from "$lib/sync/session";
  import { createTauriSession } from "$lib/sync/tauri-provider";
  import { syncStatus } from "$lib/sync/status.svelte";
  import { workspaces } from "$lib/workspaces.svelte";
  import { presence } from "$lib/sync/presence.svelte";
  import { colorFromId } from "$lib/presence";
  import ReadingView from "$lib/ReadingView.svelte";
  import { docContext } from "$lib/collab/docContext";
  import { docCollab } from "$lib/collab/docCollab.svelte";
  import { mentionAutocomplete } from "$lib/collab/mentionAction.svelte";
  import { createCollabApi } from "$lib/collab/collabApi";
  import { CollabStore } from "$lib/collab/collabStore.svelte";
  import { collabDecorations, commentClickHandler } from "@muesli/editor-core/annotations";
  import { collabTheme } from "@muesli/editor-core/annotationsTheme";
  import SnapshotView from "$lib/collab/SnapshotView.svelte";

  // Collab decoration extensions (comment/suggestion highlights + comment-click
  // routing). The click handler resolves the live store at click time via
  // docCollab.store — the store is created in wireCollab AFTER the view, so we
  // can't close over it at editor-construction time.
  //
  // collabTheme is the daisyUI baseTheme for these highlights: the shared
  // editor-core decorations no longer bundle it (the web app styles the same
  // classes via app.css), so the desktop app — which has no such app.css rules —
  // opts in explicitly here to keep its prior styling.
  const collabAnnotations = [
    collabDecorations,
    collabTheme,
    commentClickHandler((threadId) => docCollab.store?.revealThread(threadId)),
  ];

  // Feed the open doc's collab store from editor transactions: keep its UTF-16
  // selection fresh (so addComment/addDraft anchor to the live selection) and
  // remap queued suggestion drafts through local edits. Mirrors the web
  // editor's updateListener. Also repositions the floating affordance.
  function onCollabUpdate(update: import("@codemirror/view").ViewUpdate): void {
    const store = docCollab.store;
    if (store) {
      if (update.docChanged) store.mapDraftsThroughChanges(update.changes);
      if (update.selectionSet || update.docChanged) {
        const sel = update.state.selection.main;
        store.selection = { from: sel.from, to: sel.to };
      }
    }
    if (update.selectionSet || update.docChanged) {
      if (!composerOpen) positionAffordance(update.view);
    }
  }

  // Read-only history snapshot, when a HistoryPanel entry is open. Rendered as
  // an overlay so the live editor underneath is never torn down or mutated.
  const snapshot = $derived(docCollab.store?.snapshot ?? null);

  // ── Comment / suggest affordance ───────────────────────────────────────────
  // Floating button over the active selection ("Comment", or "Suggest" in
  // suggest mode) that opens a small composer. Ported from apps/web Editor.svelte
  // with i18n replaced by English literals. Gated on isRemote (a comment can't
  // be created on a local-only vault file).
  let affordance: { x: number; y: number } | null = $state(null);
  let composerOpen = $state(false);
  let composerText = $state("");
  let suggestAction: "replace" | "insert-after" | "delete" = $state("replace");
  let composerEl: HTMLDivElement | null = $state(null);

  const collabStore = $derived(docCollab.store);
  const suggestMode = $derived(collabStore?.suggestMode ?? false);
  const hasSelection = $derived(
    !!collabStore && collabStore.selection.from !== collabStore.selection.to,
  );
  // Only offer the affordance on synced docs whose collab store is live and
  // reachable (not auth-degraded / volatile).
  const showAffordance = $derived(
    docCollab.isRemote &&
      !!collabStore &&
      hasSelection &&
      collabStore.availability !== "volatile" &&
      collabStore.availability !== "auth",
  );

  function positionAffordance(v: EditorView): void {
    const sel = v.state.selection.main;
    if (sel.empty || !wrap) {
      affordance = null;
      composerOpen = false;
      return;
    }
    const coords = v.coordsAtPos(sel.head);
    if (!coords) {
      affordance = null;
      return;
    }
    const rect = wrap.getBoundingClientRect();
    affordance = {
      x: Math.max(8, Math.min(coords.left - rect.left, rect.width - 300)),
      y: Math.min(coords.bottom - rect.top + 6, rect.height - 44),
    };
  }

  async function openComposer(): Promise<void> {
    composerOpen = true;
    composerText = "";
    suggestAction = "replace";
    await tick();
    composerEl?.querySelector("textarea")?.focus();
  }

  function closeComposer(): void {
    composerOpen = false;
    composerText = "";
  }

  async function submitComment(): Promise<void> {
    const store = docCollab.store;
    const body = composerText.trim();
    if (!store || !body) return;
    if (await store.addComment(body)) {
      closeComposer();
      store.sidebarOpen = true;
      store.tab = "comments";
    }
  }

  function addSuggestDraft(): void {
    const store = docCollab.store;
    if (!store) return;
    if (suggestAction !== "delete" && !composerText) return;
    store.addDraft(suggestAction, composerText);
    closeComposer();
    store.sidebarOpen = true;
    store.tab = "suggestions";
  }

  // Close the composer on an outside click (the affordance lives inside `wrap`).
  function onWindowPointerDown(e: PointerEvent): void {
    if (!composerOpen) return;
    if (composerEl && !composerEl.contains(e.target as Node)) closeComposer();
  }

  // The toolbar's (future) comment button funnels through the same composer the
  // selection affordance opens (collabStore.requestComposer bumps the counter).
  let seenComposerRequest = 0;
  $effect(() => {
    const store = docCollab.store;
    if (!store) return;
    const req = store.composerRequest;
    if (req > seenComposerRequest) {
      seenComposerRequest = req;
      const v = editorState.activeView;
      if (v && showAffordance) {
        positionAffordance(v);
        void openComposer();
      }
    }
  });

  // The DOM node we mount CodeMirror into
  let host: HTMLDivElement | undefined = $state();
  // The positioned wrapper the floating affordance is measured against.
  let wrap: HTMLDivElement | undefined = $state();

  // If sync is unreachable, seed the editor from disk after this long so the
  // file's content always shows and never gets clobbered by an empty Y.Doc.
  // The window can be short: a live daemon bridge answers from its in-memory
  // replica over IPC in milliseconds (even while the server socket is down —
  // see FileSession::serve_bridge_offline), so waiting longer only prolongs
  // the blank pane in the genuinely-dead cases.
  const SEED_FALLBACK_MS = 600;

  const activeTab = $derived(tabs.active());
  const isReadMode = $derived(activeTab?.mode === "read");

  // Value-stable primitives. The mount `$effect` below depends ONLY on these,
  // so it re-runs only on a REAL tab switch / path / mode change — never on a
  // keystroke. (Typing calls `tabs.setDirty`, which reassigns the tabs state
  // object; `tabs.active()` would therefore change identity every keystroke and
  // remount the whole editor + sync session. These derived values stay `===`,
  // so Svelte does not re-trigger the effect.)
  const activeId = $derived(tabs.activeId);
  const activePath = $derived(activeTab?.path ?? null);
  const activeMode = $derived<"edit" | "read">(activeTab?.mode ?? "edit");

  // Same rationale for the daemon's running flag: the status poll reassigns
  // `daemon.status` to a fresh object every 1s, so reading it directly in the
  // mount `$effect` would remount the whole editor once per second (a continuous
  // full re-render flicker once a synced workspace is open). A `$derived` boolean
  // only propagates when the VALUE flips, so the effect re-runs on a real
  // start/stop, never on the per-second poll churn.
  const daemonRunning = $derived(!!daemon.status?.running);

  function relativeToWorkspace(path: string): string {
    const root = workspace.root;
    if (root && path.startsWith(root + "/")) return path.slice(root.length + 1);
    // Fallback: just the basename (no workspace root known).
    return path.split("/").at(-1) ?? path;
  }

  $effect(() => {
    // Depend ONLY on the value-stable primitives (see note above) so a
    // keystroke never remounts the editor.
    const id = activeId;
    const path = activePath;
    const mode = activeMode;
    if (!id || !path) return;

    // Don't mount the editor in read mode — but DO refresh the shared text so
    // ReadingView and StatusBar show the correct content for this tab. This
    // branch MUST run before the `host` guard below: the CodeMirror host div
    // only renders in edit mode, so in read mode `host` is always unset and a
    // combined guard would dead-end the whole effect — leaving docCollab in
    // its reset state (isRemote false) and the Suggest segment disabled for
    // the entire reading session.
    if (mode === "read") {
      editorState.activeView = null;
      // Keep the collab context current so the panels stay correct in read mode.
      // Same sync gate as the edit-mode mount below (identity AND workspace
      // linkage — see the truth table there): signed out, or signed in with a
      // local-only workspace, the doc is non-remote and the panels show the
      // local empty state; only a server-linked workspace (daemon or legacy
      // path) is collab-capable.
      const syncing = !!workspaces.identity && (daemonRunning || workspaces.activeLinked);
      docCollab.set({
        ...docContext(path, workspace.root, syncing),
        server: workspaces.activeServer,
      });
      readNote(path)
        .then((text) => {
          // Guard: only apply if this tab is still active and not destroyed.
          if (tabs.activeId !== id) return;
          editorState.currentText = text;
        })
        .catch(() => {});
      return;
    }
    // Edit mode from here on: the effect re-runs once bind:this delivers the
    // freshly rendered CodeMirror host.
    if (!host) return;
    // Tier-2 (Plan 3): when the daemon owns this workspace, attach the open editor to its
    // replica over IPC for live cursors. Legacy per-note websocket sync only when the daemon
    // is NOT running (local-server dev mode). `daemonRunning` is the value-stable $derived
    // above — NOT a direct `daemon.status` read — so the poll never remounts the editor
    // (workspaces.activeLinked is a store-level $derived boolean, stable the same way).
    //
    // Sync gate truth table — identity AND workspace linkage, never a user toggle:
    //   signed out                        → local-only (identity null; the daemon
    //                                       can't run either — it needs a token)
    //   signed in + local-only workspace  → local-only: a local vault must never
    //                                       ride the legacy path — its rooms are
    //                                       keyed only by deriveSlug(relPath), so
    //                                       they collide across vaults, and a
    //                                       non-empty room would replace on-disk
    //                                       content (seedFromDiskIfNeeded seeds
    //                                       only empty rooms) which the
    //                                       mirror-to-disk saver then writes back
    //   signed in + linked, daemon up     → Tier-2 IPC sync via the daemon
    //   signed in + linked, daemon down   → legacy per-note websocket
    //                                       (local-server dev mode)
    const useTauriSync = daemonRunning; // synced workspace is open
    const useWsSync = !daemonRunning && !!workspaces.identity && workspaces.activeLinked;

    // Publish the open doc's collab context for the RightSidebar panels. A doc
    // is "remote" (collab-capable) only when it syncs through a server-linked
    // workspace AND a server token exists — the exact gate above, so isRemote,
    // the comment affordance, Suggest mode and wireCollab can never disagree
    // with the sync path chosen. Local-only vault files stay non-remote →
    // panels show the empty state.
    const syncing = (useTauriSync || useWsSync) && !!workspaces.identity;
    docCollab.set({
      ...docContext(path, workspace.root, syncing),
      server: workspaces.activeServer,
    });

    let view: EditorView | null = null;
    let session: Session | null = null;
    let destroyed = false;
    // Collaboration store (comments/suggestions/history) for synced docs. Created
    // once the editor view + Yjs doc exist; attached to the view so decorations
    // and selection-anchored mutations resolve; polls the server for threads.
    let stopCollab: (() => void) | null = null;
    const { slug: collabSlug, isRemote: collabRemote } = docContext(path, workspace.root, syncing);
    function wireCollab(ydoc: Y.Doc, editorView: EditorView): void {
      if (!collabRemote || !collabSlug) return;
      const api = createCollabApi({ server: workspaces.activeServer, docSlug: collabSlug });
      const store = new CollabStore(api, ydoc);
      store.view = editorView;
      docCollab.store = store;
      stopCollab = store.start();
      // Render any anchors whose data arrived before the editor mounted
      // (mirrors the web editor's collab.syncDecorations() mount call).
      store.syncDecorations();
    }
    // Autosave is GATED on `ready`: never write disk before the seed/sync
    // decision is made, so a transient-empty Y.Doc can't clobber the file.
    let ready = false;
    let seedTimer: ReturnType<typeof setTimeout> | null = null;
    // Captured so the cleanup return can remove the listener and reset the count.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let awarenessRef: { on: any; off: any; getStates: any } | null = null;
    let awarenessHandler: (() => void) | null = null;

    const saver = makeDebouncedSaver(async (text: string) => {
      await writeNote(path, text);
      const current = tabs.active();
      if (current && current.id === id) {
        tabs.setDirty(id, false);
      }
    }, 500);

    // Register flush so tab close saves immediately; returns the write promise so
    // tabs.flush(id) callers (rename/move) can await the disk write before touching
    // the file.
    tabs.registerFlush(id, () => saver.flush().catch(() => {}));

    if (useTauriSync || useWsSync) {
      // ── Sync-aware open flow ───────────────────────────────────────────────
      // Build the identity for presence/cursors using the Plan-1 /api/me identity.
      // The stable user id (server UUID) is the dedup key AND the color seed, so the
      // same person collapses to one indicator — same color — across web + desktop.
      // Email is only a fallback if id is somehow absent; avatar_url rides along so
      // other clients render the photo. A local-only note has no auth → userId null
      // (a distinct guest).
      const identityInfo = workspaces.identity;
      const userId = identityInfo?.id ?? identityInfo?.email ?? null;
      const { color, colorLight } = userId
        ? colorFromId(userId)
        : { color: "#a882ff", colorLight: "#a882ff33" };
      const presenceIdentity = {
        userId,
        name: identityInfo?.display_name ?? identityInfo?.email ?? "You",
        color,
        colorLight,
        avatar: identityInfo?.avatar_url ?? null,
        kind: "human" as const,
      };

      if (useTauriSync) {
        // Tier-2: attach to the daemon's CRDT replica via Tauri IPC.
        // The daemon's reconcile() is the duplication-safe disk-seed authority: it seeds
        // disk→replica only when the server room is empty, after learning server state.
        // The editor must NOT seed from disk while the bridge can still deliver a
        // snapshot — if it seeded in the narrow window after clone/daemon-start but
        // before the daemon's first server sync (replica still empty), the same text
        // would land twice as CRDT-distinct ops and merge into duplicated content.
        // The seed fallback below therefore SEVERS the transport first; the prefetch
        // just has the disk text ready so the fallback applies with no extra wait.
        const diskPrefetch: Promise<string | null> = readNote(path).catch(() => null);
        // createTauriSession is async; capture session once resolved.
        createTauriSession({ path, identity: presenceIdentity })
          .then((sess) => {
            if (destroyed) {
              sess.destroy();
              return;
            }
            session = sess;

            // Update the grouped presence roster whenever awareness changes (self
            // excluded by selfKey); set once immediately.
            const selfKey = userId ?? `guest:${sess.awareness.clientID}`;
            awarenessRef = sess.awareness;
            awarenessHandler = () => {
              presence.update(sess.awareness.getStates(), selfKey);
            };
            sess.awareness.on("change", awarenessHandler);
            awarenessHandler();

            syncStatus.set("connecting");
            sess.onStatus((s) => {
              if (destroyed) return;
              if (tabs.activeId !== id) return;
              syncStatus.set(s);
            });

            if (destroyed || tabs.activeId !== id || !host) return;

            const undoManager = new Y.UndoManager(sess.ytext);
            view = createEditor({
              parent: host,
              doc: sess.ytext.toString(),
              collab: yCollab(sess.ytext, sess.awareness, { undoManager }),
              annotations: collabAnnotations,
              onUpdate: onCollabUpdate,
              onChange: () => {
                if (!ready) return;
                const text = sess.ytext.toString();
                editorState.currentText = text;
                tabs.setDirty(id, true);
                saver.schedule(text);
              },
              onSelection: () => {
                editorState.selectionEpoch++;
              },
            });
            editorState.activeView = view;
            if (sess.ytext.doc) wireCollab(sess.ytext.doc, view);

            const markReady = () => {
              ready = true;
              editorState.currentText = sess.ytext.toString();
            };

            sess.onSynced(() => {
              if (destroyed || tabs.activeId !== id) return;
              if (seedTimer !== null) {
                clearTimeout(seedTimer);
                seedTimer = null;
              }
              markReady();
            });

            // A dark bridge must NOT leave the empty CRDT as the autosave source:
            // marking it ready blank is exactly how a healthy on-disk file got
            // clobbered with "" after a tab switch. Sever the transport first (after
            // this no late snapshot can merge a duplicate copy), then seed the editor
            // from the file on disk and go local-only. Tier-1 keeps syncing the file
            // through the daemon's watcher; live collab returns the next time the
            // note is opened with the bridge reachable.
            const seedFromDiskLocalOnly = () => {
              if (destroyed || ready) return;
              sess.sever?.();
              // The pane is deliberately local-only now — don't leave the StatusBar
              // stuck on the "connecting" set at attach time.
              if (tabs.activeId === id) syncStatus.set(null);
              void diskPrefetch
                // Prefetch failed (transient read error) → one direct retry before
                // concluding the file is truly unreadable; only then may an empty
                // doc become the autosave source.
                .then((text) => text ?? readNote(path).catch(() => null))
                .then((text) => {
                  if (destroyed || ready) return;
                  if (text !== null && sess.ytext.length === 0 && text.length > 0) {
                    sess.ytext.insert(0, text);
                  }
                  markReady();
                });
            };

            if (sess.live === false) {
              // The daemon answered at attach time: no snapshot is coming (no linked
              // session, or it has never synced this run). Seed from disk NOW — the
              // fallback timer would only prolong a blank pane.
              seedFromDiskLocalOnly();
            } else {
              // Bridge reported live (or the report timed out): a snapshot arrives
              // over IPC within milliseconds; the timer is the safety net.
              seedTimer = setTimeout(() => {
                seedTimer = null;
                seedFromDiskLocalOnly();
              }, SEED_FALLBACK_MS);
            }
          })
          .catch(() => {
            // attachEditor failed (daemon stopped between decision and call) — fall
            // back gracefully: mark ready so the file stays editable. No collab
            // store can come from this mount: release anything waiting on one
            // (ModeGroup's pending Suggesting intent expires on this signal).
            // A superseded mount's late rejection must NOT emit the signal — the
            // intent may be waiting on a newer, still-healthy mount.
            ready = true;
            if (!destroyed) docCollab.markWireFailed();
          });
      } else {
        // Legacy websocket path (daemon not running, signed in).
        const slug = deriveSlug(relativeToWorkspace(path));
        session = createSession({ slug, wsBase: settings.wsBase, identity: presenceIdentity });
        const sess = session;

        // Update the grouped presence roster whenever awareness changes (self
        // excluded by selfKey); set once immediately.
        const selfKey = userId ?? `guest:${sess.awareness.clientID}`;
        awarenessRef = sess.awareness;
        awarenessHandler = () => {
          presence.update(sess.awareness.getStates(), selfKey);
        };
        sess.awareness.on("change", awarenessHandler);
        awarenessHandler();

        // Surface connection status to the StatusBar.
        syncStatus.set("connecting");
        sess.onStatus((s) => {
          if (destroyed) return;
          if (tabs.activeId !== id) return;
          syncStatus.set(s);
        });

        readNote(path)
          .then((disk) => {
            if (destroyed || tabs.activeId !== id || !host) return;

            const undoManager = new Y.UndoManager(sess.ytext);
            view = createEditor({
              parent: host,
              doc: sess.ytext.toString(),
              collab: yCollab(sess.ytext, sess.awareness, { undoManager }),
              annotations: collabAnnotations,
              onUpdate: onCollabUpdate,
              onChange: () => {
                // yCollab drives the doc; mirror ytext to disk once seeded.
                if (!ready) return;
                const text = sess.ytext.toString();
                editorState.currentText = text;
                tabs.setDirty(id, true);
                saver.schedule(text);
              },
              onSelection: () => {
                editorState.selectionEpoch++;
              },
            });
            editorState.activeView = view;
            if (sess.ytext.doc) wireCollab(sess.ytext.doc, view);

            const markReady = () => {
              ready = true;
              // Set initial text
              editorState.currentText = sess.ytext.toString();
            };

            // Seed an empty room from disk so existing files aren't lost; if both
            // are non-empty the room content already populated the editor.
            const seedFromDiskIfNeeded = () => {
              if (sess.ytext.length === 0 && disk.length > 0) {
                sess.ytext.insert(0, disk);
              }
            };

            sess.onSynced(() => {
              if (destroyed || tabs.activeId !== id) return;
              if (seedTimer !== null) {
                clearTimeout(seedTimer);
                seedTimer = null;
              }
              seedFromDiskIfNeeded();
              markReady();
            });

            // Fallback: server offline/unreachable — show the file and allow
            // editing without waiting forever for a 'synced' that won't come.
            seedTimer = setTimeout(() => {
              seedTimer = null;
              if (destroyed) return;
              seedFromDiskIfNeeded();
              markReady();
            }, SEED_FALLBACK_MS);
          })
          .catch(() => {
            // Disk read failed: still let the user edit the (possibly remote)
            // doc. No collab store can come from this mount: release anything
            // waiting on one (ModeGroup's pending Suggesting intent expires on
            // this signal). A superseded mount's late rejection must NOT emit
            // the signal — the intent may be waiting on a newer, healthy mount.
            ready = true;
            if (!destroyed) docCollab.markWireFailed();
          });
      }
    } else {
      // ── Local-only path ───────────────────────────────────────────────────
      syncStatus.set(null);
      presence.reset();
      readNote(path).then((doc) => {
        if (destroyed) return;
        if (tabs.activeId !== id) return;
        if (!host) return;

        ready = true;
        editorState.currentText = doc;
        view = createEditor({
          parent: host,
          doc,
          onChange: (text) => {
            editorState.currentText = text;
            tabs.setDirty(id, true);
            saver.schedule(text);
          },
          onSelection: () => {
            editorState.selectionEpoch++;
          },
        });
        editorState.activeView = view;
      });
    }

    // Cleanup: flush, destroy the view + session, clear timers
    return () => {
      destroyed = true;
      tabs.unregisterFlush(id);
      if (seedTimer !== null) {
        clearTimeout(seedTimer);
        seedTimer = null;
      }
      // Remove the awareness listener before destroying the session.
      if (awarenessRef && awarenessHandler) {
        awarenessRef.off("change", awarenessHandler);
        awarenessRef = null;
        awarenessHandler = null;
      }
      presence.reset();
      if (stopCollab) {
        stopCollab();
        stopCollab = null;
      }
      docCollab.reset();
      // Flush pending save before tearing the session down — but only while a tab still
      // exists under this id. After a rename/move retarget the id is gone, and a flush
      // here would write to the OLD path, recreating the just-renamed file — so that
      // path CANCELS instead: skipping alone would leave the debounce timer armed, and
      // its late write (re-armed by any change, including remote collab updates) would
      // resurrect the old file anyway. (Tab close is covered: closeTab invokes the
      // registered flush before removing the tab.)
      if (tabs.tabs.some((t) => t.id === id)) {
        saver.flush().catch(() => {});
      } else {
        saver.cancel();
      }
      if (view) {
        view.destroy();
        view = null;
        editorState.activeView = null;
      }
      if (session) {
        session.destroy();
        session = null;
      }
      // Clear status only if no other note has taken over.
      if (tabs.activeId === null || tabs.activeId === id) {
        syncStatus.set(null);
      }
    };
  });
</script>

<!-- Close the open composer on any outside click. -->
<svelte:window onpointerdown={onWindowPointerDown} />

<div class="flex-1 flex flex-col min-h-0 overflow-hidden relative">
  {#if tabs.activeId}
    <!-- The toolbar renders in BOTH modes: its mode group is the way back out
         of reading view (where the editing cluster hides itself — the editor
         view it targets does not exist there). Presence chips render inside
         the toolbar row too, so nothing can overlay the row's controls. -->
    <Toolbar />

    {#if isReadMode}
      <ReadingView />
    {:else}
      <!--
        Positioned wrapper: the floating comment/suggest affordance is absolutely
        placed against this box, while CodeMirror mounts into the inner host.
      -->
      <div bind:this={wrap} class="relative flex-1 min-h-0">
        <!--
          CodeMirror mounts directly into this div.
          height: 100% propagates through so CM fills the pane.
        -->
        <div bind:this={host} class="cm-host h-full" style="overflow: auto;"></div>

        <!-- Floating selection affordance + composer (synced docs only) -->
        {#if affordance && showAffordance}
          <div
            class="absolute z-20"
            style:left="{affordance.x}px"
            style:top="{affordance.y}px"
            bind:this={composerEl}
          >
            {#if !composerOpen}
              <button
                class="btn btn-sm gap-1.5 shadow-lg active:scale-[0.96] transition-transform"
                style="min-height: 40px; min-width: 40px;"
                onclick={openComposer}
                title={suggestMode
                  ? "Suggest an edit to the selection"
                  : "Comment on the selection"}
              >
                <MessageSquarePlus class="h-4 w-4" aria-hidden="true" />
                {suggestMode ? "Suggest" : "Comment"}
              </button>
            {:else if suggestMode}
              <div class="w-72 rounded-box border border-base-300 bg-base-100 p-3 shadow-lg">
                <select class="select select-xs mb-2 w-full" bind:value={suggestAction}>
                  <option value="replace">Replace selection</option>
                  <option value="insert-after">Insert after selection</option>
                  <option value="delete">Delete selection</option>
                </select>
                {#if suggestAction !== "delete"}
                  <textarea
                    class="textarea textarea-sm w-full font-mono text-xs"
                    rows="2"
                    placeholder={suggestAction === "replace"
                      ? "Replacement text"
                      : "Text to insert"}
                    bind:value={composerText}
                    onkeydown={(e) => {
                      if (e.key === "Escape") closeComposer();
                    }}></textarea>
                {/if}
                <div class="mt-2 flex justify-end gap-1">
                  <button
                    class="btn btn-ghost btn-xs active:scale-[0.96] transition-transform"
                    onclick={closeComposer}>Cancel</button
                  >
                  <button
                    class="btn btn-primary btn-xs active:scale-[0.96] transition-transform"
                    onclick={addSuggestDraft}
                  >
                    Add to suggestion
                  </button>
                </div>
              </div>
            {:else}
              <div class="w-72 rounded-box border border-base-300 bg-base-100 p-3 shadow-lg">
                <textarea
                  class="textarea textarea-sm w-full"
                  rows="2"
                  placeholder="Add a comment… (@ to mention)"
                  bind:value={composerText}
                  use:mentionAutocomplete={{ members: collabStore?.members ?? [] }}
                  onkeydown={(e) => {
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submitComment();
                    if (e.key === "Escape") closeComposer();
                  }}></textarea>
                <div class="mt-2 flex justify-end gap-1">
                  <button
                    class="btn btn-ghost btn-xs active:scale-[0.96] transition-transform"
                    onclick={closeComposer}>Cancel</button
                  >
                  <button
                    class="btn btn-primary btn-xs active:scale-[0.96] transition-transform"
                    disabled={!composerText.trim()}
                    onclick={submitComment}
                  >
                    Comment
                  </button>
                </div>
              </div>
            {/if}
          </div>
        {/if}

        <!-- Suggest-mode badge (mirrors the web editor) -->
        {#if suggestMode}
          <div class="absolute right-3 top-2 z-10">
            <span
              class="badge badge-warning badge-sm"
              title="You're in suggest mode — edits are queued as suggestions."
            >
              Suggesting
            </span>
          </div>
        {/if}
      </div>
    {/if}
  {:else}
    <div class="flex-1 flex items-center justify-center text-base-content/30 text-sm">
      Open a note from the sidebar to start editing
    </div>
  {/if}

  <!-- History time-travel overlay: read-only, never mutates the live doc. -->
  {#if snapshot && docCollab.store}
    <div class="absolute inset-0 z-20 flex flex-col bg-base-100">
      <SnapshotView
        text={snapshot.text}
        entry={snapshot.entry}
        onClose={() => docCollab.store?.closeSnapshot()}
      />
    </div>
  {/if}
</div>
