/**
 * TauriProvider — y-protocols sync + awareness over Tauri IPC (Tier-2, Plan 3).
 *
 * Drop-in replacement for `y-websocket`'s `WebsocketProvider` for synced docs.
 * Instead of a websocket it speaks over three Tauri IPC channels:
 *   - `attachEditor(path)`            — notify Rust to open the bridge
 *   - `sendEditorFrame(path, frame)`  — JS → Rust y-protocols frame
 *   - `onEditorFrame(handler)`        — Rust → JS y-protocols frame subscription
 *
 * The implementation is split into two layers:
 *   - `makeTauriProvider(opts)` — pure/testable core; no Tauri IPC imports.
 *     Takes injectable `send` and `subscribe` functions.
 *   - `createTauriSession(doc, path, identity)` — wires the real Tauri IPC into
 *     `makeTauriProvider` and returns a Session.
 *
 * The provider manages one Y.Doc and one Awareness instance. It performs the
 * y-websocket sync handshake (Step1 → Step2 → synced) and forwards local doc
 * updates and awareness changes over IPC. The daemon treats the open editor as
 * a second peer of its canonical CRDT replica (same replica, different transport).
 */

import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";

import { attachEditor, detachEditor, sendEditorFrame, onEditorFrame } from "../tauri.js";
import type { Session, SyncStatus } from "./session.js";

// y-protocols message type constants
const MSG_SYNC = 0;
const MSG_AWARENESS = 1;

export interface PresenceIdentity {
  /** Presence dedup key: auth user id (email-derived on desktop) or null for guests. */
  userId: string | null;
  name: string;
  color: string;
  colorLight: string;
  /** Profile picture URL; null/absent → initials. */
  avatar?: string | null;
  kind: "human" | "agent";
}

export interface CreateTauriSessionOpts {
  path: string;
  identity: PresenceIdentity;
}

// ─── makeTauriProvider types ──────────────────────────────────────────────────

/**
 * Injectable transport functions passed to `makeTauriProvider`.
 * `send(frame)` transmits a raw byte frame.
 * `subscribe(handler)` registers a handler for inbound frames and returns an
 * unlisten function.
 */
export interface TauriTransport {
  send: (frame: Uint8Array) => void;
  subscribe: (handler: (frame: Uint8Array) => void) => () => void;
}

export interface MakeTauriProviderOpts {
  doc: Y.Doc;
  path: string;
  identity: PresenceIdentity;
  send: TauriTransport["send"];
  subscribe: TauriTransport["subscribe"];
}

// ─── Internal provider object ─────────────────────────────────────────────────

interface TauriProviderInternal {
  ydoc: Y.Doc;
  ytext: Y.Text;
  awareness: awarenessProtocol.Awareness;
  // Signal synced/status state to subscribers
  _synced: boolean;
  _status: SyncStatus;
  _syncedCallbacks: Array<() => void>;
  _statusCallbacks: Array<(s: SyncStatus) => void>;
  _unlisten: (() => void) | null;
  _path: string;
  // Bound cleanup for doc update observer
  _docUpdateHandler: (update: Uint8Array, origin: unknown) => void;
  _awarenessHandler: (
    arg: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ) => void;
  _send: TauriTransport["send"];
}

/** Build and send a SyncStep1 frame (the opening handshake). */
function sendSyncStep1(send: TauriTransport["send"], doc: Y.Doc): void {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, MSG_SYNC);
  syncProtocol.writeSyncStep1(enc, doc);
  send(encoding.toUint8Array(enc));
}

/** Handle one inbound frame from the daemon. */
function handleInboundFrame(provider: TauriProviderInternal, frameBytes: Uint8Array): void {
  const { ydoc, awareness } = provider;
  const decoder = decoding.createDecoder(frameBytes);
  const msgType = decoding.readVarUint(decoder);

  if (msgType === MSG_SYNC) {
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    const syncMsgType = syncProtocol.readSyncMessage(decoder, enc, ydoc, provider);
    if (encoding.length(enc) > 1) {
      // There is a reply (e.g. Step2 in response to Step1)
      provider._send(encoding.toUint8Array(enc));
    }
    // Fire synced only when we receive Step2 (the peer's full state) — not on Step1
    if (syncMsgType === syncProtocol.messageYjsSyncStep2 && !provider._synced) {
      provider._synced = true;
      provider._status = "connected";
      for (const cb of provider._syncedCallbacks) cb();
      for (const cb of provider._statusCallbacks) cb("connected");
    }
  } else if (msgType === MSG_AWARENESS) {
    awarenessProtocol.applyAwarenessUpdate(
      awareness,
      decoding.readVarUint8Array(decoder),
      "remote",
    );
  }
}

// ─── Core testable provider ───────────────────────────────────────────────────

/**
 * Create a `TauriProviderInternal` wired to the given injectable transport.
 *
 * This function has no Tauri IPC imports — all I/O is done via `send` and
 * `subscribe`, making it fully testable in a Node/Vitest environment.
 *
 * Callers are responsible for calling `attachEditor` before `makeTauriProvider`
 * and `detachEditor` after `provider._unlisten?.()`.
 */
