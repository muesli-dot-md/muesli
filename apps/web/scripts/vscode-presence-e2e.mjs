// Headless e2e for the VS Code presence core (integrations/vscode/src/core.ts).
//
// Starts muesli-server in OPEN mode on its own port, then:
//   client A = PresenceSession (the extension's core, imported via node type
//              stripping — node >= 22.18 strips .ts type annotations natively)
//   client B = a plain y-websocket client, wired exactly like the web app.
//
// Asserts (each within 2s):
//   1. B sees A's awareness (kind "vscode", name).
//   2. A.participants() decodes B's y-codemirror-format cursor to absolute
//      UTF-16 offsets (the text includes an astral-plane emoji to prove it).
//   3. A.setCursor round-trips to B's view of A.
//   4. Text edits from B reach A's session (read-only sync; A never writes).
//
// Exits nonzero on any failure. Kills the server either way.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import WebSocket from "ws";

import { PresenceSession } from "../../../integrations/vscode/src/core.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const SERVER_BIN = path.join(ROOT, "target", "debug", "muesli-server");
const PORT = Number(process.env.MUESLI_E2E_PORT ?? 8793);
const HTTP = `http://127.0.0.1:${PORT}`;
const WS_URL = `ws://127.0.0.1:${PORT}/ws`;
const room = `vscode-presence-e2e-${process.pid}`;

const failures = [];
let server;

function fail(msg) {
  failures.push(msg);
  console.error(`FAIL: ${msg}`);
}

function ok(msg) {
  console.log(`ok: ${msg}`);
}

/** Poll `cond` until truthy or `ms` elapses; resolves the truthy value or null. */
function waitFor(cond, ms = 2000, step = 25) {
  return new Promise((resolve) => {
    const deadline = Date.now() + ms;
    const tick = () => {
      let v;
      try {
        v = cond();
      } catch {
        v = null;
      }
      if (v) return resolve(v);
      if (Date.now() > deadline) return resolve(null);
      setTimeout(tick, step);
    };
    tick();
  });
}

