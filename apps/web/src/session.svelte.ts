// Per-document collaboration session. Replaces the old collab.ts module-level
// singletons: each visited doc gets its own Y.Doc + ws provider + CollabStore,
// and destroy() tears the whole thing down (websocket closed, listeners off),
// so switching docs or going home leaks nothing. DocApp opens one per mount and
// is keyed on the doc id, so a doc switch is destroy + fresh open.
import { getContext, setContext } from "svelte";
import type { EditorView } from "@codemirror/view";
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import { createCollabApi } from "./collabApi";
import { CollabStore } from "./collabStore.svelte";
import { httpBase, me, wsUrl } from "./identity";
import type { PresenceUser } from "./presence";

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
  /** The mounted CodeMirror view for this doc — Editor.svelte sets it on
   * mount and clears it on unmount. Reactive ($state), so doc chrome
   * (toolbar, outline rail) can render against editor availability and
   * dispatch transactions / read selections through it. */
  editorView: EditorView | null;
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

  let editorView = $state.raw<EditorView | null>(null);

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

const KEY = "muesli:doc-session";

export function provideDocSession(session: DocSession): void {
  setContext(KEY, session);
}

export function useDocSession(): DocSession {
  const session = getContext<DocSession | undefined>(KEY);
  if (!session) throw new Error("useDocSession() called outside a DocApp subtree");
  return session;
}
