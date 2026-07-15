// Per-note collaboration session, mirroring apps/web/src/session.svelte.ts:
// each open note gets its own Y.Doc + WebsocketProvider, and destroy() tears the
// whole thing down (websocket closed, listeners off) so a note switch leaks nothing.
//
// The shared text root MUST be "content" (matches muesli_core::TEXT_ROOT and the
// muesli web app), and the websocket room is the note's slug.
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import type { Awareness } from "y-protocols/awareness";

export type SyncStatus = "connected" | "connecting" | "disconnected";

/**
 * The minimum awareness API both providers satisfy.
 * `WebsocketProvider["awareness"]` is an `Awareness` instance from y-protocols.
 * `TauriProvider` creates its own `Awareness`. Both extend `Observable<string>` and
 * expose the same `setLocalStateField` / `getStates` surface, so we use the
 * y-protocols type directly, widened to accept either.
 */
type AnyAwareness = Awareness | WebsocketProvider["awareness"];

export interface Session {
  ydoc: Y.Doc;
  ytext: Y.Text;
  /**
   * The underlying provider. May be a `WebsocketProvider` (Tier-1 fallback) or the
   * internal `TauriProviderInternal` object (Tier-2 IPC). Typed as `unknown` because
   * callers interact with the `Session` methods (`onSynced`, `onStatus`, `destroy`)
   * rather than the provider directly — keeping both paths behind the same interface.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  provider: any;
  awareness: AnyAwareness;
  /** Fire `cb` once when the room first syncs (provider 'synced' event). */
  onSynced(cb: () => void): void;
  /** Subscribe to connection-status changes. */
  onStatus(cb: (s: SyncStatus) => void): void;
  /**
   * Cut the transport but keep the Y.Doc/awareness alive for local-only editing
   * (Tier-2 only): after sever() no frames leave or arrive, so the doc can be
   * seeded from disk with no risk of a late replica snapshot merging a duplicate.
   * The legacy websocket session does not implement it.
   */
  sever?(): void;
  /**
   * Tier-2 only: whether the daemon reported the bridge LIVE at attach time (a
   * linked session that has synced this run). `false` means no snapshot is coming
   * — sever and seed from disk immediately instead of waiting on the fallback.
   */
  live?: boolean;
  destroy(): void;
}

// The presence identity to publish into awareness. On the legacy WS path a note
// is local-only with no auth, so the caller passes userId: null (a guest) — that
// keeps it from deduping wrongly against any authenticated session.
export interface SessionIdentity {
  userId: string | null;
  name: string;
  color: string;
  colorLight: string;
  avatar?: string | null;
  kind: "human" | "agent";
}

export interface CreateSessionOpts {
  slug: string;
  wsBase: string;
  /** Defaults to a local "You" guest when omitted. */
  identity?: SessionIdentity;
}

// Fallback presence for a local-only note; Muesli is local-first so identity
// is cosmetic. userId is null so a local session shows as a single guest.
const DEFAULT_IDENTITY: SessionIdentity = {
  userId: null,
  name: "You",
  color: "#a882ff",
  colorLight: "#a882ff33",
  avatar: null,
  kind: "human",
};

export function createSession(opts: CreateSessionOpts): Session {
  const { slug, wsBase, identity = DEFAULT_IDENTITY } = opts;

  const ydoc = new Y.Doc();
  // "content" is the shared text root — must match muesli_core::TEXT_ROOT.
  const ytext = ydoc.getText("content");

  const provider = new WebsocketProvider(wsBase, slug, ydoc);
  const awareness = provider.awareness;
  awareness.setLocalStateField("user", {
    userId: identity.userId,
    name: identity.name,
    color: identity.color,
    colorLight: identity.colorLight,
    avatar: identity.avatar ?? null,
    kind: identity.kind,
  });

  return {
    ydoc,
    ytext,
    provider,
    awareness,
    onSynced(cb) {
      // y-websocket emits 'sync' (boolean) when the room first syncs; fire once
      // on the truthy edge. (Equivalent to the legacy 'synced' event.)
      const handler = (isSynced: boolean) => {
        if (isSynced) {
          provider.off("sync", handler);
          cb();
        }
      };
      provider.on("sync", handler);
    },
    onStatus(cb) {
      provider.on("status", ({ status }: { status: string }) => {
        if (status === "connected") cb("connected");
        else if (status === "connecting") cb("connecting");
        else cb("disconnected");
      });
      // y-websocket also emits these on a dropped/failed socket; both mean offline.
      provider.on("connection-close", () => cb("disconnected"));
      provider.on("connection-error", () => cb("disconnected"));
    },
    destroy() {
      // provider.destroy() closes the websocket and detaches its doc/awareness hooks.
      provider.destroy();
      ydoc.destroy();
    },
  };
}
