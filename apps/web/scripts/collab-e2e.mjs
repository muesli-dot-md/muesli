// Collaboration-depth e2e (ADR 0019/0007): drives the OIDC login dance, then exercises the
// Phase 2 REST surface against a live room:
//   1. comments anchor to a span and ride along as text changes before them
//   2. deleting the anchored text orphans the comment (lazily, on GET)
//   3. pending suggestions never touch the doc; accepting a change set applies all edits
//      atomically, attributed to the suggestion author, and live ws clients see it
//   4. accepting a suggestion whose text was deleted is a 409 conflict
//   5. history is coalesced + attributed; text?seq= time-travels
// Usage: node collab-e2e.mjs <room>   (server must run in OIDC mode, see .env.example)
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import WebSocket from "ws";

const SERVER = process.env.MUESLI_HTTP ?? "http://localhost:8787";
const WS_URL = process.env.MUESLI_WS ?? "ws://localhost:8787/ws";
const room = process.argv[2] ?? `collab-e2e-${Date.now()}`;

const fail = (msg) => {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
};
const ok = (msg) => console.log(`OK: ${msg}`);
setTimeout(() => fail("global timeout"), 60_000).unref();

// --- tiny cookie jar (per host) + manual redirect follower (as auth-e2e.mjs) -
const jar = new Map(); // host -> Map(name -> value)
function storeCookies(url, res) {
  const host = new URL(url).host;
  for (const line of res.headers.getSetCookie?.() ?? []) {
    const [pair] = line.split(";");
    const eq = pair.indexOf("=");
    if (!jar.has(host)) jar.set(host, new Map());
    jar.get(host).set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
}
function cookieHeader(url) {
  const host = new URL(url).host;
  const m = jar.get(host);
  return m ? [...m].map(([k, v]) => `${k}=${v}`).join("; ") : "";
}
async function request(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    redirect: "manual",
    headers: { ...(opts.headers ?? {}), cookie: cookieHeader(url) },
  });
  storeCookies(url, res);
  return res;
}
async function follow(url, opts = {}) {
  let res = await request(url, opts);
  let hops = 0;
  while ([301, 302, 303, 307].includes(res.status)) {
    if (++hops > 10) fail("redirect loop");
    url = new URL(res.headers.get("location"), url).toString();
    res = await request(url);
  }
  return { res, url };
}

// --- 1. the OIDC dance -------------------------------------------------------
{
  const { res, url } = await follow(
    `${SERVER}/auth/login?next=${encodeURIComponent("http://localhost:5173/#" + room)}`,
  );
  if (!res.ok) fail(`login chain ended ${res.status} at ${url}`);
  const { res: afterLogin, url: finalUrl } = await follow(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ login: "dev@muesli.md", password: "password" }),
  });
  if (!afterLogin.ok) fail(`login POST chain ended ${afterLogin.status} at ${finalUrl}`);
  if (!jar.get(new URL(SERVER).host)?.get("muesli_session")) fail("no session cookie");
  ok("oidc login completed");
}
const sessionCookie = `muesli_session=${jar.get(new URL(SERVER).host).get("muesli_session")}`;

// --- REST + ws helpers --------------------------------------------------------
const base = `${SERVER}/api/documents/${room}`;
async function api(path, { method = "GET", body } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      cookie: sessionCookie,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, text };
}
async function must(path, opts, what) {
  const r = await api(path, opts);
  if (r.status !== 200) fail(`${what}: ${opts?.method ?? "GET"} ${path} → ${r.status} ${r.text}`);
  return r.json;
}

