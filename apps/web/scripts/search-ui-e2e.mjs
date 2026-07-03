// Search-palette + Shared-with-me data layer e2e: drives the EXACT functions the
// UI uses (src/workspaceApi.ts search() + owner/is_owner on listDocuments, imported
// directly — node 22 strips types) against a live muesli-server.
//
// Starts its OWN server on :8792 with its OWN scratch database (e2e convention:
// 8790+ so the dev server on :8787 is never disturbed; :8791 is search-e2e's), and
// the server's cwd OUTSIDE the repo so dotenvy never picks up the repo .env. Auth
// is a delegated agent token per user (dex password grant → /api/cli/login) for
// dev@muesli.md (A) and friend@muesli.md (B). The DB is DROPPED + recreated each
// run: the shared-with-me checks assume B starts WITHOUT a membership in A's
// workspace, and memberships are not run-stamped.
//
//   1. A creates two docs over ws (title hit + content hit), titles via PATCH
//   2. api.search(): title match instant; content match lands after the indexer's
//      ~2s debounce (polled); result shape (source, owner, is_owner, match, ranking)
//   3. limit option clamps; empty/whitespace q → {results:[]}
//   4. AbortController: an aborted search() rejects (stale-request cancellation)
//   5. listDocuments(): owner/is_owner present; A owns its docs
//   6. invite B → B's listDocuments: shared set = filter(is_owner === false) with
//      owner = A (exactly what Home's '~shared' view renders); B's search sees the
//      docs with is_owner:false
//   7. trash: trashed doc leaves both B's shared listing and search
// Usage: node search-ui-e2e.mjs   (run `cargo build --workspace` first; dex +
// postgres + redis from docker-compose must be up)
import { spawn, execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import WebSocket from "ws";
import { createWorkspaceApi } from "../src/workspaceApi.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const SERVER_BIN = join(repoRoot, "target", "debug", "muesli-server");
const SERVER = "http://localhost:8792";
const WS_URL = "ws://localhost:8792/ws";
const DEX = "http://localhost:5556/dex";
const run = Date.now();
const token1 = `qp${run}`; // appears in a title
const token2 = `bowl${run}`; // appears only in content
const slugTitle = `sui-title-${run}`;
const slugBody = `sui-body-${run}`;

let serverProc = null;
const clients = [];
const cleanup = () => {
  for (const c of clients) c.provider.destroy();
  if (serverProc && serverProc.exitCode === null) serverProc.kill("SIGKILL");
};
const fail = (msg) => {
  console.error(`FAIL: ${msg}`);
  cleanup();
  process.exit(1);
};
const ok = (msg) => console.log(`OK: ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
setTimeout(() => fail("global timeout"), 150_000).unref();

// --- prerequisites: port free, fresh scratch database --------------------------------
try {
  await fetch(`${SERVER}/healthz`);
  fail("something is already listening on :8792 — stop it first");
} catch {}
const TEST_DB = "muesli_search_ui_e2e";
function psql(sql) {
  return execFileSync(
    "docker",
    ["compose", "exec", "-T", "postgres", "psql", "-U", "muesli", "-d", "muesli", "-v", "ON_ERROR_STOP=1", "-c", sql],
    { cwd: repoRoot, stdio: "pipe" },
  );
}
try {
  psql(`drop database if exists ${TEST_DB} with (force)`);
  psql(`create database ${TEST_DB}`);
} catch (e) {
  fail(`recreating ${TEST_DB} failed: ${e.stderr}`);
}
ok(`port 8792 free, test database ${TEST_DB} ready`);

// --- server lifecycle (cwd OUTSIDE the repo: dotenvy walks parent dirs) ---------------
serverProc = spawn(SERVER_BIN, [], {
  cwd: tmpdir(),
  env: {
    ...process.env,
    DATABASE_URL: `postgres://muesli:muesli@localhost:5433/${TEST_DB}`,
    REDIS_URL: "redis://localhost:6380",
    OIDC_ISSUER: DEX,
    OIDC_CLIENT_ID: "muesli",
    OIDC_CLIENT_SECRET: "muesli-dev-secret",
    MUESLI_PUBLIC_URL: SERVER,
    MUESLI_WEB_ORIGIN: "http://localhost:5173",
    MUESLI_LISTEN: "127.0.0.1:8792",
    RUST_LOG: "muesli_server=info",
  },
  stdio: ["ignore", "ignore", "pipe"],
});
{
  let stderrTail = "";
  serverProc.stderr.on("data", (c) => (stderrTail = (stderrTail + c.toString()).slice(-4000)));
  let up = false;
  for (let i = 0; i < 100 && !up; i++) {
    await sleep(100);
    if (serverProc.exitCode !== null) fail(`server exited ${serverProc.exitCode}: ${stderrTail}`);
    try {
      up = (await fetch(`${SERVER}/healthz`)).ok;
    } catch {}
  }
  if (!up) fail(`server did not come up: ${stderrTail}`);
}
ok("server up on :8792 (OIDC mode)");