export function makeTauriProvider(opts: MakeTauriProviderOpts): TauriProviderInternal & {
  /** Return a Session-compatible interface. */
  toSession(): Session;
  destroy(): void;
} {
  const { doc: ydoc, path, identity, send, subscribe } = opts;

  const ytext = ydoc.getText("content");
  const awareness = new awarenessProtocol.Awareness(ydoc);

  // Set local presence
  awareness.setLocalStateField("user", {
    userId: identity.userId,
    name: identity.name,
    color: identity.color,
    colorLight: identity.colorLight,
    avatar: identity.avatar ?? null,
    kind: identity.kind,
  });

  const provider: TauriProviderInternal = {
    ydoc,
    ytext,
    awareness,
    _synced: false,
    _status: "connecting",
    _syncedCallbacks: [],
    _statusCallbacks: [],
    _unlisten: null,
    _path: path,
    _docUpdateHandler: () => {},
    _awarenessHandler: () => {},
    _send: send,
  };

  // Register inbound frame listener
  provider._unlisten = subscribe((frameBytes: Uint8Array) => {
    handleInboundFrame(provider, frameBytes);
  });

  // Forward local doc updates to the daemon
  provider._docUpdateHandler = (update: Uint8Array, origin: unknown) => {
    if (origin === provider) return; // avoid echo-loop for updates we applied ourselves
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_SYNC);
    syncProtocol.writeUpdate(enc, update);
    send(encoding.toUint8Array(enc));
  };
  ydoc.on("update", provider._docUpdateHandler);

  // Forward local awareness changes to the daemon
  // Guard: skip re-broadcasting updates that arrived from the network ("remote")
  // to avoid a ping-pong echo loop.
  provider._awarenessHandler = (
    { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ) => {
    if (origin === "remote") return;
    const changedClients = added.concat(updated).concat(removed);
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MSG_AWARENESS);
    encoding.writeVarUint8Array(
      enc,
      awarenessProtocol.encodeAwarenessUpdate(awareness, changedClients),
    );
    send(encoding.toUint8Array(enc));
  };
  awareness.on("update", provider._awarenessHandler);

  // Send SyncStep1 so the remote peer replies with SyncStep2
  sendSyncStep1(send, ydoc);

  function destroy() {
    // Broadcast departure before tearing down
    awarenessProtocol.removeAwarenessStates(awareness, [ydoc.clientID], "local");
    ydoc.off("update", provider._docUpdateHandler);
    awareness.off("update", provider._awarenessHandler);
    if (provider._unlisten) {
      provider._unlisten();
      provider._unlisten = null;
    }
    awareness.destroy();
    ydoc.destroy();
  }

  function toSession(): Session {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const providerAsAny = provider as any;
    return {
      ydoc,
      ytext,
      provider: providerAsAny,
      awareness,
      onSynced(cb) {
        if (provider._synced) {
          cb();
        } else {
          provider._syncedCallbacks.push(cb);
        }
      },
      onStatus(cb) {
        provider._statusCallbacks.push(cb);
        // Immediately deliver current status
        cb(provider._status);
      },
      destroy,
    };
  }

  return Object.assign(provider, { toSession, destroy });
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Create a `Session` backed by Tauri IPC instead of a websocket.
 *
 * Wires the real Tauri IPC (`sendEditorFrame`, `onEditorFrame`) into
 * `makeTauriProvider` and calls `attachEditor` / `detachEditor` around it.
 *
 * The function is async because it must:
 *  1. Call `attachEditor` on the daemon,
 *  2. Register the `editor://frame` listener via `onEditorFrame`,
 *  3. Delegate the sync handshake to `makeTauriProvider`.
 */
export async function createTauriSession(opts: CreateTauriSessionOpts): Promise<Session> {
  const { path, identity } = opts;

  const doc = new Y.Doc();

  // Tell the daemon to open the bridge for this file
  await attachEditor(path);

  // Map of per-path inbound handlers (filtered by path inside the shared listener)
  let inboundHandler: ((frame: Uint8Array) => void) | null = null;

  // onEditorFrame subscribes to the Tauri `editor://frame` event globally;
  // we filter by path inside the subscribe callback.
  const unlistenOuter = await onEditorFrame((evt) => {
    if (evt.path !== path) return;
    if (inboundHandler) {
      inboundHandler(new Uint8Array(evt.frame));
    }
  });

  const transport: TauriTransport = {
    send: (frame: Uint8Array) => {
      sendEditorFrame(path, Array.from(frame)).catch((err: unknown) => {
        console.warn("[TauriProvider] sendEditorFrame error:", err);
      });
    },
    subscribe: (handler: (frame: Uint8Array) => void) => {
      inboundHandler = handler;
      return () => {
        inboundHandler = null;
      };
    },
  };

  const providerWithSession = makeTauriProvider({
    doc,
    path,
    identity,
    send: transport.send,
    subscribe: transport.subscribe,
  });

  const session = providerWithSession.toSession();

  // Wrap destroy to also call detachEditor and remove the outer listener
  const originalDestroy = session.destroy.bind(session);
  session.destroy = () => {
    originalDestroy();
    unlistenOuter();
    detachEditor(path).catch(() => {});
  };

  return session;
}
