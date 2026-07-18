// EditorPane — the live editor host. Port of src/lib/EditorPane.svelte; the
// mount-choreography comments there are the spec and are carried over where
// they explain an ordering constraint.
//
// REMOUNT SAFETY (the vault-doubling bug class): the mount effect below depends
// ONLY on value-stable primitives (activeId/activePath/activeMode/daemonRunning/
// activeLinked/identityKey). Everything else — tabs, daemon status objects,
// workspace root, server, wsBase — is read via store.getState() INSIDE the
// effect, so a keystroke (tabs.setDirty reassigns the tabs array) or the
// daemon's status poll (fresh status object) can never re-run the effect and
// remount CodeMirror or re-run the disk seed.
import { useCallback, useEffect, useRef, useState } from "react";
import type { EditorView } from "@codemirror/view";
import type { ViewUpdate } from "@codemirror/view";
import * as Y from "yjs";
import { yCollab } from "y-codemirror.next";
import { MessageSquarePlus } from "lucide-react";

import { tabsStore, useTabs } from "@/state/tabs";
import { editorStateStore } from "@/state/editorState";
import { settingsStore } from "@/state/settings";
import { useDaemon } from "@/state/daemon";
import { workspaceStore } from "@/state/workspace";
import { syncStatusStore } from "@/state/syncStatus";
import { presenceStore } from "@/state/presence";
import { docCollabStore, useDocCollab } from "@/state/docCollab";
// Sibling modules still being built by the state agent — import by contract.
import { workspacesStore, useWorkspaces, type WorkspacesState } from "@/state/workspaces";
import { CollabStore, useCollabSnapshot } from "@/state/collabStore";
import { useMentionAutocomplete } from "@/state/mentionAutocomplete";

import { readNote, writeNote } from "@/services/tauri";
import { createEditor } from "@/services/editor/createEditor";
import { makeDebouncedSaver } from "@/services/editor/save";
import { deriveSlug } from "@/services/sync/slug";
import { createSession, type Session } from "@/services/sync/session";
import { createTauriSession } from "@/services/sync/tauri-provider";
import { colorFromId } from "@/services/presence";
import { docContext } from "@/services/collab/docContext";
import { createCollabApi } from "@/services/collab/collabApi";
import { collabDecorations, commentClickHandler } from "@muesli/editor-core/annotations";
import { collabTheme } from "@muesli/editor-core/annotationsTheme";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import Toolbar from "./Toolbar";
import ReadingView from "./ReadingView";
import SnapshotView from "./SnapshotView";

// Collab decoration extensions (comment/suggestion highlights + comment-click
// routing). The click handler resolves the live store at click time via
// docCollabStore — the store is created in wireCollab AFTER the view, so we
// can't close over it at editor-construction time.
//
// collabTheme is the baseTheme for these highlights: the shared editor-core
// decorations no longer bundle it, so the desktop app opts in explicitly here
// to keep its prior styling.
const collabAnnotations = [
  collabDecorations,
  collabTheme,
  commentClickHandler((threadId: string) =>
    docCollabStore.getState().store?.revealThread(threadId),
  ),
];

// If sync is unreachable, seed the editor from disk after this long so the
// file's content always shows and never gets clobbered by an empty Y.Doc.
// The window can be short: a live daemon bridge answers from its in-memory
// replica over IPC in milliseconds (even while the server socket is down),
// so waiting longer only prolongs the blank pane in the genuinely-dead cases.
const SEED_FALLBACK_MS = 600;

type SuggestAction = "replace" | "insert-after" | "delete";

