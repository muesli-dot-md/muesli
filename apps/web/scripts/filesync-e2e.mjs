// End-to-end test of the Phase 1 wedge: `muesli open <file>` bridging disk ↔ room.
// Usage: node filesync-e2e.mjs <file> <room>   (run with the server AND the CLI already up)
// Verifies, in order:
//   1. the CLI seeded the room from the file (disk → room)
//   2. a web edit materializes back into the file (room → disk)
//   3. an external append to the file is ingested into the room (disk → room, out-of-band)
import { readFile, appendFile } from "node:fs/promises";
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import WebSocket from "ws";

const [file, room] = process.argv.slice(2);
const WS_URL = process.env.MUESLI_WS ?? "ws://localhost:8787/ws";
const deadline = Date.now() + 20_000;

const doc = new Y.Doc();
const provider = new WebsocketProvider(WS_URL, room, doc, { WebSocketPolyfill: WebSocket });
const text = doc.getText("content");

async function until(desc, fn) {
  while (Date.now() < deadline) {
    if (await fn()) {
      console.log(`OK: ${desc}`);
      return;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  console.error(`FAIL (timeout): ${desc}`);
  console.error("room text:", JSON.stringify(text.toString()));
  console.error(
    "file text:",
    JSON.stringify(await readFile(file, "utf8").catch(() => "<unreadable>")),
  );
  process.exit(1);
}

// 1. disk → room: CLI seeds the room from the file.
await until("room contains the file's original content", () =>
  text.toString().includes("Hello from disk"),
);

// 2. room → disk: a web-client edit must be materialized into the file by the CLI.
text.insert(text.length, "\nWEB-EDIT: typed in the browser\n");
await until("web edit materialized to the file", async () =>
  (await readFile(file, "utf8")).includes("WEB-EDIT"),
);

// 3. disk → room: an external append (any process) must be ingested.
await appendFile(file, "\nDISK-EDIT: appended by an external process\n");
await until("external disk edit ingested into the room", () =>
  text.toString().includes("DISK-EDIT"),
);

// Sanity: room and file converge to the same text.
await until(
  "room text == file text",
  async () => (await readFile(file, "utf8")) === text.toString(),
);

console.log("PASS: full disk ↔ room round-trip");
provider.destroy();
process.exit(0);