class CookieWS extends WebSocket {
  constructor(url, protocols) {
    super(url, protocols, { headers: { cookie: sessionCookie } });
  }
}
const ydoc = new Y.Doc();
const provider = new WebsocketProvider(WS_URL, room, ydoc, {
  WebSocketPolyfill: CookieWS,
  // Same-process clients would otherwise sync over BroadcastChannel, bypassing the server.
  disableBc: true,
});
const ytext = ydoc.getText("content");
await new Promise((resolve) => provider.on("sync", (s) => s && resolve()));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- 2. create the doc & type ---------------------------------------------------
const BASE_TEXT = "# Notes\n\nhello brave world, this stays.\n";
ytext.insert(0, BASE_TEXT);
await sleep(400);
{
  const live = await must("/text", {}, "live text");
  if (live.text !== BASE_TEXT) fail(`live text mismatch: ${JSON.stringify(live.text)}`);
  ok("doc created over ws, GET text agrees");
}

// --- 3. comment anchored to "brave" ---------------------------------------------
const braveStart = BASE_TEXT.indexOf("brave");
const created = await must(
  "/comments",
  {
    method: "POST",
    body: { anchor_start: braveStart, anchor_end: braveStart + 5, body: "is this brave enough?" },
  },
  "create comment",
);
if (!created.thread_id) fail("create comment returned no thread_id");
ok(`comment thread created (${created.thread_id})`);

// --- 4. the comment rides along when text is inserted BEFORE it ------------------
ytext.insert(BASE_TEXT.indexOf("hello"), "well well, ");
await sleep(400);
{
  const { threads } = await must("/comments", {}, "list comments");
  if (threads.length !== 1) fail(`expected 1 thread, got ${threads.length}`);
  const t = threads[0];
  if (t.status !== "open") fail(`expected open thread, got ${t.status}`);
  const text = ytext.toString();
  const anchored = text.slice(t.range.start, t.range.end);
  if (anchored !== "brave") fail(`anchor drifted: now covers ${JSON.stringify(anchored)}`);
  if (t.range.start === braveStart) fail("range did not shift despite an insert before it");
  if (t.comments.length !== 1 || t.comments[0].body !== "is this brave enough?")
    fail("thread comments wrong");
  if (t.comments[0].author?.kind !== "human") fail("comment author should be a human user");
  ok(`comment rode along to ${t.range.start}..${t.range.end}`);
}

// --- 5. deleting the anchored text orphans the comment ----------------------------
{
  const idx = ytext.toString().indexOf("brave ");
  ytext.delete(idx, "brave ".length);
  await sleep(400);
  const { threads } = await must("/comments", {}, "list comments after delete");
  if (threads[0].status !== "orphaned") fail(`expected orphaned comment, got ${threads[0].status}`);
  ok("comment on deleted text is orphaned (and preserved)");
}

// --- 6. a 2-edit suggestion: pending touches nothing -------------------------------
const preText = ytext.toString();
const helloAt = preText.indexOf("hello");
const staysAt = preText.indexOf("stays");
const suggestion = await must(
  "/suggestions",
  {
    method: "POST",
    body: {
      edits: [
        { start: helloAt, end: helloAt + 5, insert: "HELLO" },
        { start: staysAt, end: staysAt + 5, insert: "REMAINS" },
      ],
      note: "shoutier",
    },
  },
  "create suggestion",
);
const changeSet = suggestion.change_set_id;
if (suggestion.suggestion_ids?.length !== 2) fail("expected 2 suggestion rows in the set");
let preAcceptSeq;
{
  const live = await must("/text", {}, "text after suggesting");
  if (live.text !== preText) fail("pending suggestion modified the document!");
  if (ytext.toString() !== preText) fail("pending suggestion reached the ws client!");
  preAcceptSeq = live.seq;
  const { suggestions } = await must("/suggestions?status=pending", {}, "list pending");
  if (suggestions.length !== 2) fail(`expected 2 pending, got ${suggestions.length}`);
  if (suggestions[0].note !== "shoutier") fail("note not stored");
  ok(`2-edit suggestion pending (change set ${changeSet}), doc untouched at seq ${preAcceptSeq}`);
}