// --- delegated agent tokens for both users --------------------------------------------
async function mintToken(email) {
  const res = await fetch(`${DEX}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "password",
      client_id: "muesli-cli",
      scope: "openid email profile",
      username: email,
      password: "password",
    }),
  });
  const body = await res.json();
  if (!body.id_token) fail(`dex password grant for ${email} returned no id_token`);
  const login = await fetch(`${SERVER}/api/cli/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id_token: body.id_token, label: `search-ui-e2e-${email}` }),
  });
  if (!login.ok) fail(`/api/cli/login for ${email} → ${login.status} ${await login.text()}`);
  const { token } = await login.json();
  if (!token?.startsWith("mua_")) fail(`expected a mua_ token for ${email}, got ${token}`);
  return token;
}
const tokenA = await mintToken("dev@muesli.md");
const tokenB = await mintToken("friend@muesli.md");

// The EXACT api objects Home.svelte / SearchPalette.svelte build, with a
// Bearer-injecting fetch (the browser uses the session cookie instead).
function makeApi(token) {
  return createWorkspaceApi({
    httpBase: SERVER,
    fetchFn: (input, init = {}) =>
      fetch(input, {
        ...init,
        headers: { ...(init.headers ?? {}), authorization: `Bearer ${token}` },
      }),
  });
}
const apiA = makeApi(tokenA);
const apiB = makeApi(tokenB);
ok("minted delegated agent tokens for users A and B");

let wsA, userIdA;
{
  const r = await apiA.listWorkspaces();
  wsA = r.workspaces.find((w) => w.is_personal)?.id;
  if (!wsA) fail("A has no personal workspace");
  const detail = await apiA.getWorkspace(wsA);
  userIdA = detail.members.find((m) => m.kind === "human")?.user_id;
  if (!userIdA) fail("no human member in A's workspace");
}

// --- 1. docs over ws + titles -----------------------------------------------------------
function connect(roomSlug, token) {
  class BearerWS extends WebSocket {
    constructor(url, protocols) {
      super(url, protocols, { headers: { authorization: `Bearer ${token}` } });
    }
  }
  const doc = new Y.Doc();
  const provider = new WebsocketProvider(WS_URL, roomSlug, doc, {
    WebSocketPolyfill: BearerWS,
    disableBc: true, // same-process clients must not bypass the server over BroadcastChannel
  });
  const synced = new Promise((resolve) => provider.on("sync", (s) => s && resolve()));
  return { doc, provider, text: doc.getText("content"), synced };
}
async function createDoc(slug, token, content) {
  const c = connect(slug, token);
  clients.push(c);
  await c.synced;
  c.text.insert(0, content);
}
await createDoc(slugTitle, tokenA, `# Title Hit\n\nplain body, nothing of note.\n`);
await createDoc(
  slugBody,
  tokenA,
  `# Body Hit\n\nA paragraph that mentions the ${token2} exactly once, mid-sentence.\n`,
);
await sleep(300);
{
  const r = await apiA.updateDocument(slugTitle, { title: `${token1} Handbook` });
  if (r.title !== `${token1} Handbook`) fail(`title PATCH echoed wrong: ${JSON.stringify(r)}`);
}
ok("A created 2 docs over ws and titled one");

// --- 2. api.search(): title instant, content after the debounce; shape ------------------
{
  const r = await apiA.search(token1);
  if (r.results.length !== 1 || r.results[0].slug !== slugTitle)
    fail(`title search should hit immediately: ${JSON.stringify(r.results)}`);
  const hit = r.results[0];
  if (hit.match.field !== "title" || hit.match.snippet !== `${token1} Handbook`)
    fail(`title match shape wrong: ${JSON.stringify(hit.match)}`);
  if (hit.source.kind !== "native" || hit.source.label !== "Muesli Cloud")
    fail(`source should be native/Muesli Cloud: ${JSON.stringify(hit.source)}`);
  if (hit.is_owner !== true || hit.owner?.id !== userIdA)
    fail(`A owns the doc: ${JSON.stringify({ is_owner: hit.is_owner, owner: hit.owner })}`);
  if (hit.workspace_id !== wsA || hit.folder_id !== null || !hit.updated_at || !hit.document_id)
    fail(`row shape wrong: ${JSON.stringify(hit)}`);

  // content projection rides the link indexer's ~2s debounce: poll
  let body;
  for (let i = 0; i < 30; i++) {
    const c = await apiA.search(token2);
    body = c.results.find((x) => x.slug === slugBody);
    if (body) break;
    await sleep(500);
  }
  if (!body) fail("content search never matched (projection missing?)");
  if (body.match.field !== "content" || !body.match.snippet.includes(token2))
    fail(`content match shape wrong: ${JSON.stringify(body.match)}`);
  ok("search(): title hit instant, content hit after debounce, full result shape");
}

