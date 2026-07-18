// Per-document collaboration session — React port of src/session.svelte.ts.
// Each visited doc gets its own Y.Doc + ws provider + CollabStore, and
// destroy() tears the whole thing down (websocket closed, listeners off), so
// switching docs or going home leaks nothing. DocApp opens one per mount and
// is keyed on `${docId} ${shareToken}`, so a doc switch is destroy + fresh open.
//
// React adaptation: the Svelte context becomes a React context
// (DocSessionContext.Provider in DocApp; useDocSession() in the doc chrome),
// and the `$state.raw` editorView seam becomes a tiny external store on the
// session object — Editor sets `session.editorView` on mount/unmount exactly
// as before, and components that must re-render on editor availability
// (Toolbar, OutlineRail) subscribe via useEditorView(session).

import { createContext, useContext, useSyncExternalStore } from "react";
import type { EditorView } from "@codemirror/view";
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import { createCollabApi } from "@/services/collabApi";
import { CollabStore } from "@/state/collabStore";
import { httpBase, me, wsUrl } from "@/services/identity";
import type { PresenceUser } from "@/services/presence";

// The presence shape published into awareness. Dedup-by-userId grouping lives in
// presence.ts; this is just the per-client payload, kept assignable to PresenceUser
// so the header can group raw entries into one indicator per person.
export type Participant = PresenceUser;

export type DocSession = {
  readonly docId: string;
  readonly shareToken: string | null;
  readonly ydoc: Y.Doc;
  readonly ytext: Y.Text;
  readonly provider: WebsocketProvider;
  readonly store: CollabStore;
  /** The mounted CodeMirror view for this doc — the Editor component sets it
   * on mount and clears it on unmount. Writes notify subscribeEditorView
   * listeners, so doc chrome (toolbar, outline rail) can render against editor
   * availability and dispatch transactions / read selections through it. */
  editorView: EditorView | null;
  /** Subscribe to editorView changes (useEditorView wraps this). */
  subscribeEditorView(listener: () => void): () => void;
  /** Raw [clientId, user] awareness pairs (clientId preserved) for groupPresence(). */
  participantEntries(): Array<[number, Participant]>;
  /** The local awareness clientId — the guest dedup fallback (`guest:${clientId}`). */
  readonly localClientId: number;
  /** Re-publish the local `user` awareness field from the current `me` snapshot
   *  (call after auth resolves so userId/avatar/color reach other clients). */
  publishLocalUser(): void;
  createShareLink(role: "viewer" | "commenter" | "editor"): Promise<{ url: string; role: string }>;
  destroy(): void;
};

export function openSession(docId: string, shareToken: string | null): DocSession {
  const ydoc = new Y.Doc();
  // "content" is the shared text root — must match muesli_core::TEXT_ROOT.
  const ytext = ydoc.getText("content");
  // The session cookie rides along on the upgrade; the share token goes as a
  // query param. KNOWN LIMITATION (security review finding 28): browsers
  // cannot set custom headers on a WebSocket handshake, so unlike the REST
  // layer (X-Muesli-Share header, see collabApi.ts) the token must travel in
  // the upgrade URL and can land in server/proxy access logs. Confined to this
  // single handshake request; REST requests no longer carry it in the URL.
  const provider = new WebsocketProvider(wsUrl, docId, ydoc, {
    params: shareToken ? { share: shareToken } : {},
  });
  const publishLocalUser = () =>
    provider.awareness.setLocalStateField("user", {
      userId: me.userId,
      name: me.name,
      color: me.color,
      colorLight: me.light,
      avatar: me.avatar,
      kind: "human",
    } satisfies Participant);
  publishLocalUser();
  const store = new CollabStore(createCollabApi({ httpBase, docSlug: docId, shareToken }), ydoc);

  // $state.raw seam → minimal external store (no versioning needed: the view
  // reference itself is the snapshot).
  let editorView: EditorView | null = null;
  const viewListeners = new Set<() => void>();

  return {
    docId,
    shareToken,
    ydoc,
    ytext,
    provider,
    store,
    get editorView() {
      return editorView;
    },
    set editorView(v: EditorView | null) {
      editorView = v;
      for (const l of [...viewListeners]) l();
    },
    subscribeEditorView(listener: () => void) {
      viewListeners.add(listener);
      return () => {
        viewListeners.delete(listener);
      };
    },
    participantEntries: () =>
      [...provider.awareness.getStates().entries()]
        .filter(([, s]) => s.user)
        .map(([clientId, s]) => [clientId, s.user as Participant]),
    get localClientId() {
      return provider.awareness.clientID;
    },
    publishLocalUser,
    async createShareLink(role) {
      const res = await fetch(`${httpBase}/api/documents/${encodeURIComponent(docId)}/share`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role }),
      });
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
    destroy() {
      // provider.destroy() closes the websocket and detaches its doc/awareness hooks.
      provider.destroy();
      ydoc.destroy();
    },
  };
}

// --- component access (DocApp provides; Editor/Toolbar/OutlineRail/panels consume) ----------

export const DocSessionContext = createContext<DocSession | null>(null);

export function useDocSession(): DocSession {
  const session = useContext(DocSessionContext);
  if (!session) throw new Error("useDocSession() called outside a DocApp subtree");
  return session;
}

/** Reactive read of the session's mounted editor view (null until the Editor
 *  mounts, null again after it unmounts). */
export function useEditorView(session: DocSession): EditorView | null {
  return useSyncExternalStore(
    session.subscribeEditorView,
    () => session.editorView,
    () => session.editorView,
  );
}