// --- 7. accept the change set: atomic, attributed, live ------------------------------
{
  const res = await must(
    `/suggestions/changesets/${changeSet}/accept`,
    { method: "POST" },
    "accept set",
  );
  if (res.accepted?.length !== 2 || res.conflicts?.length !== 0)
    fail(`expected 2 accepted / 0 conflicts, got ${JSON.stringify(res)}`);
  await sleep(400);
  const now = ytext.toString();
  if (!now.includes("HELLO") || !now.includes("REMAINS"))
    fail(`ws client did not see the accepted edits live: ${JSON.stringify(now)}`);
  const live = await must("/text", {}, "text after accept");
  if (live.text !== now) fail("server text and ws client text diverge after accept");
  if (live.seq !== preAcceptSeq + 1)
    fail(`change set should be ONE update: seq ${preAcceptSeq} → ${live.seq}`);
  const { suggestions } = await must("/suggestions?status=accepted", {}, "list accepted");
  if (suggestions.length !== 2) fail("suggestions not marked accepted");
  ok("change set accepted: one atomic update, ws client saw it live");
}

// --- 8. reject another suggestion ------------------------------------------------------
{
  const text = ytext.toString();
  const at = text.indexOf("HELLO");
  const s = await must(
    "/suggestions",
    { method: "POST", body: { edits: [{ start: at, end: at + 5, insert: "goodbye" }] } },
    "create reject-me suggestion",
  );
  const id = s.suggestion_ids[0];
  const r = await must(`/suggestions/${id}/reject`, { method: "POST" }, "reject");
  if (r.status !== "rejected") fail(`expected rejected, got ${JSON.stringify(r)}`);
  if (ytext.toString() !== text) fail("rejected suggestion changed the text!");
  const { suggestions } = await must("/suggestions?status=pending", {}, "pending after reject");
  if (suggestions.length !== 0) fail("rejected suggestion still pending");
  ok("suggestion rejected, text untouched");
}

// --- 9. accepting a suggestion whose anchored text is gone → 409 ------------------------
{
  const text = ytext.toString();
  const at = text.indexOf("REMAINS");
  const s = await must(
    "/suggestions",
    { method: "POST", body: { edits: [{ start: at, end: at + 7, insert: "?" }] } },
    "create doomed suggestion",
  );
  ytext.delete(at, 7); // someone deletes the anchored text first
  await sleep(400);
  const r = await api(`/suggestions/${s.suggestion_ids[0]}/accept`, { method: "POST" });
  if (r.status !== 409) fail(`expected 409 conflict, got ${r.status} ${r.text}`);
  ok(`conflicting accept rejected with 409 (${r.text.trim()})`);
}

// --- 10. history: coalesced + attributed -------------------------------------------------
{
  const { entries } = await must("/history?limit=100", {}, "history");
  if (!entries?.length) fail("history is empty");
  for (const e of entries) {
    if (e.author?.kind !== "human" || !e.author.id) fail(`unattributed entry ${JSON.stringify(e)}`);
    if (e.origin !== "human") fail(`unexpected origin ${e.origin}`);
  }
  const setEntry = entries.find((e) => e.change_set_id === changeSet);
  if (!setEntry) fail("accepted change set missing from history");
  if (setEntry.first_seq !== preAcceptSeq + 1 || setEntry.last_seq !== preAcceptSeq + 1)
    fail(`change set entry spans ${setEntry.first_seq}..${setEntry.last_seq}, expected one update`);
  // typing bursts coalesce: far fewer entries than raw updates
  const raw = (await must(`/text`, {}, "seq probe")).seq;
  if (entries.length >= raw)
    fail(`history not coalesced: ${entries.length} entries for ${raw} updates`);
  ok(`history: ${entries.length} coalesced, attributed entries for ${raw} updates`);
}

// --- 11. time travel ----------------------------------------------------------------------
{
  const r = await must(`/text?seq=${preAcceptSeq}`, {}, "text at seq");
  if (r.text !== preText)
    fail(`text?seq=${preAcceptSeq} is not the pre-accept text: ${JSON.stringify(r.text)}`);
  ok(`text?seq=${preAcceptSeq} returns the pre-accept text`);
}

console.log("ALL COLLAB CHECKS PASSED");
provider.destroy();
process.exit(0);