// --- 3. limit + empty q -------------------------------------------------------------------
{
  // both docs contain "Hit" (title vs body content); limit must clamp the list
  let both;
  for (let i = 0; i < 20; i++) {
    both = await apiA.search("Hit");
    if (both.results.length === 2) break;
    await sleep(500);
  }
  if (both.results.length !== 2) fail(`expected 2 hits for "Hit": ${JSON.stringify(both.results)}`);
  if (both.results[0].slug !== slugTitle)
    fail(`title tier must outrank content tier: ${JSON.stringify(both.results.map((r) => r.slug))}`);
  const one = await apiA.search("Hit", { limit: 1 });
  if (one.results.length !== 1) fail(`limit:1 should cap results: ${JSON.stringify(one.results)}`);
  const empty = await apiA.search("   ");
  if (empty.results.length !== 0) fail(`whitespace q should be empty: ${JSON.stringify(empty)}`);
  ok("limit option caps results (title tier first); whitespace q → []");
}

// --- 4. AbortController cancellation --------------------------------------------------------
{
  const ac = new AbortController();
  const p = apiA.search(token1, { signal: ac.signal });
  ac.abort();
  let aborted = false;
  try {
    await p;
  } catch (e) {
    aborted = e?.name === "AbortError" || `${e}`.includes("abort");
  }
  if (!aborted) fail("aborted search() should reject with an AbortError");
  ok("search() honors AbortSignal (stale-request cancellation)");
}

// --- 5. listDocuments owner fields ----------------------------------------------------------
{
  const r = await apiA.listDocuments();
  for (const slug of [slugTitle, slugBody]) {
    const d = r.documents.find((x) => x.slug === slug);
    if (!d) fail(`${slug} missing from A's listing`);
    if (d.is_owner !== true || d.owner?.id !== userIdA)
      fail(`A's listing must mark its docs owned: ${JSON.stringify(d)}`);
  }
  ok("listDocuments(): owner/is_owner present, A owns its docs");
}

// --- 6. invite B → shared-with-me set ---------------------------------------------------------
{
  const before = await apiB.listDocuments();
  if (before.documents.some((d) => d.slug === slugTitle))
    fail("B sees A's docs before the invite");

  const inv = await apiA.createInvite(wsA, "friend@muesli.md", "member");
  if (inv.status !== "added") fail(`existing user should be added immediately: ${JSON.stringify(inv)}`);

  const after = await apiB.listDocuments();
  // Exactly what Home's '~shared' view computes:
  const shared = after.documents.filter((d) => d.is_owner === false);
  for (const slug of [slugTitle, slugBody]) {
    const d = shared.find((x) => x.slug === slug);
    if (!d) fail(`${slug} missing from B's shared-with-me set: ${JSON.stringify(shared)}`);
    if (d.owner?.id !== userIdA) fail(`shared doc owner should be A: ${JSON.stringify(d.owner)}`);
    if (typeof d.owner?.display_name === "undefined")
      fail(`owner missing display_name: ${JSON.stringify(d.owner)}`);
  }
  const s = await apiB.search(token1);
  if (s.results.length !== 1 || s.results[0].is_owner !== false || s.results[0].owner?.id !== userIdA)
    fail(`B's search should mark A's doc shared: ${JSON.stringify(s.results)}`);
  ok("after invite: B's shared-with-me set (is_owner === false) holds A's docs with owner = A");
}

// --- 7. trash removes from shared listing and search ------------------------------------------
{
  await apiA.trashDocument(slugTitle);
  const list = await apiB.listDocuments();
  if (list.documents.some((d) => d.slug === slugTitle))
    fail("trashed doc still in B's listing");
  const s = await apiB.search(token1);
  if (s.results.length !== 0) fail(`trashed doc still in B's search: ${JSON.stringify(s.results)}`);
  ok("trashed doc left both the shared listing and search");
}

console.log("ALL SEARCH-UI + SHARED-WITH-ME CHECKS PASSED");
cleanup();
process.exit(0);
