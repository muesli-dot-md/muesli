// Integration test for the collaboration UI's data layer: drives the EXACT
// functions the sidebar components use (src/collabApi.ts + src/offsets.ts,
// imported directly — node 22 strips types) against a live server, over a doc
// full of non-ASCII text, so every UTF-8-byte <-> UTF-16 conversion is
// exercised the same way the UI exercises it.
//
//   node scripts/ui-flows-e2e.mjs [room]
//
// Spawns its OWN muesli-server on :8790 in OPEN mode unless MUESLI_HTTP is set
// (export MUESLI_HTTP/MUESLI_WS to target an already-running server instead).
// Flow: comment from a UTF-16 selection (range round-trip onto the right
// text), reply/resolve, single suggestion accept, 2-edit change-set accept,
// conflict 409, history list + before_seq paging + point-in-time read.
import { spawn } from "node:child_process";
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import WebSocket from "ws";
import { createCollabApi, ApiError } from "../src/collabApi.ts";
import { byteRangeToUtf16, utf16RangeToByte } from "../../../packages/editor-core/src/offsets.ts";

const OWN_SERVER = !process.env.MUESLI_HTTP;
const SERVER = process.env.MUESLI_HTTP ?? "http://127.0.0.1:8790";
const WS_URL = process.env.MUESLI_WS ?? "ws://localhost:8790/ws";
const BINARY = new URL("../../../target/debug/muesli-server", import.meta.url).pathname;
const room = process.argv[2] ?? `ui-flows-${Date.now()}`;

let serverProc = null;
const cleanup = () => {
  if (serverProc && serverProc.exitCode === null) serverProc.kill("SIGTERM");
};
process.on("exit", cleanup);

