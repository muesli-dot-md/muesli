// Authenticated room probe: assert a room's text contains a marker, optionally inserting
// one first. Auth via MUESLI_BEARER (api token) or ?share= (MUESLI_SHARE).
// Usage: [MUESLI_BEARER=…] node roomcheck.mjs <room> [--expect <substr>] [--insert <text>]
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import WebSocket from "ws";

const WS_URL = process.env.MUESLI_WS ?? "ws://localhost:8787/ws";
const args = process.argv.slice(2);
const room = args[0];
const expect = args.includes("--expect") ? args[args.indexOf("--expect") + 1] : null;
const insert = args.includes("--insert") ? args[args.indexOf("--insert") + 1] : null;

setTimeout(() => {
  console.error("FAIL: timeout");
  process.exit(1);
}, 15_000);

class BearerWS extends WebSocket {
  constructor(url, protocols) {
    const headers = {};
    if (process.env.MUESLI_BEARER) headers.authorization = `Bearer ${process.env.MUESLI_BEARER}`;
    super(url, protocols, { headers });
  }
}

const doc = new Y.Doc();
const provider = new WebsocketProvider(WS_URL, room, doc, {
  WebSocketPolyfill: BearerWS,
  params: process.env.MUESLI_SHARE ? { share: process.env.MUESLI_SHARE } : {},
  disableBc: true,
});
const text = doc.getText("content");
await new Promise((resolve) => provider.on("sync", (s) => s && resolve()));

if (insert) {
  text.insert(0, `${insert}\n`);
  await new Promise((r) => setTimeout(r, 500));
  console.log(`OK: inserted ${JSON.stringify(insert)}`);
}
if (expect) {
  while (!text.toString().includes(expect)) {
    await new Promise((r) => setTimeout(r, 200));
  }
  console.log(`OK: room contains ${JSON.stringify(expect)}`);
}
provider.destroy();
process.exit(0);
