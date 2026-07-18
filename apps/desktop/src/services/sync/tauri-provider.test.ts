/**
 * TauriProvider unit tests.
 *
 * Two layers of tests:
 *
 * Layer 1 — `createTauriSession` integration (Tauri IPC mocked):
 *   The Tauri IPC layer (invoke + listen) is absent in the Vitest (Node) environment,
 *   so we stub it before importing the provider. The stubs capture every call so we can
 *   assert on the outbound traffic the provider generates.
 *
 * Layer 2 — `makeTauriProvider` convergence (no mocks needed):
 *   Two providers share an in-memory bus. Provider A's send reaches Provider B's
 *   subscribe handler, and vice versa. Tests assert doc convergence and awareness
 *   propagation without any Tauri IPC.
 *
 * Coverage:
 *  1. createTauriSession returns a well-shaped Session.
 *  2. On creation, the provider calls attachEditor and sends a SyncStep1 frame.
 *  3. An inbound SyncStep2 frame triggers a SyncStep1 echo + SyncStep2 reply and fires onSynced.
 *  4. A local doc update is forwarded as a SyncUpdate frame.
 *  5. destroy() calls detachEditor and cleans up.
 *  6. onStatus is wired and reports "connected" once synced.
 *  7. Frames for other paths are ignored.
 *  8. (Convergence) Provider A insert → Provider B's doc reflects the text.
 *  9. (Convergence) Provider A awareness state → Provider B's awareness has that state.
 * 10. Awareness echo-loop guard: inbound remote awareness update is not re-broadcast.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";

// ─── Tauri stub setup ─────────────────────────────────────────────────────────
// Must be installed before the module under test is imported.

const invokedCalls: Array<{ cmd: string; args: Record<string, unknown> }> = [];
const eventHandlers: Map<string, Array<(payload: unknown) => void>> = new Map();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args: Record<string, unknown> = {}) => {
    invokedCalls.push({ cmd, args });
  }),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string, handler: (e: { payload: unknown }) => void) => {
    const wrapped = (payload: unknown) => handler({ payload });
    if (!eventHandlers.has(event)) eventHandlers.set(event, []);
    eventHandlers.get(event)!.push(wrapped);
    // Return an unlisten function
    return () => {
      const list = eventHandlers.get(event);
      if (list) {
        const idx = list.indexOf(wrapped);
        if (idx !== -1) list.splice(idx, 1);
      }
    };
  }),
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Emit a fake `editor://frame` event into any registered handlers. */
function emitEditorFrame(path: string, frame: Uint8Array) {
  const handlers = eventHandlers.get("editor://frame") ?? [];
  for (const h of handlers) {
    h({ path, frame: Array.from(frame) });
  }
}

/** Build a SyncStep2 frame. */
function makeSyncStep2Frame(doc: Y.Doc, sv?: Uint8Array): Uint8Array {
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, 0 /* MSG_SYNC */);
  syncProtocol.writeSyncStep2(enc, doc, sv);
  return encoding.toUint8Array(enc);
}

/** Decode a frame the provider sent via sendEditorFrame and return its message type info. */
function decodeFrame(frameBytes: number[]) {
  const arr = new Uint8Array(frameBytes);
  const decoder = decoding.createDecoder(arr);
  const msgType = decoding.readVarUint(decoder);
  let syncMsgType: number | undefined;
  if (msgType === 0 /* MSG_SYNC */) {
    syncMsgType = decoding.readVarUint(decoder);
  }
  return { msgType, syncMsgType };
}

/** Collect all send_editor_frame calls and return decoded frames. */
function sentFrames(path: string) {
  return invokedCalls
    .filter((c) => c.cmd === "send_editor_frame" && c.args.path === path)
    .map((c) => decodeFrame(c.args.frame as number[]));
}

// ─── Module under test ────────────────────────────────────────────────────────

// Import AFTER mocks are set up
const { createTauriSession, makeTauriProvider } = await import("./tauri-provider.js");

// ─── Tests ────────────────────────────────────────────────────────────────────

const TEST_PATH = "/workspace/notes/hello.md";

