// The web (yjs) half of the Mac FFI interop e2e (driven by apps/mac/e2e.sh).
// Usage: node mac-ffi-e2e.mjs <room>     env: MUESLI_WS (default ws://localhost:8787/ws)
//
// Joins <room> as a real y-websocket client (the same stack the web app uses), writes
// "hello from web", then waits for the Mac FFI client (the XCTest in
// apps/mac/Tests/MuesliMacTests/IntegrationTests.swift) to answer "hello from mac".
// Exits 0 only when this yjs replica holds BOTH lines — i.e. web ↔ server ↔ mac converged.
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import WebSocket from "ws";

const [room] = process.argv.slice(2);
if (!room) {
  console.error("usage: node mac-ffi-e2e.mjs <room>");
  process.exit(2);
}
const WS_URL = process.env.MUESLI_WS ?? "ws://localhost:8787/ws";
const TIMEOUT_MS = 90_000; // covers swift test's compile+launch latency

const doc = new Y.Doc();
// disableBc mirrors convergence.mjs: never let a side channel fake the result.
const provider = new WebsocketProvider(WS_URL, room, doc, {
  WebSocketPolyfill: WebSocket,
  disableBc: true,
});
provider.awareness.setLocalStateField("user", { name: "web-e2e", color: "#888", kind: "test" });
const text = doc.getText("content");

const fail = setTimeout(() => {
  console.error("FAIL: no convergence with the mac client within", TIMEOUT_MS, "ms");
  console.error("web replica:", JSON.stringify(text.toString()));
  process.exit(1);
}, TIMEOUT_MS);

await new Promise((resolve) => provider.on("sync", (s) => s && resolve()));
text.insert(0, "hello from web\n");
console.log("web: wrote 'hello from web', waiting for the mac client…");

await new Promise((resolve) => {
  const check = () => {
    const s = text.toString();
    if (s.includes("hello from web") && s.includes("hello from mac")) resolve();
  };
  doc.on("update", check);
  check();
});

clearTimeout(fail);
console.log("OK: web (yjs) replica converged with the mac FFI client.");
console.log("final state:", JSON.stringify(text.toString()));
provider.destroy();
process.exit(0);