export default function EditorPane() {
  // ── Value-stable primitives ────────────────────────────────────────────────
  // The mount effect below depends ONLY on these, so it re-runs only on a REAL
  // tab switch / path / mode change — never on a keystroke. (Typing calls
  // tabs.setDirty, which replaces the tabs array; selecting the whole tab
  // object would change identity every keystroke and remount the editor + sync
  // session. These primitive selections stay `Object.is`-equal, so zustand
  // does not re-render and the effect keeps its deps.)
  const activeId = useTabs((s) => s.activeId);
  const activePath = useTabs((s) => s.active()?.path ?? null);
  const activeMode = useTabs((s) => s.active()?.mode ?? "edit");
  // Same rationale for the daemon's running flag: selecting the boolean means
  // a status-object refresh only propagates when the VALUE flips, so the
  // effect re-runs on a real start/stop, never on poll churn.
  const daemonRunning = useDaemon((s) => !!s.status?.running);
  const activeLinked = useWorkspaces((s: WorkspacesState) => !!s.activeLinked);
  // Identity as a primitive key: login/logout re-runs the mount (the sync gate
  // changes), but a refreshed identity object with the same id does not.
  const identityKey = useWorkspaces(
    (s: WorkspacesState) => s.identity?.id ?? s.identity?.email ?? null,
  );

  const isReadMode = activeMode === "read";

  // ── Comment / suggest affordance ───────────────────────────────────────────
  // Floating button over the active selection ("Comment", or "Suggest" in
  // suggest mode) that opens a small composer. Gated on isRemote (a comment
  // can't be created on a local-only vault file).
  const [affordance, setAffordance] = useState<{ x: number; y: number } | null>(null);
  const [composerOpen, setComposerOpen] = useState(false);
  const [composerText, setComposerText] = useState("");
  const [suggestAction, setSuggestAction] = useState<SuggestAction>("replace");
  const composerElRef = useRef<HTMLDivElement | null>(null);
  // Mirror for CodeMirror callbacks (created once at mount; reading React
  // state there would be a stale closure).
  const composerOpenRef = useRef(false);
  // The positioned wrapper the floating affordance is measured against.
  const wrapRef = useRef<HTMLDivElement | null>(null);
  // The DOM node we mount CodeMirror into.
  const hostRef = useRef<HTMLDivElement | null>(null);
  const commentTextareaRef = useRef<HTMLTextAreaElement | null>(null);

  const collabStore = useDocCollab((s) => s.store);
  const isRemote = useDocCollab((s) => s.isRemote);
  // Subscribe to the collab store's reactive fields (suggestMode, selection,
  // availability, snapshot, composerRequest, members). Tolerates null.
  useCollabSnapshot(collabStore);
  const suggestMode: boolean = collabStore?.suggestMode ?? false;
  const hasSelection =
    !!collabStore && collabStore.selection.from !== collabStore.selection.to;
  // Only offer the affordance on synced docs whose collab store is live and
  // reachable (not auth-degraded / volatile).
  const showAffordance =
    isRemote &&
    !!collabStore &&
    hasSelection &&
    collabStore.availability !== "volatile" &&
    collabStore.availability !== "auth";

  // Read-only history snapshot, when a HistoryPanel entry is open. Rendered as
  // an overlay so the live editor underneath is never torn down or mutated.
  const snapshot = collabStore?.snapshot ?? null;
  const composerRequest: number = collabStore?.composerRequest ?? 0;

  const positionAffordance = useCallback((v: EditorView): void => {
    const wrap = wrapRef.current;
    const sel = v.state.selection.main;
    if (sel.empty || !wrap) {
      setAffordance(null);
      setComposerOpen(false);
      composerOpenRef.current = false;
      return;
    }
    const coords = v.coordsAtPos(sel.head);
    if (!coords) {
      setAffordance(null);
      return;
    }
    const rect = wrap.getBoundingClientRect();
    setAffordance({
      x: Math.max(8, Math.min(coords.left - rect.left, rect.width - 300)),
      y: Math.min(coords.bottom - rect.top + 6, rect.height - 44),
    });
  }, []);

  const openComposer = useCallback((): void => {
    setComposerOpen(true);
    composerOpenRef.current = true;
    setComposerText("");
    setSuggestAction("replace");
  }, []);

  const closeComposer = useCallback((): void => {
    setComposerOpen(false);
    composerOpenRef.current = false;
    setComposerText("");
  }, []);

  // Focus the freshly rendered composer textarea (the Svelte `await tick()`).
  useEffect(() => {
    if (composerOpen) {
      composerElRef.current?.querySelector("textarea")?.focus();
    }
  }, [composerOpen, suggestAction]);

  async function submitComment(): Promise<void> {
    const store = docCollabStore.getState().store;
    const body = composerText.trim();
    if (!store || !body) return;
    if (await store.addComment(body)) {
      closeComposer();
      store.sidebarOpen = true;
      store.tab = "comments";
    }
  }

  function addSuggestDraft(): void {
    const store = docCollabStore.getState().store;
    if (!store) return;
    if (suggestAction !== "delete" && !composerText) return;
    store.addDraft(suggestAction, composerText);
    closeComposer();
    store.sidebarOpen = true;
    store.tab = "suggestions";
  }

  // Close the composer on an outside click (the affordance lives inside wrap).
  useEffect(() => {
    if (!composerOpen) return;
    const onWindowPointerDown = (e: PointerEvent): void => {
      const el = composerElRef.current;
      if (el && !el.contains(e.target as Node)) closeComposer();
    };
    window.addEventListener("pointerdown", onWindowPointerDown);
    return () => window.removeEventListener("pointerdown", onWindowPointerDown);
  }, [composerOpen, closeComposer]);

  // The toolbar's comment button funnels through the same composer the
  // selection affordance opens (collabStore.requestComposer bumps the counter).
  const seenComposerRequestRef = useRef(0);
  useEffect(() => {
    if (!collabStore) return;
    if (composerRequest > seenComposerRequestRef.current) {
      seenComposerRequestRef.current = composerRequest;
      const v = editorStateStore.getState().activeView;
      if (v && showAffordance) {
        positionAffordance(v);
        openComposer();
      }
    }
  }, [collabStore, composerRequest, showAffordance, positionAffordance, openComposer]);

  // Mention autocomplete for the comment composer textarea (imperative DOM
  // dropdown, ported from the Svelte action).
  useMentionAutocomplete(commentTextareaRef, { members: collabStore?.members ?? [] });

  // Feed the open doc's collab store from editor transactions: keep its UTF-16
  // selection fresh (so addComment/addDraft anchor to the live selection) and
  // remap queued suggestion drafts through local edits. Also repositions the
  // floating affordance. Stable identity (refs + getState only) — safe to call
  // from the CM updateListener created in the mount effect.
  const onCollabUpdate = useCallback(
    (update: ViewUpdate): void => {
      const store = docCollabStore.getState().store;
      if (store) {
        if (update.docChanged) store.mapDraftsThroughChanges(update.changes);
        if (update.selectionSet || update.docChanged) {
          const sel = update.state.selection.main;
          store.selection = { from: sel.from, to: sel.to };
        }
      }
      if (update.selectionSet || update.docChanged) {
        if (!composerOpenRef.current) positionAffordance(update.view);
      }
    },
    [positionAffordance],
  );
  const onCollabUpdateRef = useRef(onCollabUpdate);
  onCollabUpdateRef.current = onCollabUpdate;

  // ── The mount effect ───────────────────────────────────────────────────────
  useEffect(() => {
    const id = activeId;
    const path = activePath;
    const mode = activeMode;
    if (!id || !path) return;

    const tabs = tabsStore.getState();
    const editorState = editorStateStore.getState();
    const workspaces = workspacesStore.getState() as WorkspacesState;
    const syncStatus = syncStatusStore.getState();
    const presence = presenceStore.getState();
    const docCollab = docCollabStore.getState();

    function relativeToWorkspace(p: string): string {
      const root = workspaceStore.getState().root;
      if (root && p.startsWith(root + "/")) return p.slice(root.length + 1);
      // Fallback: just the basename (no workspace root known).
      return p.split("/").at(-1) ?? p;
    }

    // Don't mount the editor in read mode — but DO refresh the shared text so
    // ReadingView shows the correct content for this tab, and keep the collab
    // context current so the panels stay correct in read mode. Same sync gate
    // as the edit-mode mount below (identity AND workspace linkage).
    if (mode === "read") {
      editorState.setActiveView(null);
      const syncing = !!workspaces.identity && (daemonRunning || workspaces.activeLinked);
      docCollab.set({
        ...docContext(path, workspaceStore.getState().root, syncing),
        server: workspaces.activeServer,
      });
      readNote(path)
        .then((text) => {
          // Guard: only apply if this tab is still active.
          if (tabsStore.getState().activeId !== id) return;
          editorStateStore.getState().setCurrentText(text);
        })
        .catch(() => {});
      return;
    }

    // Edit mode from here on. In React the host div is committed before this
    // effect runs (it renders whenever an edit-mode tab is active), so unlike
    // the Svelte bind:this dance no re-run-on-bind is needed.
    const host = hostRef.current;
    if (!host) return;

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
    const useTauriSync = daemonRunning;
    const useWsSync = !daemonRunning && !!workspaces.identity && workspaces.activeLinked;

    // Publish the open doc's collab context for the sidebar panels. A doc is
    // "remote" (collab-capable) only when it syncs through a server-linked
    // workspace AND a server token exists — the exact gate above, so isRemote,
    // the comment affordance, Suggest mode and wireCollab can never disagree
    // with the sync path chosen.
    const syncing = (useTauriSync || useWsSync) && !!workspaces.identity;
    docCollab.set({
      ...docContext(path, workspaceStore.getState().root, syncing),
      server: workspaces.activeServer,
    });

    let view: EditorView | null = null;
    let session: Session | null = null;
    let destroyed = false;
    // Collaboration store (comments/suggestions/history) for synced docs.
    let stopCollab: (() => void) | null = null;
    const { slug: collabSlug, isRemote: collabRemote } = docContext(
      path,
      workspaceStore.getState().root,
      syncing,
    );
    function wireCollab(ydoc: Y.Doc, editorView: EditorView): void {
      if (!collabRemote || !collabSlug) return;
      const api = createCollabApi({ server: workspaces.activeServer, docSlug: collabSlug });
      const store = new CollabStore(api, ydoc);
      store.view = editorView;
      docCollabStore.getState().setStore(store);
      stopCollab = store.start();
      // Render any anchors whose data arrived before the editor mounted.
      store.syncDecorations();
    }
    // Autosave is GATED on `ready`: never write disk before the seed/sync
    // decision is made, so a transient-empty Y.Doc can't clobber the file.
    let ready = false;
    let seedTimer: ReturnType<typeof setTimeout> | null = null;
    // Captured so the cleanup return can remove the listener.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let awarenessRef: { on: any; off: any; getStates: any } | null = null;
    let awarenessHandler: (() => void) | null = null;

    const saver = makeDebouncedSaver(async (text: string) => {
      await writeNote(path, text);
      const current = tabsStore.getState().active();
      if (current && current.id === id) {
        tabsStore.getState().setDirty(id, false);
      }
    }, 500);

    // Register flush so tab close saves immediately; returns the write promise
    // so tabs.flush(id) callers (rename/move) can await the disk write.
    tabs.registerFlush(id, () => saver.flush().catch(() => {}));

    if (useTauriSync || useWsSync) {
      // ── Sync-aware open flow ─────────────────────────────────────────────
      // Presence identity: the stable user id (server UUID) is the dedup key
      // AND the color seed, so the same person collapses to one indicator —
      // same color — across web + desktop.
      const identityInfo = workspaces.identity;
      const userId: string | null = identityInfo?.id ?? identityInfo?.email ?? null;
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
        // The daemon's reconcile() is the duplication-safe disk-seed authority:
        // it seeds disk→replica only when the server room is empty, after
        // learning server state. The editor must NOT seed from disk while the
        // bridge can still deliver a snapshot — if it seeded in the narrow
        // window after clone/daemon-start but before the daemon's first server
        // sync (replica still empty), the same text would land twice as
        // CRDT-distinct ops and merge into duplicated content. The seed
        // fallback below therefore SEVERS the transport first; the prefetch
        // just has the disk text ready so the fallback applies with no wait.
        const diskPrefetch: Promise<string | null> = readNote(path).catch(() => null);
        // createTauriSession is async; capture session once resolved. A
        // superseded resolution (this effect already cleaned up — including a
        // hypothetical double-invoke) destroys itself: attach/detach stay
        // paired and no second live session can exist for this mount.
        createTauriSession({ path, identity: presenceIdentity })
          .then((sess: Session) => {
            if (destroyed) {
              sess.destroy();
              return;
            }
            session = sess;

            // Update the grouped presence roster whenever awareness changes
            // (self excluded by selfKey); set once immediately.
            const selfKey = userId ?? `guest:${(sess.awareness as { clientID: number }).clientID}`;
            awarenessRef = sess.awareness;
            awarenessHandler = () => {
              presenceStore.getState().update(sess.awareness.getStates(), selfKey);
            };
            sess.awareness.on("change", awarenessHandler);
            awarenessHandler();

            syncStatus.set("connecting");
            sess.onStatus((s) => {
              if (destroyed) return;
              if (tabsStore.getState().activeId !== id) return;
              syncStatusStore.getState().set(s);
            });

            if (destroyed || tabsStore.getState().activeId !== id || !hostRef.current) return;

            const undoManager = new Y.UndoManager(sess.ytext);
            view = createEditor({
              parent: hostRef.current,
              doc: sess.ytext.toString(),
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              collab: yCollab(sess.ytext, sess.awareness as any, { undoManager }),
              annotations: collabAnnotations,
              onUpdate: (u) => onCollabUpdateRef.current(u),
              onChange: () => {
                if (!ready) return;
                const text = sess.ytext.toString();
                editorStateStore.getState().setCurrentText(text);
                tabsStore.getState().setDirty(id, true);
                saver.schedule(text);
              },
              onSelection: () => {
                editorStateStore.getState().bumpSelectionEpoch();
              },
            });
            editorState.setActiveView(view);
            if (sess.ytext.doc) wireCollab(sess.ytext.doc, view);

            const markReady = () => {
              ready = true;
              editorStateStore.getState().setCurrentText(sess.ytext.toString());
            };

            sess.onSynced(() => {
              if (destroyed || tabsStore.getState().activeId !== id) return;
              if (seedTimer !== null) {
                clearTimeout(seedTimer);
                seedTimer = null;
              }
              markReady();
            });

            // A dark bridge must NOT leave the empty CRDT as the autosave
            // source: marking it ready blank is exactly how a healthy on-disk
            // file got clobbered with "" after a tab switch. Sever the
            // transport first (after this no late snapshot can merge a
            // duplicate copy), then seed the editor from the file on disk and
            // go local-only. Tier-1 keeps syncing the file through the
            // daemon's watcher; live collab returns the next time the note is
            // opened with the bridge reachable.
            const seedFromDiskLocalOnly = () => {
              if (destroyed || ready) return;
              sess.sever?.();
              // The pane is deliberately local-only now — don't leave the
              // status stuck on the "connecting" set at attach time.
              if (tabsStore.getState().activeId === id) syncStatusStore.getState().set(null);
              void diskPrefetch
                // Prefetch failed (transient read error) → one direct retry
                // before concluding the file is truly unreadable; only then
                // may an empty doc become the autosave source.
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
              // The daemon answered at attach time: no snapshot is coming.
              // Seed from disk NOW — the fallback timer would only prolong a
              // blank pane.
              seedFromDiskLocalOnly();
            } else {
              // Bridge reported live (or the report timed out): a snapshot
              // arrives over IPC within milliseconds; the timer is the net.
              seedTimer = setTimeout(() => {
                seedTimer = null;
                seedFromDiskLocalOnly();
              }, SEED_FALLBACK_MS);
            }
          })
          .catch(() => {
            // attachEditor failed (daemon stopped between decision and call) —
            // fall back gracefully: mark ready so the file stays editable. No
            // collab store can come from this mount: release anything waiting
            // on one (ModeGroup's pending Suggesting intent expires on this
            // signal). A superseded mount's late rejection must NOT emit the
            // signal — the intent may be waiting on a newer, healthy mount.
            ready = true;
            if (!destroyed) docCollabStore.getState().markWireFailed();
          });
      } else {
        // Legacy websocket path (daemon not running, signed in).
        const slug = deriveSlug(relativeToWorkspace(path));
        session = createSession({
          slug,
          wsBase: settingsStore.getState().wsBase,
          identity: presenceIdentity,
        });
        const sess = session;

        const selfKey = userId ?? `guest:${(sess.awareness as { clientID: number }).clientID}`;
        awarenessRef = sess.awareness;
        awarenessHandler = () => {
          presenceStore.getState().update(sess.awareness.getStates(), selfKey);
        };
        sess.awareness.on("change", awarenessHandler);
        awarenessHandler();

        syncStatus.set("connecting");
        sess.onStatus((s) => {
          if (destroyed) return;
          if (tabsStore.getState().activeId !== id) return;
          syncStatusStore.getState().set(s);
        });

        readNote(path)
          .then((disk) => {
            if (destroyed || tabsStore.getState().activeId !== id || !hostRef.current) return;

            const undoManager = new Y.UndoManager(sess.ytext);
            view = createEditor({
              parent: hostRef.current,
              doc: sess.ytext.toString(),
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              collab: yCollab(sess.ytext, sess.awareness as any, { undoManager }),
              annotations: collabAnnotations,
              onUpdate: (u) => onCollabUpdateRef.current(u),
              onChange: () => {
                // yCollab drives the doc; mirror ytext to disk once seeded.
                if (!ready) return;
                const text = sess.ytext.toString();
                editorStateStore.getState().setCurrentText(text);
                tabsStore.getState().setDirty(id, true);
                saver.schedule(text);
              },
              onSelection: () => {
                editorStateStore.getState().bumpSelectionEpoch();
              },
            });
            editorState.setActiveView(view);
            if (sess.ytext.doc) wireCollab(sess.ytext.doc, view);

            const markReady = () => {
              ready = true;
              editorStateStore.getState().setCurrentText(sess.ytext.toString());
            };

            // Seed an empty room from disk so existing files aren't lost; if
            // both are non-empty the room content already populated the editor.
            const seedFromDiskIfNeeded = () => {
              if (sess.ytext.length === 0 && disk.length > 0) {
                sess.ytext.insert(0, disk);
              }
            };

            sess.onSynced(() => {
              if (destroyed || tabsStore.getState().activeId !== id) return;
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
            // doc. Same wire-failed signal semantics as the Tier-2 path.
            ready = true;
            if (!destroyed) docCollabStore.getState().markWireFailed();
          });
      }
    } else {
      // ── Local-only path ─────────────────────────────────────────────────
      syncStatus.set(null);
      presence.reset();
      readNote(path).then((doc) => {
        if (destroyed) return;
        if (tabsStore.getState().activeId !== id) return;
        if (!hostRef.current) return;

        ready = true;
        editorStateStore.getState().setCurrentText(doc);
        view = createEditor({
          parent: hostRef.current,
          doc,
          onChange: (text) => {
            editorStateStore.getState().setCurrentText(text);
            tabsStore.getState().setDirty(id, true);
            saver.schedule(text);
          },
          onSelection: () => {
            editorStateStore.getState().bumpSelectionEpoch();
          },
        });
        editorStateStore.getState().setActiveView(view);
      });
    }

    // Cleanup — EXACT Svelte order: destroyed flag, unregisterFlush, seed
    // timer, awareness listener, presence reset, stopCollab, docCollab reset,
    // flush-or-cancel, view.destroy, session.destroy, conditional status null.
    return () => {
      destroyed = true;
      tabsStore.getState().unregisterFlush(id);
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
      presenceStore.getState().reset();
      if (stopCollab) {
        stopCollab();
        stopCollab = null;
      }
      docCollabStore.getState().reset();
      // Flush pending save before tearing the session down — but only while a
      // tab still exists under this id. After a rename/move retarget the id is
      // gone, and a flush here would write to the OLD path, recreating the
      // just-renamed file — so that path CANCELS instead: skipping alone would
      // leave the debounce timer armed, and its late write (re-armed by any
      // change, including remote collab updates) would resurrect the old file
      // anyway. (Tab close is covered: closeTab invokes the registered flush
      // before removing the tab.)
      if (tabsStore.getState().tabs.some((t) => t.id === id)) {
        saver.flush().catch(() => {});
      } else {
        saver.cancel();
      }
      if (view) {
        view.destroy();
        view = null;
        editorStateStore.getState().setActiveView(null);
      }
      if (session) {
        session.destroy();
        session = null;
      }
      // Clear status only if no other note has taken over.
      const nowActive = tabsStore.getState().activeId;
      if (nowActive === null || nowActive === id) {
        syncStatusStore.getState().set(null);
      }
    };
    // Deliberately primitive-only deps — see the value-stability note above.
    // Everything else is read via getState() inside the effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, activePath, activeMode, daemonRunning, activeLinked, identityKey]);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
      {activeId ? (
        <>
          {/* The toolbar renders in BOTH modes: its mode group is the way back
              out of reading view (where the editing cluster hides itself). */}
          <Toolbar />

          {isReadMode ? (
            <ReadingView />
          ) : (
            /* Positioned wrapper: the floating comment/suggest affordance is
               absolutely placed against this box, while CodeMirror mounts into
               the inner host. */
            <div ref={wrapRef} className="relative min-h-0 flex-1">
              {/* CodeMirror mounts directly into this div. */}
              <div ref={hostRef} className="cm-host h-full" style={{ overflow: "auto" }} />

              {/* Floating selection affordance + composer (synced docs only) */}
              {affordance && showAffordance && (
                <div
                  ref={composerElRef}
                  className="absolute z-20"
                  style={{ left: affordance.x, top: affordance.y }}
                >
                  {!composerOpen ? (
                    <Button
                      variant="outline"
                      size="sm"
                      className="gap-1.5 bg-popover shadow-lg"
                      style={{ minHeight: 40, minWidth: 40 }}
                      onClick={openComposer}
                      title={
                        suggestMode
                          ? "Suggest an edit to the selection"
                          : "Comment on the selection"
                      }
                    >
                      <MessageSquarePlus className="h-4 w-4" aria-hidden="true" />
                      {suggestMode ? "Suggest" : "Comment"}
                    </Button>
                  ) : suggestMode ? (
                    <div className="w-72 rounded-lg border bg-popover p-3 shadow-lg">
                      <select
                        className="mb-2 h-7 w-full rounded-md border bg-background px-2 text-xs"
                        value={suggestAction}
                        onChange={(e) => setSuggestAction(e.target.value as SuggestAction)}
                      >
                        <option value="replace">Replace selection</option>
                        <option value="insert-after">Insert after selection</option>
                        <option value="delete">Delete selection</option>
                      </select>
                      {suggestAction !== "delete" && (
                        <Textarea
                          className="w-full font-mono text-xs"
                          rows={2}
                          placeholder={
                            suggestAction === "replace" ? "Replacement text" : "Text to insert"
                          }
                          value={composerText}
                          onChange={(e) => setComposerText(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Escape") closeComposer();
                          }}
                        />
                      )}
                      <div className="mt-2 flex justify-end gap-1">
                        <Button variant="ghost" size="xs" onClick={closeComposer}>
                          Cancel
                        </Button>
                        <Button size="xs" onClick={addSuggestDraft}>
                          Add to suggestion
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div className="w-72 rounded-lg border bg-popover p-3 shadow-lg">
                      <Textarea
                        ref={commentTextareaRef}
                        className="w-full text-sm"
                        rows={2}
                        placeholder="Add a comment… (@ to mention)"
                        value={composerText}
                        onChange={(e) => setComposerText(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void submitComment();
                          if (e.key === "Escape") closeComposer();
                        }}
                      />
                      <div className="mt-2 flex justify-end gap-1">
                        <Button variant="ghost" size="xs" onClick={closeComposer}>
                          Cancel
                        </Button>
                        <Button
                          size="xs"
                          disabled={!composerText.trim()}
                          onClick={() => void submitComment()}
                        >
                          Comment
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Suggest-mode badge (mirrors the web editor) */}
              {suggestMode && (
                <div className="absolute right-3 top-2 z-10">
                  <Badge
                    className="border-transparent bg-amber-500/15 text-amber-700 dark:bg-amber-400/15 dark:text-amber-400"
                    title="You're in suggest mode — edits are queued as suggestions."
                  >
                    Suggesting
                  </Badge>
                </div>
              )}
            </div>
          )}
        </>
      ) : (
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground/60">
          Open a note from the sidebar to start editing
        </div>
      )}

      {/* History time-travel overlay: read-only, never mutates the live doc. */}
      {snapshot && collabStore && (
        <div className="absolute inset-0 z-20 flex flex-col bg-background">
          <SnapshotView
            text={snapshot.text}
            entry={snapshot.entry}
            onClose={() => docCollabStore.getState().store?.closeSnapshot()}
          />
        </div>
      )}
    </div>
  );
}