const fail = (msg) => {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
};
const ok = (msg) => console.log(`OK: ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
setTimeout(() => fail("global timeout"), 90_000).unref();

// --- 0. our own server on :8790, OPEN mode (no OIDC env) ----------------------
if (OWN_SERVER) {
  serverProc = spawn(BINARY, [], {
    env: {
      PATH: process.env.PATH,
      DATABASE_URL: process.env.DATABASE_URL ?? "postgres://muesli:muesli@localhost:5433/muesli",
      MUESLI_LISTEN: "127.0.0.1:8790",
      RUST_LOG: "warn",
    },
    stdio: ["ignore", "inherit", "inherit"],
  });
  serverProc.on("exit", (code, signal) => {
    if (code !== null && code !== 0) fail(`server exited early (code ${code}, signal ${signal})`);
  });
  let up = false;
  for (let i = 0; i < 100 && !up; i++) {
    await sleep(150);
    up = await fetch(`${SERVER}/api/me`).then(
      (r) => r.ok,
      () => false,
    );
  }
  if (!up) fail("server on :8790 did not become ready");
  ok("own server up on :8790 (open mode)");
}

// --- 1. the same API instance shape the UI builds in collabStore --------------
const api = createCollabApi({ httpBase: SERVER, docSlug: room });

// --- 2. a live ws client typing non-ASCII text ---------------------------------
const ydoc = new Y.Doc();
const provider = new WebsocketProvider(WS_URL, room, ydoc, {
  WebSocketPolyfill: WebSocket,
  disableBc: true,
});
const ytext = ydoc.getText("content");
await new Promise((resolve) => provider.on("sync", (s) => s && resolve()));

// Regression context: anchors at byte offsets beyond the doc's UTF-16 length used to
// fail to resolve (yrs sticky indices mix clock/byte units under OffsetKind::Bytes;
// muesli-core now runs the doc UTF-16 internally and converts at the byte-API boundary).
// The tail below pushes anchored ranges' byte offsets past the UTF-16 length so this
// suite keeps exercising exactly that path.
const ASCII_TAIL =
  "\nThis plain ascii tail keeps the document longer in bytes than in UTF-16 units,\n" +
  "pinning the sticky-index regression fixed in muesli-core.\n";
const BASE_TEXT =
  "# Grüße ☕\n\nHällo wörld 👩‍👩‍👧‍👦 — emoji test.\nKeep this line intact.\n" + ASCII_TAIL;
ytext.insert(0, BASE_TEXT);
await sleep(400);
{
  const live = await api.getText();
  if (live.text !== BASE_TEXT) fail(`live text mismatch: ${JSON.stringify(live.text)}`);
  ok("doc created over ws with umlauts + emoji, GET text agrees");
}

// --- 3. comment from a UTF-16 selection: byte round-trip lands on the text ------
// Simulates exactly what the UI does: CodeMirror gives a UTF-16 selection,
// collabStore converts with utf16RangeToByte, POSTs, then on refetch converts
// the thread's byte range back with byteRangeToUtf16 for the decoration.
{
  const target = "wörld";
  const from = BASE_TEXT.indexOf(target);
  const selection = { from, to: from + target.length };
  const { start, end } = utf16RangeToByte(BASE_TEXT, selection);
  if (end - start !== 6) fail(`'wörld' should be 6 UTF-8 bytes, got ${end - start}`);
  const created = await api.createComment(start, end, "is this wörld 🌍 enough?");
  if (!created.thread_id) fail("createComment returned no thread_id");

  const { threads } = await api.getComments();
  if (threads.length !== 1) fail(`expected 1 thread, got ${threads.length}`);
  const t = threads[0];
  if (t.status !== "open") fail(`expected open, got ${t.status}`);
  const live = (await api.getText()).text;
  const cm = byteRangeToUtf16(live, t.range);
  const anchored = live.slice(cm.from, cm.to);
  if (anchored !== target)
    fail(`comment range decoded to ${JSON.stringify(anchored)}, want ${JSON.stringify(target)}`);
  if (cm.from !== selection.from || cm.to !== selection.to)
    fail(`UTF-16 round trip drifted: ${cm.from}..${cm.to} vs ${selection.from}..${selection.to}`);
  ok(
    `comment anchored over ${JSON.stringify(target)}; byte range round-trips to the same UTF-16 selection`,
  );

  // reply + resolve + reopen (the thread card actions)
  await api.replyToThread(t.id, "ja, sehr wörldlich");
  await api.resolveThread(t.id);
  let after = (await api.getComments()).threads[0];
  if (after.status !== "resolved" || after.comments.length !== 2)
    fail(`expected resolved thread with 2 comments, got ${after.status}/${after.comments.length}`);
  await api.reopenThread(t.id);
  after = (await api.getComments()).threads[0];
  if (after.status !== "open") fail("reopen failed");
  ok("reply / resolve / reopen flow works");
}

// --- 4. single suggestion: create (suggest-mode submit), accept ------------------
let preAcceptSeq, preAcceptText;
{
  preAcceptText = (await api.getText()).text;
  preAcceptSeq = (await api.getText()).seq;
  const target = "Hällo";
  const from = preAcceptText.indexOf(target);
  const bytes = utf16RangeToByte(preAcceptText, { from, to: from + target.length });
  const created = await api.createSuggestion(
    [{ start: bytes.start, end: bytes.end, insert: "Hello 🌍" }],
    "anglify",
  );
  if (!created.change_set_id) fail("createSuggestion returned no change_set_id");

  const { suggestions } = await api.getSuggestions("pending");
  if (suggestions.length !== 1) fail(`expected 1 pending, got ${suggestions.length}`);
  const s = suggestions[0];
  if (s.op.old_text !== target)
    fail(`old_text should be ${JSON.stringify(target)}, got ${JSON.stringify(s.op.old_text)}`);
  if (s.note !== "anglify") fail("note not stored");
  // decoration math: the deletion range must cover exactly "Hällo" in UTF-16
  const cm = byteRangeToUtf16(preAcceptText, s.range);
  if (preAcceptText.slice(cm.from, cm.to) !== target) fail("suggestion range decodes wrong");
  if ((await api.getText()).text !== preAcceptText) fail("pending suggestion touched the doc!");
  ok("pending suggestion over non-ASCII text decodes to the right UTF-16 range, doc untouched");

  await api.acceptSuggestion(s.id);
  await sleep(400);
  const expected = preAcceptText.replace("Hällo", "Hello 🌍");
  if (ytext.toString() !== expected)
    fail(`accept applied at the wrong place: ${JSON.stringify(ytext.toString())}`);
  if ((await api.getSuggestions("pending")).suggestions.length !== 0)
    fail("suggestion still pending after accept");
  ok("single suggestion accepted; ws client saw it live");
}

// --- 5. a 2-edit change set accepted atomically (the multi-edit card path) --------
{
  const text = (await api.getText()).text;
  const kFrom = text.indexOf("Keep");
  const iFrom = text.indexOf("intact");
  const e1 = utf16RangeToByte(text, { from: kFrom, to: kFrom + 4 });
  const e2 = utf16RangeToByte(text, { from: iFrom, to: iFrom + 6 });
  const created = await api.createSuggestion(
    [
      { start: e1.start, end: e1.end, insert: "KEEP ✅" },
      { start: e2.start, end: e2.end, insert: "unversehrt" },
    ],
    "louder + deutscher",
  );
  const res = await api.acceptChangeSet(created.change_set_id);
  if (res.accepted?.length !== 2 || res.conflicts?.length !== 0)
    fail(`expected 2 accepted / 0 conflicts, got ${JSON.stringify(res)}`);
  await sleep(400);
  const now = ytext.toString();
  const expected = text.replace("Keep", "KEEP ✅").replace("intact", "unversehrt");
  if (now !== expected) fail(`change set applied wrong: ${JSON.stringify(now)}`);
  ok("2-edit change set accepted atomically with emoji insert");
}

// --- 6. conflict path: accept after the anchored text is gone → 409 ----------------
{
  const text = ytext.toString();
  const from = text.indexOf("unversehrt");
  const bytes = utf16RangeToByte(text, { from, to: from + "unversehrt".length });
  const created = await api.createSuggestion([{ start: bytes.start, end: bytes.end, insert: "?" }]);
  const { suggestions } = await api.getSuggestions("pending");
  const doomed = suggestions.find((s) => s.change_set_id === created.change_set_id);
  ytext.delete(from, "unversehrt".length);
  await sleep(400);
  try {
    await api.acceptSuggestion(doomed.id);
    fail("expected 409 conflict accepting a suggestion on deleted text");
  } catch (e) {
    if (!(e instanceof ApiError) || e.status !== 409)
      fail(`expected ApiError 409, got ${e?.status ?? e}`);
    ok(`conflicting accept surfaced as ApiError 409 (${e.bodyText.trim()})`);
  }
  await api.rejectSuggestion(doomed.id); // tidy: the card's Reject action
}

// --- 7. history list, before_seq paging, point-in-time read -------------------------
{
  const { entries } = await api.getHistory({ limit: 100 });
  if (!entries?.length) fail("history is empty");
  for (let i = 1; i < entries.length; i++) {
    if (entries[i].first_seq >= entries[i - 1].first_seq) fail("history not newest-first");
  }
  // paging exactly as HistoryPanel's "Load more": before_seq = oldest first_seq
  const page1 = (await api.getHistory({ limit: 1 })).entries;
  if (page1.length !== 1) fail("limit=1 page wrong");
  if (entries.length > 1) {
    const page2 = (await api.getHistory({ limit: 1, beforeSeq: page1[0].first_seq })).entries;
    if (page2.length !== 1 || page2[0].first_seq >= page1[0].first_seq)
      fail("before_seq paging did not return an older entry");
  }
  ok(`history: ${entries.length} coalesced entries, newest-first, before_seq pages older`);

  const snap = await api.getText(preAcceptSeq);
  if (snap.text !== preAcceptText)
    fail(`text?seq=${preAcceptSeq} is not the pre-accept text: ${JSON.stringify(snap.text)}`);
  if (snap.seq !== preAcceptSeq) fail("snapshot seq mismatch");
  ok(`text?seq=${preAcceptSeq} time-travels to the pre-accept text (snapshot modal path)`);
}

console.log("ALL UI FLOW CHECKS PASSED");
provider.destroy();
cleanup();
process.exit(0);