beforeEach(() => {
  invokedCalls.length = 0;
  eventHandlers.clear();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("createTauriSession", () => {
  it("returns a well-shaped Session with ydoc, ytext, provider, awareness", async () => {
    const session = await createTauriSession({
      path: TEST_PATH,
      identity: {
        userId: "alice@example.com",
        name: "Alice",
        color: "#ff0000",
        colorLight: "#ff000033",
        kind: "human",
      },
    });
    expect(session.ydoc).toBeInstanceOf(Y.Doc);
    expect(session.ytext).toBeDefined();
    expect(session.provider).toBeDefined();
    expect(session.awareness).toBeDefined();
    expect(typeof session.onSynced).toBe("function");
    expect(typeof session.onStatus).toBe("function");
    expect(typeof session.destroy).toBe("function");
    session.destroy();
  });

  it("registers the frame listener BEFORE attach_editor (bootstrap frame is never lost)", async () => {
    // The daemon bootstraps a freshly-attached editor by sending SyncStep1
    // immediately; Tauri events are not replayed for later listeners, so the
    // listener must exist by the time attach_editor runs.
    const { invoke } = await import("@tauri-apps/api/core");
    let handlersAtAttach = -1;
    vi.mocked(invoke).mockImplementationOnce(async (cmd, args) => {
      invokedCalls.push({ cmd, args: (args ?? {}) as Record<string, unknown> });
      if (cmd === "attach_editor") {
        handlersAtAttach = (eventHandlers.get("editor://frame") ?? []).length;
      }
    });
    const session = await createTauriSession({
      path: TEST_PATH,
      identity: {
        userId: "alice@example.com",
        name: "Alice",
        color: "#ff0000",
        colorLight: "#ff000033",
        kind: "human",
      },
    });
    expect(handlersAtAttach).toBe(1);
    session.destroy();
  });

  it("exposes the daemon's liveness answer as session.live", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    // attach_editor resolves true → the bridge will deliver a snapshot.
    vi.mocked(invoke).mockImplementationOnce(async (cmd, args) => {
      invokedCalls.push({ cmd, args: (args ?? {}) as Record<string, unknown> });
      return true;
    });
    const liveSession = await createTauriSession({
      path: TEST_PATH,
      identity: {
        userId: "alice@example.com",
        name: "Alice",
        color: "#ff0000",
        colorLight: "#ff000033",
        kind: "human",
      },
    });
    expect(liveSession.live).toBe(true);
    liveSession.destroy();

    // Default stub resolves undefined (daemon absent) → anything but `true` is dead.
    const deadSession = await createTauriSession({
      path: TEST_PATH,
      identity: {
        userId: "alice@example.com",
        name: "Alice",
        color: "#ff0000",
        colorLight: "#ff000033",
        kind: "human",
      },
    });
    expect(deadSession.live).toBe(false);
    deadSession.destroy();
  });

  it("calls attach_editor on creation", async () => {
    const session = await createTauriSession({
      path: TEST_PATH,
      identity: {
        userId: "alice@example.com",
        name: "Alice",
        color: "#ff0000",
        colorLight: "#ff000033",
        kind: "human",
      },
    });
    const attachCalls = invokedCalls.filter((c) => c.cmd === "attach_editor");
    expect(attachCalls).toHaveLength(1);
    expect(attachCalls[0].args.path).toBe(TEST_PATH);
    session.destroy();
  });

  it("sends a SyncStep1 frame after attach", async () => {
    const session = await createTauriSession({
      path: TEST_PATH,
      identity: {
        userId: "alice@example.com",
        name: "Alice",
        color: "#ff0000",
        colorLight: "#ff000033",
        kind: "human",
      },
    });
    // Allow any pending microtasks
    await Promise.resolve();
    const frames = sentFrames(TEST_PATH);
    const step1Frames = frames.filter(
      (f) => f.msgType === 0 && f.syncMsgType === syncProtocol.messageYjsSyncStep1,
    );
    expect(step1Frames.length).toBeGreaterThanOrEqual(1);
    session.destroy();
  });

  it("fires onSynced when a SyncStep2 frame arrives", async () => {
    const session = await createTauriSession({
      path: TEST_PATH,
      identity: {
        userId: "alice@example.com",
        name: "Alice",
        color: "#ff0000",
        colorLight: "#ff000033",
        kind: "human",
      },
    });
    await Promise.resolve();

    let synced = false;
    session.onSynced(() => {
      synced = true;
    });

    // Simulate the daemon sending a SyncStep2 (empty remote doc)
    const remoteDoc = new Y.Doc();
    const step2 = makeSyncStep2Frame(remoteDoc);
    emitEditorFrame(TEST_PATH, step2);

    await Promise.resolve();
    expect(synced).toBe(true);
    session.destroy();
  });

  it("reports 'connected' status after sync", async () => {
    const session = await createTauriSession({
      path: TEST_PATH,
      identity: {
        userId: "alice@example.com",
        name: "Alice",
        color: "#ff0000",
        colorLight: "#ff000033",
        kind: "human",
      },
    });
    await Promise.resolve();

    const statuses: string[] = [];
    session.onStatus((s) => statuses.push(s));

    const remoteDoc = new Y.Doc();
    const step2 = makeSyncStep2Frame(remoteDoc);
    emitEditorFrame(TEST_PATH, step2);

    await Promise.resolve();
    expect(statuses).toContain("connected");
    session.destroy();
  });

  it("forwards local doc updates as SyncUpdate frames", async () => {
    const session = await createTauriSession({
      path: TEST_PATH,
      identity: {
        userId: "alice@example.com",
        name: "Alice",
        color: "#ff0000",
        colorLight: "#ff000033",
        kind: "human",
      },
    });
    await Promise.resolve();

    // Sync first
    const remoteDoc = new Y.Doc();
    emitEditorFrame(TEST_PATH, makeSyncStep2Frame(remoteDoc));
    await Promise.resolve();

    const before = invokedCalls.filter((c) => c.cmd === "send_editor_frame").length;

    // Make a local change
    session.ytext.insert(0, "hello");
    await Promise.resolve();

    const after = invokedCalls.filter((c) => c.cmd === "send_editor_frame").length;
    expect(after).toBeGreaterThan(before);

    const updateFrames = sentFrames(TEST_PATH).filter(
      (f) => f.msgType === 0 && f.syncMsgType === syncProtocol.messageYjsUpdate,
    );
    expect(updateFrames.length).toBeGreaterThanOrEqual(1);
    session.destroy();
  });

  it("calls detach_editor on destroy", async () => {
    const session = await createTauriSession({
      path: TEST_PATH,
      identity: {
        userId: "alice@example.com",
        name: "Alice",
        color: "#ff0000",
        colorLight: "#ff000033",
        kind: "human",
      },
    });
    await Promise.resolve();
    session.destroy();
    await Promise.resolve();

    const detachCalls = invokedCalls.filter((c) => c.cmd === "detach_editor");
    expect(detachCalls).toHaveLength(1);
    expect(detachCalls[0].args.path).toBe(TEST_PATH);
  });

  it("ignores frames for other paths", async () => {
    const session = await createTauriSession({
      path: TEST_PATH,
      identity: {
        userId: "alice@example.com",
        name: "Alice",
        color: "#ff0000",
        colorLight: "#ff000033",
        kind: "human",
      },
    });
    await Promise.resolve();

    let synced = false;
    session.onSynced(() => {
      synced = true;
    });

    // Frame for a completely different path — should be ignored
    const remoteDoc = new Y.Doc();
    emitEditorFrame("/other/path.md", makeSyncStep2Frame(remoteDoc));
    await Promise.resolve();

    expect(synced).toBe(false);
    session.destroy();
  });
});

// ─── Two-provider convergence tests (in-memory bus, no Tauri IPC) ─────────────
//
// Build a shared in-memory bus where A's send reaches B's subscribe handler
// and B's send reaches A's subscribe handler. Wire two `makeTauriProvider`
// instances to this bus and verify that CRDT state converges.

/**
 * Create a symmetric in-memory bus for two providers.
 * Returns { transportA, transportB } where A's send is B's receive and vice versa.
 */
function makeInMemoryBus(): {
  transportA: {
    send: (f: Uint8Array) => void;
    subscribe: (h: (f: Uint8Array) => void) => () => void;
  };
  transportB: {
    send: (f: Uint8Array) => void;
    subscribe: (h: (f: Uint8Array) => void) => () => void;
  };
} {
  let handlerA: ((f: Uint8Array) => void) | null = null;
  let handlerB: ((f: Uint8Array) => void) | null = null;

  const transportA = {
    send: (frame: Uint8Array) => {
      // A sends → B receives
      if (handlerB) handlerB(frame);
    },
    subscribe: (handler: (f: Uint8Array) => void) => {
      handlerA = handler;
      return () => {
        handlerA = null;
      };
    },
  };

  const transportB = {
    send: (frame: Uint8Array) => {
      // B sends → A receives
      if (handlerA) handlerA(frame);
    },
    subscribe: (handler: (f: Uint8Array) => void) => {
      handlerB = handler;
      return () => {
        handlerB = null;
      };
    },
  };

  return { transportA, transportB };
}

describe("makeTauriProvider — two-provider convergence", () => {
  it("doc convergence: Provider A insert reaches Provider B's doc", () => {
    const { transportA, transportB } = makeInMemoryBus();
    const docA = new Y.Doc();
    const docB = new Y.Doc();

    const identity: Parameters<typeof makeTauriProvider>[0]["identity"] = {
      userId: "alice@example.com",
      name: "Alice",
      color: "#f00",
      colorLight: "#f0033",
      kind: "human",
    };

    const provA = makeTauriProvider({
      doc: docA,
      path: "/test.md",
      identity,
      ...transportA,
    });
    const provB = makeTauriProvider({
      doc: docB,
      path: "/test.md",
      identity: { ...identity, name: "Bob" },
      ...transportB,
    });

    // At this point both providers have exchanged SyncStep1/Step2 frames via the
    // in-memory bus. Now insert text on A and verify B converges.
    docA.getText("content").insert(0, "hello from A");

    expect(docB.getText("content").toString()).toBe("hello from A");

    provA.destroy();
    provB.destroy();
  });

  it("awareness propagation: Provider A state arrives on Provider B's awareness", () => {
    const { transportA, transportB } = makeInMemoryBus();
    const docA = new Y.Doc();
    const docB = new Y.Doc();

    const identity: Parameters<typeof makeTauriProvider>[0]["identity"] = {
      userId: "alice@example.com",
      name: "Alice",
      color: "#f00",
      colorLight: "#f0033",
      kind: "human",
    };

    const provA = makeTauriProvider({
      doc: docA,
      path: "/test.md",
      identity,
      ...transportA,
    });
    const provB = makeTauriProvider({
      doc: docB,
      path: "/test.md",
      identity: { ...identity, name: "Bob" },
      ...transportB,
    });

    // Set a custom awareness field on A
    provA.awareness.setLocalStateField("cursor", { line: 5, ch: 3 });

    // B's awareness should now contain A's clientID with the cursor field
    const statesB = provB.awareness.getStates();
    const aState = statesB.get(docA.clientID);
    expect(aState).toBeDefined();
    expect((aState as Record<string, unknown>)?.cursor).toEqual({ line: 5, ch: 3 });

    provA.destroy();
    provB.destroy();
  });

  it("sever() cuts the transport but keeps the doc alive for local edits", () => {
    const sent: Uint8Array[] = [];
    let handler: ((f: Uint8Array) => void) | null = null;
    const prov = makeTauriProvider({
      doc: new Y.Doc(),
      path: "/test.md",
      identity: {
        userId: "alice@example.com",
        name: "Alice",
        color: "#f00",
        colorLight: "#f0033",
        kind: "human",
      },
      send: (f) => sent.push(f),
      subscribe: (h) => {
        handler = h;
        return () => {
          handler = null;
        };
      },
    });

    prov.sever();

    // Unsubscribed: no inbound frames can arrive anymore.
    expect(handler).toBeNull();
    // Local edits still work but leave no frames — the doc is safe to seed from
    // disk without a late replica snapshot merging a duplicate copy.
    const framesBefore = sent.length;
    prov.ytext.insert(0, "local only");
    expect(sent.length).toBe(framesBefore);
    expect(prov.ytext.toString()).toBe("local only");

    prov.destroy(); // destroy after sever stays safe (idempotent teardown)
  });
});
