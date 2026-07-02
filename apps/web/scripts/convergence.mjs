// Headless two-client convergence check against a running muesli-server
// (Phase 0 demo verification, internal/design/roadmap.md). Exits 0 on convergence.
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import WebSocket from "ws";

const WS_URL = process.env.MUESLI_WS ?? "ws://localhost:8787/ws";
const room = `convergence-test-${process.pid}`;
const TIMEOUT_MS = 10_000;

function client(name) {
  const doc = new Y.Doc();
  // disableBc: both clients live in this process; BroadcastChannel would sync them
  // locally and bypass the server, making the test pass even with a broken server.
  const provider = new WebsocketProvider(WS_URL, room, doc, {
    WebSocketPolyfill: WebSocket,
    disableBc: true,
  });
  provider.awareness.setLocalStateField("user", { name, color: "#888", kind: "test" });
  const synced = new Promise((resolve) => provider.on("sync", (s) => s && resolve()));
  return { doc, provider, synced, text: doc.getText("content") };
}

const a = client("A");
const b = client("B");

const fail = setTimeout(() => {
  console.error("FAIL: clients did not converge within", TIMEOUT_MS, "ms");
  console.error("A:", JSON.stringify(a.text.toString()));
  console.error("B:", JSON.stringify(b.text.toString()));
  process.exit(1);
}, TIMEOUT_MS);

await Promise.all([a.synced, b.synced]);

// Rooms start empty; both clients must agree on whatever state the room has.
if (a.text.toString() !== b.text.toString()) {
  console.error("FAIL: initial states differ after sync");
  process.exit(1);
}

// Concurrent edits from both sides.
a.text.insert(0, "alpha says hi\n");
b.text.insert(b.text.length, "\nbeta says bye\n");

await new Promise((resolve) => {
  const check = () => {
    const sa = a.text.toString();
    const sb = b.text.toString();
    if (sa === sb && sa.includes("alpha says hi") && sa.includes("beta says bye")) resolve();
  };
  a.doc.on("update", check);
  b.doc.on("update", check);
  check();
});

clearTimeout(fail);
console.log("OK: both clients converged.");
console.log("Final state:", JSON.stringify(a.text.toString()));
a.provider.destroy();
b.provider.destroy();
process.exit(0);