async function startServer() {
  if (!existsSync(SERVER_BIN)) {
    console.log("muesli-server binary missing — building (cargo build -p muesli-server)…");
    await new Promise((resolve, reject) => {
      const b = spawn("cargo", ["build", "-p", "muesli-server"], { cwd: ROOT, stdio: "inherit" });
      b.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`cargo build exited ${code}`))));
    });
  }
  // OPEN mode: no OIDC_ISSUER / DATABASE_URL in the child env.
  const env = { ...process.env };
  delete env.OIDC_ISSUER;
  delete env.DATABASE_URL;
  env.MUESLI_LISTEN = `127.0.0.1:${PORT}`;
  server = spawn(SERVER_BIN, [], { env, stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  server.stderr.on("data", (d) => (stderr += d));
  server.on("exit", (code) => {
    if (!shuttingDown) {
      console.error(`muesli-server exited early (code ${code})\n${stderr}`);
      process.exit(1);
    }
  });
  const deadline = Date.now() + 10_000;
  let healthy = false;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${HTTP}/healthz`)).ok) {
        healthy = true;
        break;
      }
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!healthy) throw new Error(`server did not become healthy on ${HTTP}\n${stderr}`);
  console.log(`muesli-server up on ${HTTP} (open mode), room=${room}`);
}

let shuttingDown = false;
function stopServer() {
  shuttingDown = true;
  if (server && server.exitCode == null) server.kill("SIGTERM");
}

// --- Client B: plain y-websocket client, like apps/web/src/collab.ts. -------
function makeClientB() {
  const doc = new Y.Doc();
  const provider = new WebsocketProvider(WS_URL, room, doc, {
    WebSocketPolyfill: WebSocket,
    disableBc: true,
  });
  provider.awareness.setLocalStateField("user", {
    name: "Berry 42",
    color: "#10b981",
    colorLight: "#10b98133",
    kind: "human",
  });
  const synced = new Promise((resolve) => provider.on("sync", (s) => s && resolve()));
  return { doc, provider, synced, text: doc.getText("content") };
}

try {
  await startServer();

  // Client A — the extension core.
  const a = new PresenceSession(WS_URL, room, { name: "Ada (vscode)", color: "#3b82f6" });
  const b = makeClientB();

  await Promise.race([
    Promise.all([a.whenSynced, b.synced]),
    new Promise((_, rej) => setTimeout(() => rej(new Error("initial sync timed out (5s)")), 5000)),
  ]);
  ok("both clients synced with the room");

  // ── 1. B sees A's awareness (kind vscode, name) within 2s ────────────────
  const seenA = await waitFor(() => {
    for (const [id, state] of b.provider.awareness.getStates()) {
      if (id !== b.provider.awareness.clientID && state.user?.kind === "vscode") return state.user;
    }
    return null;
  });
  if (seenA && seenA.name === "Ada (vscode)") {
    ok(`B sees A's awareness: kind=${seenA.kind} name=${JSON.stringify(seenA.name)}`);
  } else {
    fail(`B did not see A's vscode awareness within 2s (got ${JSON.stringify(seenA)})`);
  }

  // ── 2. A decodes B's y-codemirror-format cursor ───────────────────────────
  // "a😀b…" — the emoji is two UTF-16 code units, so offset 4 ≠ codepoint 4.
  const TEXT = "a😀b line one\nline two";
  b.text.insert(0, TEXT);
  await waitFor(() => a.text() === TEXT);
  if (a.text() !== TEXT) fail(`A did not receive B's text (A sees ${JSON.stringify(a.text())})`);

  const B_ANCHOR = 4; // after "a😀b" (1 + 2 + 1 UTF-16 units)
  const B_HEAD = 8;
  // Exactly what y-codemirror.next does (y-remote-selections.js:170): the
  // awareness "cursor" field with relative positions for anchor/head.
  b.provider.awareness.setLocalStateField("cursor", {
    anchor: Y.createRelativePositionFromTypeIndex(b.text, B_ANCHOR),
    head: Y.createRelativePositionFromTypeIndex(b.text, B_HEAD),
  });
  const bSeen = await waitFor(() => {
    const p = a.participants().find((p) => p.kind === "human");
    return p && p.cursor ? p : null;
  });
  if (bSeen && bSeen.cursor.anchor === B_ANCHOR && bSeen.cursor.head === B_HEAD && bSeen.name === "Berry 42") {
    ok(`A decoded B's cursor: name=${JSON.stringify(bSeen.name)} anchor=${bSeen.cursor.anchor} head=${bSeen.cursor.head} (UTF-16 offsets)`);
  } else {
    fail(`A did not decode B's cursor {anchor:${B_ANCHOR}, head:${B_HEAD}} (got ${JSON.stringify(bSeen)})`);
  }

  // ── 3. A.setCursor round-trips to B's view of A ───────────────────────────
  const A_ANCHOR = 2;
  const A_HEAD = 7;
  a.setCursor(A_ANCHOR, A_HEAD);
  const aCursorAtB = await waitFor(() => {
    for (const [id, state] of b.provider.awareness.getStates()) {
      if (id === b.provider.awareness.clientID || state.user?.kind !== "vscode") continue;
      const c = state.cursor;
      if (!c?.anchor || !c?.head) continue;
      const anchor = Y.createAbsolutePositionFromRelativePosition(
        Y.createRelativePositionFromJSON(c.anchor),
        b.doc,
      );
      const head = Y.createAbsolutePositionFromRelativePosition(Y.createRelativePositionFromJSON(c.head), b.doc);
      if (anchor && head && anchor.type === b.text && head.type === b.text) {
        return { anchor: anchor.index, head: head.index };
      }
    }
    return null;
  });
  if (aCursorAtB && aCursorAtB.anchor === A_ANCHOR && aCursorAtB.head === A_HEAD) {
    ok(`A.setCursor(${A_ANCHOR}, ${A_HEAD}) round-tripped to B: ${JSON.stringify(aCursorAtB)}`);
  } else {
    fail(`A's cursor did not round-trip to B (expected {anchor:${A_ANCHOR}, head:${A_HEAD}}, got ${JSON.stringify(aCursorAtB)})`);
  }

  // ── 4. B's edits reach A's read-only session ──────────────────────────────
  b.text.insert(b.text.length, "\nbeta appended this");
  const sawEdit = await waitFor(() => a.text().endsWith("beta appended this"));
  if (sawEdit) {
    ok("ydoc text change from B is visible to A's session (read-only sync)");
  } else {
    fail(`A did not see B's edit (A sees ${JSON.stringify(a.text())})`);
  }

  a.destroy();
  b.provider.destroy();
} catch (e) {
  fail(e?.message ?? String(e));
} finally {
  stopServer();
}

if (failures.length > 0) {
  console.error(`\n${failures.length} assertion(s) failed.`);
  process.exit(1);
}
console.log("\nAll vscode-presence e2e assertions passed.");
process.exit(0);
