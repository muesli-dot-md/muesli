// Persistence check (ADR 0010): run with mode=write to put a marker into a room, then
// restart the server and run with mode=read to assert the room hydrated it from Postgres.
// Usage: node persistence-e2e.mjs <write|read> <room> <marker>
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import WebSocket from "ws";

const [mode, room, marker] = process.argv.slice(2);
const WS_URL = process.env.MUESLI_WS ?? "ws://localhost:8787/ws";

const doc = new Y.Doc();
const provider = new WebsocketProvider(WS_URL, room, doc, { WebSocketPolyfill: WebSocket });
const text = doc.getText("content");

setTimeout(() => {
  console.error(`FAIL (timeout) mode=${mode}; room text:`, JSON.stringify(text.toString()));
  process.exit(1);
}, 10_000);

await new Promise((resolve) => provider.on("sync", (s) => s && resolve()));

if (mode === "write") {
  text.insert(0, `${marker}\n`);
  // Give the update a moment to reach the server and hit the log.
  await new Promise((r) => setTimeout(r, 600));
  console.log("OK: wrote marker");
} else {
  while (!text.toString().includes(marker)) {
    await new Promise((r) => setTimeout(r, 150));
  }
  console.log("OK: marker survived the restart:", JSON.stringify(text.toString()));
}
provider.destroy();
process.exit(0);
